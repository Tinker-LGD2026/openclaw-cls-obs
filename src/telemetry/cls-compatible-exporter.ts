// Restores structured CLS fields immediately before OTLP serialization.
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

const STRUCTURED_ATTRIBUTE_KEYS = new Set([
  "gen_ai.input.messages",
  "gen_ai.input.messages_delta",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]);

function decodeStructuredAttributes(span: ReadableSpan): ReadableSpan {
  const original = span.attributes as unknown as Record<string, unknown>;
  let changed = false;
  const attributes: Record<string, unknown> = { ...original };
  for (const key of STRUCTURED_ATTRIBUTE_KEYS) {
    const raw = original[key];
    if (typeof raw !== "string") {
      continue;
    }
    try {
      const decoded: unknown = JSON.parse(raw);
      if (typeof decoded === "object" && decoded !== null) {
        attributes[key] = decoded;
        changed = true;
      }
    } catch {
      // Some tools legitimately return plain text. Keep those values unchanged.
    }
  }
  if (!changed) {
    return span;
  }
  return new Proxy(span, {
    get(target, property, receiver) {
      if (property === "attributes") {
        // OTLP AnyValue supports arrays and kvlists even though the public OTel
        // JS Span API restricts in-process attributes to primitive values.
        return attributes;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Adapts JSON-string attributes into native OTLP AnyValue arrays/kvlists.
 *
 * Span construction remains compliant with the OTel JS API; only the immutable
 * ReadableSpan view passed to the exporter is adapted for CLS's documented JSON
 * field types and UI renderer.
 */
export function createClsCompatibleExporter(delegate: SpanExporter): SpanExporter {
  return {
    export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
      delegate.export(spans.map(decodeStructuredAttributes), callback);
    },
    forceFlush: delegate.forceFlush ? () => delegate.forceFlush?.() ?? Promise.resolve() : undefined,
    shutdown: () => delegate.shutdown(),
  };
}
