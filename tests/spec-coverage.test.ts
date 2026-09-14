import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SPEC_GEN_AI_ATTRIBUTES } from "../src/protocol/spec-attributes.js";
import { loadCapture } from "../src/verify/load-capture.js";
import { buildVerifyConfig, resolveCaptureDir, runEvents } from "../src/verify/suite.js";

function replay(capture: string): ReadableSpan[] {
  const events = loadCapture(path.join(resolveCaptureDir(), capture));
  assert.ok(events.length > 0, `capture ${capture} produced no events`);
  return runEvents(events, buildVerifyConfig("full"));
}

function ofKind(spans: readonly ReadableSpan[], kind: string): ReadableSpan[] {
  return spans.filter((span) => span.attributes["gen_ai.span.kind"] === kind);
}

// The spec owns `gen_ai.*`. Any key we invent there will collide with whatever
// the spec later assigns to that name, and a reader cannot tell the two apart.
test("no span invents a key in the protocol namespace", () => {
  const offenders = new Set<string>();
  for (const capture of ["01-single-turn.jsonl", "02-tool-call.jsonl", "04-tool-error.jsonl"]) {
    for (const span of replay(capture)) {
      for (const key of Object.keys(span.attributes)) {
        if (key.startsWith("gen_ai.") && !SPEC_GEN_AI_ATTRIBUTES.has(key)) {
          offenders.add(key);
        }
      }
    }
  }
  assert.deepEqual([...offenders], []);
});

// Data we already collect must use the spec's field when the spec defines one;
// hiding it under `openclaw.*` makes it invisible to any spec-aware consumer.
test("time to first token uses the spec field, not only the vendor one", () => {
  const chats = ofKind(replay("02-tool-call.jsonl"), "chat");
  const timed = chats.filter(
    (span) => span.attributes["gen_ai.response.time_to_first_token_ms"] !== undefined,
  );
  assert.ok(timed.length > 0, "capture should contain a chat with a measured TTFT");
  for (const span of timed) {
    assert.equal(
      span.attributes["gen_ai.response.time_to_first_token_ms"],
      span.attributes["openclaw.model.ttfb_ms"],
    );
  }
});

// Identity is delivered across several hooks, so the entry span — opened
// first — can miss fields that later hooks supply. It is the turn root that
// entry-level queries filter on, so it must end up complete.
test("entry carries the channel through the spec field", () => {
  // Only the e2e captures were recorded through a channel; the earlier probe
  // captures have no channel at all, so they cannot exercise this.
  const spans = replay("06-e2e.jsonl");
  const entry = ofKind(spans, "entry")[0];
  assert.ok(entry);
  assert.equal(entry.attributes["gen_ai.entry.channel_id"], "webchat");
  assert.equal(entry.attributes["openclaw.channel"], "webchat");
});

test("entry without a known channel omits the field rather than inventing one", () => {
  const entry = ofKind(replay("02-tool-call.jsonl"), "entry")[0];
  assert.ok(entry);
  assert.equal(entry.attributes["gen_ai.entry.channel_id"], undefined);
});

test("gen_ai.system is reported wherever the provider is known", () => {
  for (const span of ofKind(replay("02-tool-call.jsonl"), "chat")) {
    assert.equal(span.attributes["gen_ai.system"], span.attributes["gen_ai.provider.name"]);
  }
});

// No recorded capture carries `after_tool_call.error`: every tool failure in
// the corpus is a non-zero exit code reported through the structured result.
// The error-message path therefore has to be driven explicitly, otherwise this
// mapping would ship unverified.
test("tool error message uses the spec field", () => {
  const events = loadCapture(path.join(resolveCaptureDir(), "04-tool-error.jsonl"));
  const injected = events.map((event) =>
    event.type === "tool.ended"
      ? { ...event, errorMessage: "permission denied while opening /etc/shadow" }
      : event,
  );
  assert.notDeepEqual(injected, events, "capture should contain a tool.ended event");

  const tools = ofKind(runEvents(injected, buildVerifyConfig("full")), "tool");
  const withMessage = tools.filter(
    (span) => span.attributes["gen_ai.tool.error.message"] !== undefined,
  );
  assert.ok(withMessage.length > 0, "an errored tool should report its message");
  for (const span of withMessage) {
    assert.equal(
      span.attributes["gen_ai.tool.error.message"],
      span.attributes["openclaw.tool.error.message"],
    );
    assert.match(String(span.attributes["gen_ai.tool.error.message"]), /permission denied/);
  }
});

test("tool error message stays absent when content capture is off", () => {
  const events = loadCapture(path.join(resolveCaptureDir(), "04-tool-error.jsonl")).map((event) =>
    event.type === "tool.ended" ? { ...event, errorMessage: "secret-bearing failure" } : event,
  );
  for (const span of ofKind(runEvents(events, buildVerifyConfig("off")), "tool")) {
    assert.equal(span.attributes["gen_ai.tool.error.message"], undefined);
  }
});

test("model call id is reported as the spec request id", () => {
  const chats = ofKind(replay("02-tool-call.jsonl"), "chat").filter(
    (span) => span.attributes["openclaw.model.call.id"] !== undefined,
  );
  assert.ok(chats.length > 0, "capture should contain model-level chat spans");
  for (const span of chats) {
    assert.equal(span.attributes["gen_ai.request.id"], span.attributes["openclaw.model.call.id"]);
  }
});
