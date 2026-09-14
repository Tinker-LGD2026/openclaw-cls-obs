import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { loadCapture } from "../src/verify/load-capture.js";
import { buildVerifyConfig, resolveCaptureDir, runEvents } from "../src/verify/suite.js";

function spansOfKind(spans: readonly ReadableSpan[], kind: string): ReadableSpan[] {
  return spans.filter((span) => span.attributes["gen_ai.span.kind"] === kind);
}

function replay(capture: string): ReadableSpan[] {
  const events = loadCapture(path.join(resolveCaptureDir(), capture));
  assert.ok(events.length > 0, `capture ${capture} produced no events`);
  return runEvents(events, buildVerifyConfig("full"));
}

// The console reads the trace-level input/output from the entry span, so the
// agent span must not duplicate them: an extra copy grows storage without
// changing what the console shows.
test("turn messages live on the entry span alone", () => {
  for (const capture of ["02-tool-call.jsonl", "06-e2e.jsonl"]) {
    const spans = replay(capture);
    for (const agent of spansOfKind(spans, "agent")) {
      assert.equal(agent.attributes["gen_ai.input.messages"], undefined);
      assert.equal(agent.attributes["gen_ai.output.messages"], undefined);
    }
    for (const entry of spansOfKind(spans, "entry")) {
      assert.notEqual(entry.attributes["gen_ai.input.messages"], undefined);
      assert.notEqual(entry.attributes["gen_ai.output.messages"], undefined);
    }
  }
});

// llm_output is the attempt aggregate; it must never land on a single chat
// span. Per-call usage arrives with assistant.persisted (captured by newer
// probes), and these old captures predate that hook.
test("the llm_output aggregate never lands on a chat span", () => {
  for (const capture of ["01-single-turn.jsonl", "02-tool-call.jsonl"]) {
    const spans = replay(capture);
    for (const chat of spansOfKind(spans, "chat")) {
      assert.equal(
        chat.attributes["gen_ai.usage.input_tokens"],
        undefined,
        "chat usage only comes from assistant.persisted, which old captures lack",
      );
    }
    const agent = spansOfKind(spans, "agent")[0];
    assert.ok(agent);
    assert.equal(
      typeof agent.attributes["gen_ai.usage.input_tokens"],
      "number",
      "the turn aggregate stays on the agent span",
    );
    assert.equal(agent.attributes["openclaw.usage.scope"], "turn_only");
  }
});
