// Regression tests for the defects found in the 2026-09-13 review
// from a robustness review; each test names the defect id.
import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { Collector } from "../src/collector.js";
import { DEFAULT_LIMITS, type RunStateLimits } from "../src/domain/run-state.js";
import type { ObservationEvent, RunIdentity } from "../src/domain/types.js";
import { buildResourceAttributes } from "../src/telemetry/provider.js";
import { buildVerifyConfig, runEvents } from "../src/verify/suite.js";
import type { ClsObservabilityConfig } from "../src/config.js";

const PARENT: RunIdentity = {
  runId: "run-x",
  sessionKey: "agent:main:s1",
  sessionId: "sid-1",
  agentId: "main",
};

const MODEL = { provider: "deepseek", model: "deepseek-chat" };

function runWithLimits(
  events: readonly ObservationEvent[],
  config: ClsObservabilityConfig,
  limits: RunStateLimits,
) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes(buildResourceAttributes(config)),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const collector = new Collector(
    config,
    { tracer: provider.getTracer("verify"), forceFlush: async () => {}, shutdown: async () => {} },
    { info: () => {}, warn: () => {} },
    limits,
  );
  let lastAt = 0;
  for (const event of events) {
    collector.ingest(event);
    lastAt = Math.max(lastAt, event.at);
  }
  collector.sweep(lastAt + 30_000);
  return exporter.getFinishedSpans();
}

function modelRound(at: number, callId: string): ObservationEvent[] {
  return [
    { type: "model.started", at, callId, ...MODEL, ...PARENT },
    { type: "model.ended", at: at + 100, callId, ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
  ];
}

// D-1: past the step limit, startStep used to return the step it had just
// closed, and the emitter silently re-rooted the chat as a new trace. The chat
// must now degrade onto the agent span inside the same trace instead.
test("D-1: model calls past the step limit attach to the agent span, not a new trace", () => {
  const events: ObservationEvent[] = [
    { type: "run.attempt.started", at: 1_000, ...PARENT },
    {
      type: "turn.input.observed",
      at: 1_010,
      ...MODEL,
      input: { prompt: "长任务" },
      ...PARENT,
    },
    ...modelRound(1_020, "c1"),
    ...modelRound(1_200, "c2"),
    { type: "run.attempt.ended", at: 1_400, success: true, ...PARENT },
  ];
  const spans = runWithLimits(events, buildVerifyConfig("full"), {
    ...DEFAULT_LIMITS,
    maxStepsPerRun: 1,
  });

  const entry = spans.find((s) => s.attributes["gen_ai.span.kind"] === "entry");
  const agent = spans.find((s) => s.attributes["gen_ai.span.kind"] === "agent");
  const chats = spans.filter((s) => s.attributes["gen_ai.span.kind"] === "chat");
  assert.ok(entry && agent);
  assert.equal(chats.length, 2, "both model calls must still be reported");
  for (const chat of chats) {
    assert.equal(
      chat.spanContext().traceId,
      entry.spanContext().traceId,
      "no chat may be re-rooted into its own trace",
    );
  }
  const overLimit = chats.find((s) => s.attributes["gen_ai.request.id"] === "c2");
  assert.ok(overLimit);
  assert.equal(
    overLimit.parentSpanContext?.spanId,
    agent.spanContext().spanId,
    "the over-limit chat degrades onto the agent span",
  );
  assert.match(
    String(agent.attributes["openclaw.observation.reason"] ?? ""),
    /step_limit_reached/,
    "the degradation must be visible on the agent span",
  );
});

// D-2: a repeated call id used to replace the record silently, stranding the
// first span in the emitter forever (the emitter has no TTL). The displaced
// span must be closed explicitly.
test("D-2: a duplicate model call id closes the displaced span instead of leaking it", () => {
  const events: ObservationEvent[] = [
    { type: "run.attempt.started", at: 1_000, ...PARENT },
    { type: "model.started", at: 1_020, callId: "c1", ...MODEL, ...PARENT },
    // Host redelivers the same call id (retry/hook replay): the second start
    // must not strand the first span.
    { type: "model.started", at: 1_120, callId: "c1", ...MODEL, ...PARENT },
    { type: "model.ended", at: 1_220, callId: "c1", ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
    { type: "run.attempt.ended", at: 1_400, success: true, ...PARENT },
  ];
  const spans = runEvents(events, buildVerifyConfig("full"));
  const chats = spans.filter((s) => s.attributes["gen_ai.request.id"] === "c1");
  assert.equal(chats.length, 2, "both starts produce a span");
  for (const chat of chats) {
    assert.ok(chat.endTime[0] > 0, "every chat span must be ended");
  }
  const displaced = chats.find((s) => s.startTime[0] === 1 && s.startTime[1] === 20_000_000);
  assert.ok(displaced, "the displaced span is identifiable by its start time");
});

test("D-2: a duplicate tool call id closes the displaced span instead of leaking it", () => {
  const events: ObservationEvent[] = [
    { type: "run.attempt.started", at: 1_000, ...PARENT },
    { type: "model.started", at: 1_010, callId: "c1", ...MODEL, ...PARENT },
    { type: "model.ended", at: 1_050, callId: "c1", ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
    {
      type: "tool.started",
      at: 1_060,
      toolCallId: "t1",
      toolName: "exec",
      arguments: '{"command":"pwd"}',
      ...PARENT,
    },
    {
      type: "tool.started",
      at: 1_160,
      toolCallId: "t1",
      toolName: "exec",
      arguments: '{"command":"pwd"}',
      ...PARENT,
    },
    { type: "tool.ended", at: 1_260, toolCallId: "t1", toolName: "exec", ...PARENT },
    { type: "run.attempt.ended", at: 1_400, success: true, ...PARENT },
  ];
  const spans = runEvents(events, buildVerifyConfig("full"));
  const tools = spans.filter((s) => s.attributes["gen_ai.tool.call.id"] === "t1");
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    assert.ok(tool.endTime[0] > 0, "every tool span must be ended");
  }
});

// D-4: with content capture off, the sessions_spawn result text is not
// captured, so result-based linking had nothing to parse. The hook layer now
// extracts the linkage keys as topology metadata, so parallel spawns link even
// when content is off.
test("D-4: parallel spawns link with content capture off via spawnLink metadata", () => {
  const events: ObservationEvent[] = [
    { type: "run.attempt.started", at: 1_000, ...PARENT },
    {
      type: "turn.input.observed",
      at: 1_010,
      ...MODEL,
      input: { prompt: "并行两件事" },
      ...PARENT,
    },
    { type: "model.started", at: 1_020, callId: "pc1", ...MODEL, ...PARENT },
    { type: "model.ended", at: 1_200, callId: "pc1", ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
    {
      type: "tool.started",
      at: 1_210,
      toolCallId: "call_A",
      toolName: "sessions_spawn",
      ...PARENT,
    },
    {
      type: "tool.started",
      at: 1_220,
      toolCallId: "call_B",
      toolName: "sessions_spawn",
      ...PARENT,
    },
    {
      type: "tool.ended",
      at: 1_250,
      toolCallId: "call_A",
      toolName: "sessions_spawn",
      // No result text: content mode is off. The linkage still arrives.
      spawnLink: { childSessionKey: "agent:main:subagent:ua", childRunId: "child-a" },
      ...PARENT,
    },
    {
      type: "tool.ended",
      at: 1_260,
      toolCallId: "call_B",
      toolName: "sessions_spawn",
      spawnLink: { childSessionKey: "agent:main:subagent:ub", childRunId: "child-b" },
      ...PARENT,
    },
    {
      type: "subagent.ended",
      at: 1_300,
      childRunId: "child-a",
      childSessionKey: "agent:main:subagent:ua",
      outcome: "ok",
    },
    {
      type: "subagent.ended",
      at: 1_310,
      childRunId: "child-b",
      childSessionKey: "agent:main:subagent:ub",
      outcome: "ok",
    },
    { type: "run.attempt.ended", at: 1_400, success: true, ...PARENT },
  ];
  const spans = runEvents(events, buildVerifyConfig("off"));
  const subagents = spans.filter((s) => s.attributes["gen_ai.agent.scope"] === "subagent");
  assert.equal(subagents.length, 2, "both children must link without any captured content");
  const toolSpanIds = new Map(
    spans
      .filter((s) => s.attributes["gen_ai.span.kind"] === "tool")
      .map((s) => [s.attributes["gen_ai.tool.call.id"], s.spanContext().spanId]),
  );
  for (const sub of subagents) {
    const parentCall = String(sub.attributes["gen_ai.subagent.parent_tool_call.id"]);
    assert.equal(
      sub.parentSpanContext?.spanId,
      toolSpanIds.get(parentCall),
      `subagent must hang off its own spawn tool span (${parentCall})`,
    );
  }
});

// Per-call usage attribution (assistant.persisted): each assistant message is
// one completed model call, and its usage must land on that call's chat span.
test("per-call usage is attributed to each call's own chat span", () => {
  const events: ObservationEvent[] = [
    { type: "run.attempt.started", at: 1_000, ...PARENT },
    {
      type: "turn.input.observed",
      at: 1_010,
      ...MODEL,
      input: { prompt: "两轮任务" },
      ...PARENT,
    },
    { type: "model.started", at: 1_020, callId: "c1", ...MODEL, ...PARENT },
    // The assistant message of call c1 persists before model_call_ended.
    {
      type: "assistant.persisted",
      at: 1_100,
      sessionKey: PARENT.sessionKey,
      agentId: "main",
      stopReason: "toolUse",
      usage: {
        input: 100,
        output: 40,
        cacheRead: 900,
        total: 1040,
        reasoningTokens: 12,
        cost: { total: 0.0012, input: 0.001, output: 0.0002 },
      },
    },
    { type: "model.ended", at: 1_120, callId: "c1", ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
    {
      type: "tool.started",
      at: 1_130,
      toolCallId: "t1",
      toolName: "exec",
      arguments: '{"command":"pwd"}',
      ...PARENT,
    },
    { type: "tool.ended", at: 1_200, toolCallId: "t1", toolName: "exec", ...PARENT },
    { type: "model.started", at: 1_210, callId: "c2", ...MODEL, ...PARENT },
    {
      type: "assistant.persisted",
      at: 1_300,
      sessionKey: PARENT.sessionKey,
      agentId: "main",
      stopReason: "stop",
      usage: { input: 200, output: 60, total: 260 },
    },
    { type: "model.ended", at: 1_320, callId: "c2", ...MODEL, outcome: "completed", durationMs: 110, ...PARENT },
    {
      type: "model.turn.observed",
      at: 1_330,
      ...MODEL,
      usage: { input: 300, output: 100, cacheRead: 900, total: 1300 },
      output: { assistantTexts: ["完成"] },
      ...PARENT,
    },
    { type: "run.attempt.ended", at: 1_400, success: true, ...PARENT },
  ];
  const spans = runEvents(events, buildVerifyConfig("full"));
  const byCall = new Map(
    spans
      .filter((s) => s.attributes["gen_ai.span.kind"] === "chat")
      .map((s) => [s.attributes["gen_ai.request.id"], s]),
  );
  const c1 = byCall.get("c1");
  const c2 = byCall.get("c2");
  assert.ok(c1 && c2, "both calls must have chat spans");

  // c1: exact per-call values, inclusive input semantics, reasoning and cost.
  assert.equal(c1.attributes["gen_ai.usage.input_tokens"], 1000, "uncached + cacheRead");
  assert.equal(c1.attributes["gen_ai.usage.output_tokens"], 40);
  assert.equal(c1.attributes["gen_ai.usage.total_tokens"], 1040);
  assert.equal(c1.attributes["gen_ai.usage.cache_read.input_tokens"], 900);
  assert.equal(c1.attributes["gen_ai.usage.reasoning_output_tokens"], 12);
  assert.equal(c1.attributes["gen_ai.usage.total_cost"], 0.0012);
  assert.equal(c1.attributes["openclaw.usage.scope"], "call");
  assert.equal(c1.attributes["openclaw.usage.cost_source"], "price_table_estimate");

  // c2: its own values, not c1's and not the turn aggregate.
  assert.equal(c2.attributes["gen_ai.usage.input_tokens"], 200);
  assert.equal(c2.attributes["gen_ai.usage.output_tokens"], 60);
  assert.equal(c2.attributes["openclaw.usage.scope"], "call");

  // The agent span still carries the turn aggregate from llm_output.
  const agent = spans.find((s) => s.attributes["gen_ai.span.kind"] === "agent");
  assert.ok(agent);
  assert.equal(agent.attributes["gen_ai.usage.input_tokens"], 1200);
  assert.equal(agent.attributes["openclaw.usage.scope"], "turn_only");
});

test("duplicate assistant.persisted for the same call is counted once", () => {
  const persisted: ObservationEvent = {
    type: "assistant.persisted",
    at: 1_100,
    sessionKey: PARENT.sessionKey,
    usage: { input: 10, output: 5, total: 15 },
  };
  const events: ObservationEvent[] = [
    { type: "run.attempt.started", at: 1_000, ...PARENT },
    { type: "model.started", at: 1_020, callId: "c1", ...MODEL, ...PARENT },
    persisted,
    { ...persisted, at: 1_101 },
    { type: "model.ended", at: 1_120, callId: "c1", ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
    { type: "run.attempt.ended", at: 1_400, success: true, ...PARENT },
  ];
  const spans = runEvents(events, buildVerifyConfig("full"));
  const chat = spans.find((s) => s.attributes["gen_ai.request.id"] === "c1");
  assert.ok(chat);
  assert.equal(chat.attributes["gen_ai.usage.input_tokens"], 10);
});

// D-5: before the fix, live-captured tool payloads were stored already
// truncated (one algorithm) while the host's history replay was truncated at
// render time (another), so any tool payload past the display limit reset the
// delta chain on every turn. The cursor now fingerprints the raw conversation.
test("D-5: long tool output no longer resets the delta chain in truncate mode", () => {
  const longOutput = `LINE-${"x".repeat(6_000)}-END`;
  const envelope = JSON.stringify({
    content: [{ type: "text", text: longOutput }],
    details: { status: "completed", exitCode: 0 },
  });
  const argsText = '{"command":"cat big.log"}';

  const turn1: ObservationEvent[] = [
    { type: "run.attempt.started", at: 1_000, ...PARENT },
    {
      type: "turn.input.observed",
      at: 1_010,
      ...MODEL,
      input: { prompt: "看日志" },
      ...PARENT,
    },
    { type: "model.started", at: 1_020, callId: "t1c1", ...MODEL, ...PARENT },
    { type: "model.ended", at: 1_120, callId: "t1c1", ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
    {
      type: "tool.started",
      at: 1_130,
      toolCallId: "call_1",
      toolName: "exec",
      arguments: argsText,
      ...PARENT,
    },
    { type: "tool.ended", at: 1_230, toolCallId: "call_1", toolName: "exec", result: envelope, ...PARENT },
    { type: "model.started", at: 1_240, callId: "t1c2", ...MODEL, ...PARENT },
    { type: "model.ended", at: 1_340, callId: "t1c2", ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
    {
      type: "model.turn.observed",
      at: 1_350,
      ...MODEL,
      usage: { input: 10, output: 5 },
      output: { assistantTexts: ["日志最后一行是 END"] },
      ...PARENT,
    },
    { type: "run.attempt.ended", at: 1_400, success: true, ...PARENT },
  ];

  // Turn 2 replays turn 1 through history, exactly as the host would.
  const turn2Identity: RunIdentity = { ...PARENT, runId: "run-y" };
  const turn2: ObservationEvent[] = [
    { type: "run.attempt.started", at: 2_000, ...turn2Identity },
    {
      type: "turn.input.observed",
      at: 2_010,
      ...MODEL,
      input: {
        prompt: "最后一行是什么",
        history: [
          { role: "user", content: [{ type: "text", text: "看日志" }] },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call1", name: "exec", arguments: { command: "cat big.log" } },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call1",
            toolName: "exec",
            content: [{ type: "text", text: longOutput }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "日志最后一行是 END" }],
          },
        ],
      },
      ...turn2Identity,
    },
    { type: "model.started", at: 2_020, callId: "t2c1", ...MODEL, ...turn2Identity },
    { type: "model.ended", at: 2_120, callId: "t2c1", ...MODEL, outcome: "completed", durationMs: 100, ...turn2Identity },
    { type: "run.attempt.ended", at: 2_400, success: true, ...turn2Identity },
  ];

  // truncate mode with a pinned 4000-char limit (the verify config's value, not
  // the production default): the tool output exceeds it.
  const spans = runEvents([...turn1, ...turn2], buildVerifyConfig("truncate"));
  const turn2Chats = spans.filter(
    (s) =>
      s.attributes["gen_ai.span.kind"] === "chat" &&
      s.attributes["openclaw.run.id"] === "run-y",
  );
  assert.ok(turn2Chats.length > 0, "turn 2 must report a chat");
  const first = turn2Chats[0];
  assert.ok(first);
  assert.notEqual(
    first.attributes["gen_ai.input.messages_delta"],
    undefined,
    "turn 2 must extend the chain with a delta despite the oversized tool output",
  );
  assert.equal(
    first.attributes["openclaw.input.delta_reset"],
    undefined,
    "no prefix reset may be recorded",
  );
});

// The production result text is the serialized envelope
// `{"content":[{"text":"<json>"}]}`, not the inner JSON — the pre-review
// fallback parsed the wrong layer and never linked from result text in
// production. Both layers must be recognized.
test("D-4: result-text fallback recognizes both the envelope and the inner json", () => {
  const base: ObservationEvent[] = [
    { type: "run.attempt.started", at: 1_000, ...PARENT },
    {
      type: "turn.input.observed",
      at: 1_010,
      ...MODEL,
      input: { prompt: "派生一个" },
      ...PARENT,
    },
    { type: "model.started", at: 1_020, callId: "pc1", ...MODEL, ...PARENT },
    { type: "model.ended", at: 1_200, callId: "pc1", ...MODEL, outcome: "completed", durationMs: 100, ...PARENT },
    {
      type: "tool.started",
      at: 1_210,
      toolCallId: "call_1",
      toolName: "sessions_spawn",
      ...PARENT,
    },
  ];
  const tail: ObservationEvent[] = [
    {
      type: "subagent.ended",
      at: 1_300,
      childRunId: "child-1",
      childSessionKey: "agent:main:subagent:u1",
      outcome: "ok",
    },
    { type: "run.attempt.ended", at: 1_400, success: true, ...PARENT },
  ];
  const envelope = JSON.stringify({
    content: [
      {
        type: "text",
        text: '{"status":"accepted","childSessionKey":"agent:main:subagent:u1","runId":"child-1"}',
      },
    ],
  });
  const spans = runEvents(
    [
      ...base,
      // Deliberately no spawnLink and an in-flight ambiguity is avoided by a
      // single spawn; the point is that the envelope text alone must link.
      { type: "tool.ended", at: 1_250, toolCallId: "call_1", toolName: "sessions_spawn", result: envelope, ...PARENT },
      ...tail,
    ],
    buildVerifyConfig("full"),
  );
  const linked = spans.filter((s) => s.attributes["gen_ai.agent.scope"] === "subagent");
  assert.equal(linked.length, 1, "envelope-shaped result text must still link the child");
  assert.equal(linked[0]?.attributes["openclaw.run.id"] ?? "child-1", "child-1");
});
