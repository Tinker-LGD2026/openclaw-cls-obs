// Shared verification suite: replays captures and validates the CLS output.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Collector } from "../collector.js";
import type { ClsObservabilityConfig, ContentMode } from "../config.js";
import { buildResourceAttributes } from "../telemetry/provider.js";
import type { ObservationEvent } from "../domain/types.js";
import { loadCapture } from "./load-capture.js";
import { toMs, validateSpans } from "./validator.js";

// Captures committed with the repo are the default input so verification runs
// with no setup. `/tmp` was a poor default because it is cleared on reboot.
const DEFAULT_CAPTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/captures",
);

export function resolveCaptureDir(): string {
  return process.env.CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
}

/** Builds an exporter-free config so verification never touches the network. */
export function buildVerifyConfig(contentMode: ContentMode): ClsObservabilityConfig {
  return {
    endpoint: "https://ap-shanghai.cls.tencentcs.com",
    tracesUrl: "https://ap-shanghai.cls.tencentcs.com/v1/traces",
    topicId: "verify-topic",
    authorization: "Basic verify",
    serviceName: "openclaw-gateway",
    serviceVersion: "2026.6.5",
    serviceInstanceId: "verify-instance",
    hostName: "verify-host",
    environment: "verification",
    sampleRate: 1,
    contentMode,
    // Verification exercises the full-content path so truncation and redaction
    // bugs surface here rather than in production.
    systemPromptMode: (process.env.CLS_SYSTEM_PROMPT_MODE as never) ?? "full",
    inputMessagesMode: (process.env.CLS_INPUT_MESSAGES_MODE as never) ?? "delta",
    contentMaxChars: 4_000,
    captureErrorMessages: true,
    identityMode: "hash",
    identityHmacKey: "verification-only-key",
    exportTimeoutMs: 10_000,
    scheduledDelayMs: 5_000,
    maxQueueSize: 2048,
    maxExportBatchSize: 256,
  };
}

const silentLogger = { info: () => {}, warn: () => {} };

/** Feeds one capture through the real collector and returns finished spans. */
export function runEvents(
  events: readonly ObservationEvent[],
  config: ClsObservabilityConfig,
): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes(buildResourceAttributes(config)),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const collector = new Collector(
    config,
    {
      tracer: provider.getTracer("verify"),
      forceFlush: async () => {},
      shutdown: async () => {},
    },
    silentLogger,
  );

  let lastAt = 0;
  for (const event of events) {
    collector.ingest(event);
    lastAt = Math.max(lastAt, event.at);
  }
  // Advance past the attempt quiescence window so the logical run closes.
  collector.sweep(lastAt + 30_000);
  return exporter.getFinishedSpans();
}

function preview(text: string, max = 84): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…(${flat.length})`;
}

export function renderTree(spans: readonly ReadableSpan[]): string[] {
  const byParent = new Map<string, ReadableSpan[]>();
  const roots: ReadableSpan[] = [];
  for (const span of spans) {
    const parentId = span.parentSpanContext?.spanId;
    if (!parentId) {
      roots.push(span);
      continue;
    }
    const bucket = byParent.get(parentId) ?? [];
    bucket.push(span);
    byParent.set(parentId, bucket);
  }

  const lines: string[] = [];
  const walk = (span: ReadableSpan, depth: number): void => {
    const attrs = span.attributes as Record<string, unknown>;
    const kind = (attrs["gen_ai.span.kind"] as string | undefined) ?? "extension";
    const durationMs = Math.round(toMs(span.endTime) - toMs(span.startTime));
    const status = ["UNSET", "OK", "ERROR"][span.status.code] ?? "UNSET";
    const extras: string[] = [];
    if (attrs["gen_ai.usage.total_tokens"] !== undefined) {
      extras.push(`tokens=${String(attrs["gen_ai.usage.total_tokens"])}`);
    }
    if (attrs["error.type"] !== undefined) {
      extras.push(`error=${String(attrs["error.type"])}`);
    }
    if (attrs["openclaw.host.span_id"] !== undefined) {
      extras.push(`host=${String(attrs["openclaw.host.span_id"]).slice(0, 8)}`);
    }
    lines.push(
      `${"  ".repeat(depth)}${depth > 0 ? "└─ " : ""}[${kind}] ${span.name}  ${durationMs}ms  ${status}${
        extras.length > 0 ? `  ${extras.join(" ")}` : ""
      }`,
    );

    const pad = `${"  ".repeat(depth + 1)}  `;
    for (const [key, label] of [
      ["gen_ai.input.messages", "in "],
      ["gen_ai.input.messages_delta", "Δin"],
      ["gen_ai.output.messages", "out"],
    ] as const) {
      const raw = attrs[key];
      if (typeof raw !== "string") {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as {
          role: string;
          parts: { type: string; content?: string }[];
        }[];
        for (const message of parsed) {
          const rendered = message.parts
            .map((part) => {
              if (part.type === "text" && typeof part.content === "string") {
                return part.content;
              }
              const record = part as unknown as Record<string, unknown>;
              if (part.type === "tool_call") {
                return `tool_call ${String(record.name)}(${String(record.arguments)})`;
              }
              if (part.type === "tool_call_response") {
                return `tool_response ${String(record.id)}: ${String(record.result)}`;
              }
              return `[${part.type}]`;
            })
            .join("\n");
          lines.push(`${pad}${label} ${message.role}: ${preview(rendered)}`);
        }
      } catch {
        lines.push(`${pad}${label} <invalid json>`);
      }
    }
    const toolArgs = attrs["gen_ai.tool.call.arguments"];
    if (typeof toolArgs === "string") {
      lines.push(`${pad}args ${preview(toolArgs)}`);
    }
    const toolResult = attrs["gen_ai.tool.call.result"];
    if (typeof toolResult === "string") {
      lines.push(`${pad}res  ${preview(toolResult)}`);
    }

    const children = (byParent.get(span.spanContext().spanId) ?? []).slice();
    children.sort((a, b) => toMs(a.startTime) - toMs(b.startTime));
    for (const child of children) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return lines;
}

export type SuiteResult = {
  captureCount: number;
  spanCount: number;
  issueCount: number;
};

/** Replays every capture in one content mode and reports protocol issues. */
export function runSuite(opts: { contentMode: ContentMode; verbose: boolean }): SuiteResult {
  const captureDir = resolveCaptureDir();
  const files = readdirSync(captureDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no capture files in ${captureDir}`);
  }

  const config = buildVerifyConfig(opts.contentMode);
  let spanCount = 0;
  let issueCount = 0;

  for (const file of files) {
    const events = loadCapture(path.join(captureDir, file));
    if (events.length === 0) {
      continue;
    }
    const spans = runEvents(events, config);
    const issues = validateSpans(spans, { contentEnabled: opts.contentMode !== "off" });
    spanCount += spans.length;
    issueCount += issues.length;

    if (opts.verbose) {
      console.log(`\n=== ${file}  (真实事件 ${events.length} 个)`);
      for (const line of renderTree(spans)) {
        console.log(line);
      }
      const kinds = new Map<string, number>();
      for (const span of spans) {
        const kind =
          ((span.attributes as Record<string, unknown>)["gen_ai.span.kind"] as
            | string
            | undefined) ?? "extension";
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      console.log(
        `spans=${spans.length}  ${[...kinds.entries()].map(([k, v]) => `${k}:${v}`).join(" ")}`,
      );
    }

    if (issues.length > 0) {
      console.log(`协议问题 (${file}):`);
      for (const issue of issues) {
        console.log(`  - ${issue.span}: ${issue.problem}`);
      }
    }
  }

  return { captureCount: files.length, spanCount, issueCount };
}
