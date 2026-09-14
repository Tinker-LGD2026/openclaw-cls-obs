import assert from "node:assert/strict";
import test from "node:test";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { createClsCompatibleExporter } from "../src/telemetry/cls-compatible-exporter.js";

test("decodes CLS structured content at the OTLP export boundary", async () => {
  let exported: readonly ReadableSpan[] = [];
  const delegate: SpanExporter = {
    export(spans, callback) {
      exported = spans;
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
  };
  const original = {
    attributes: {
      "gen_ai.input.messages":
        '[{"role":"user","parts":[{"type":"text","content":"hello"}]}]',
      "gen_ai.tool.call.arguments": '{"command":"pwd"}',
      "plain.string": "unchanged",
    },
    spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 }),
  } as unknown as ReadableSpan;

  const exporter = createClsCompatibleExporter(delegate);
  await new Promise<void>((resolve, reject) => {
    exporter.export([original], (result: ExportResult) =>
      result.code === ExportResultCode.SUCCESS ? resolve() : reject(result.error),
    );
  });

  const attrs = exported[0]?.attributes as unknown as Record<string, unknown>;
  assert.ok(Array.isArray(attrs["gen_ai.input.messages"]));
  assert.deepEqual(attrs["gen_ai.tool.call.arguments"], { command: "pwd" });
  assert.equal(attrs["plain.string"], "unchanged");
  assert.equal(typeof original.attributes["gen_ai.input.messages"], "string");
});

test("leaves malformed JSON as a string", async () => {
  let value: unknown;
  const delegate: SpanExporter = {
    export(spans, callback) {
      value = (spans[0]?.attributes as unknown as Record<string, unknown>)[
        "gen_ai.output.messages"
      ];
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
  };
  const span = {
    attributes: { "gen_ai.output.messages": "not-json" },
    spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 }),
  } as unknown as ReadableSpan;
  await new Promise<void>((resolve) =>
    createClsCompatibleExporter(delegate).export([span], () => resolve()),
  );
  assert.equal(value, "not-json");
});
