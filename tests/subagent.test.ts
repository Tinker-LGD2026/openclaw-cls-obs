import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ObservationEvent, RunIdentity } from "../src/domain/types.js";
import { loadCapture } from "../src/verify/load-capture.js";
import { buildVerifyConfig, resolveCaptureDir, runEvents } from "../src/verify/suite.js";
import { validateSpans } from "../src/verify/validator.js";

const PARENT: RunIdentity = {
  runId: "parent-run",
  sessionKey: "agent:main:s1",
  sessionId: "sid-parent",
  agentId: "main",
  channelId: "webchat",
};

const CHILD_A: RunIdentity = {
  runId: "child-run-a",
  sessionKey: "agent:main:subagent:ua",
  sessionId: "sid-child-a",
  agentId: "main",
};

const CHILD_B: RunIdentity = {
  runId: "child-run-b",
  sessionKey: "agent:main:subagent:ub",
  sessionId: "sid-child-b",
  agentId: "main",
};

const MODEL = { provider: "deepseek", model: "deepseek-chat" };

function parentTurn(at: number): ObservationEvent[] {
  return [
    { type: "run.attempt.started", at, ...PARENT },
    {
      type: "turn.input.observed",
      at: at + 10,
      ...MODEL,
      input: { prompt: "帮我并行做两件事" },
      ...PARENT,
    },
    { type: "model.started", at: at + 20, callId: "pc1", ...MODEL, ...PARENT },
    {
      type: "model.ended",
      at: at + 200,
      callId: "pc1",
      ...MODEL,
      outcome: "completed",
      durationMs: 180,
      ...PARENT,
    },
  ];
}

function parentTurnEnd(at: number): ObservationEvent[] {
  return [
    {
      type: "model.turn.observed",
      at,
      ...MODEL,
      usage: { input: 200, output: 80 },
      output: { assistantTexts: ["两件事都完成了"] },
      ...PARENT,
    },
    { type: "run.attempt.ended", at: at + 10, success: true, ...PARENT },
  ];
}

function childRunEvents(identity: RunIdentity, at: number, taskText: string): ObservationEvent[] {
  return [
    { type: "run.attempt.started", at, ...identity },
    {
      type: "turn.input.observed",
      at: at + 10,
      ...MODEL,
      input: { prompt: taskText },
      ...identity,
    },
    { type: "model.started", at: at + 20, callId: `${identity.runId}-c1`, ...MODEL, ...identity },
    {
      type: "model.ended",
      at: at + 220,
      callId: `${identity.runId}-c1`,
      ...MODEL,
      outcome: "completed",
      durationMs: 200,
      ...identity,
    },
    {
      type: "model.turn.observed",
      at: at + 230,
      ...MODEL,
      usage: { input: 100, output: 40 },
      output: { assistantTexts: [`${taskText}的结果`] },
      ...identity,
    },
    { type: "run.attempt.ended", at: at + 240, success: true, ...identity },
  ];
}

function spansOfKind(spans: readonly ReadableSpan[], kind: string): ReadableSpan[] {
  return spans.filter((span) => span.attributes["gen_ai.span.kind"] === kind);
}

function spanByName(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  assert.ok(span, `span ${name} not found among: ${spans.map((s) => s.name).join(", ")}`);
  return span;
}

test("subagent run nests under the sessions_spawn tool span in the parent trace", () => {
  const events: ObservationEvent[] = [
    ...parentTurn(1_000),
    {
      type: "tool.started",
      at: 1_210,
      toolCallId: "call_00_spawnA",
      toolName: "sessions_spawn",
      arguments: '{"task":"调研X"}',
      ...PARENT,
    },
    {
      type: "subagent.spawned",
      at: 1_230,
      childRunId: CHILD_A.runId,
      childSessionKey: CHILD_A.sessionKey as string,
      requesterSessionKey: PARENT.sessionKey,
      agentId: "main",
      label: "调研X",
      ...MODEL,
    },
    {
      type: "tool.ended",
      at: 1_250,
      toolCallId: "call_00_spawnA",
      toolName: "sessions_spawn",
      durationMs: 40,
      result: `{"status":"accepted","childSessionKey":"${CHILD_A.sessionKey}","runId":"${CHILD_A.runId}"}`,
      ...PARENT,
    },
    ...childRunEvents(CHILD_A, 1_260, "调研X"),
    {
      type: "subagent.ended",
      at: 1_530,
      childRunId: CHILD_A.runId,
      childSessionKey: CHILD_A.sessionKey,
      reason: "subagent-complete",
      outcome: "ok",
    },
    ...parentTurnEnd(1_600),
  ];

  const spans = runEvents(events, buildVerifyConfig("full"));
  const issues = validateSpans(spans, { contentEnabled: true });
  assert.deepEqual(issues, [], `protocol issues: ${JSON.stringify(issues, null, 2)}`);

  const entry = spanByName(spans, "enter_application");
  const toolSpan = spanByName(spans, "execute_tool sessions_spawn");
  const subagent = spanByName(spans, "invoke_agent main");

  // Nesting and trace continuity.
  assert.equal(
    subagent.parentSpanContext?.spanId,
    toolSpan.spanContext().spanId,
    "subagent agent span must hang off the sessions_spawn tool span",
  );
  assert.equal(
    subagent.spanContext().traceId,
    entry.spanContext().traceId,
    "subagent must share the parent turn's trace",
  );

  // Spec §3.9 attributes.
  assert.equal(subagent.attributes["gen_ai.operation.name"], "invoke_subagent");
  assert.equal(subagent.attributes["gen_ai.agent.scope"], "subagent");
  assert.equal(
    subagent.attributes["gen_ai.subagent.parent_tool_call.id"],
    "call00spawnA",
    "parent tool call id uses the canonical form",
  );
  // Default subagents inherit the caller's agentId, so the name matches the
  // parent's; the task label is what tells them apart in the console.
  assert.equal(subagent.name, "invoke_agent main");
  assert.equal(subagent.attributes["openclaw.subagent.label"], "调研X");

  // Identity chain: same session, own turn number.
  assert.equal(subagent.attributes["gen_ai.session.id"], entry.attributes["gen_ai.session.id"]);
  assert.notEqual(subagent.attributes["gen_ai.turn.id"], entry.attributes["gen_ai.turn.id"]);
  assert.match(String(subagent.attributes["gen_ai.turn.id"]), /:t\d+$/);

  // The child's work is a real subtree with its own steps and chats.
  const childChats = spansOfKind(spans, "chat").filter(
    (span) => span.attributes["gen_ai.turn.id"] === subagent.attributes["gen_ai.turn.id"],
  );
  assert.ok(childChats.length > 0, "child model calls must appear inside the subagent subtree");
  for (const chat of childChats) {
    assert.equal(chat.spanContext().traceId, entry.spanContext().traceId);
  }

  // Aggregation: the subagent span counts only its own calls.
  assert.equal(subagent.attributes["gen_ai.agent.message_count"], 1);
  assert.equal(subagent.attributes["gen_ai.agent.tool_call_count"], 0);

  // Turn-level content of the child lands on the subagent agent span (spec §3.2).
  assert.notEqual(subagent.attributes["gen_ai.input.messages"], undefined);
  assert.notEqual(subagent.attributes["gen_ai.output.messages"], undefined);
});

test("parallel spawns link each child to its own tool call via the tool result", () => {
  const events: ObservationEvent[] = [
    ...parentTurn(1_000),
    {
      type: "tool.started",
      at: 1_210,
      toolCallId: "call_A",
      toolName: "sessions_spawn",
      arguments: '{"task":"任务A"}',
      ...PARENT,
    },
    {
      type: "tool.started",
      at: 1_220,
      toolCallId: "call_B",
      toolName: "sessions_spawn",
      arguments: '{"task":"任务B"}',
      ...PARENT,
    },
    // Both spawn events arrive while both tool calls are in flight, so neither
    // can be linked by position — only the results can disambiguate.
    {
      type: "subagent.spawned",
      at: 1_230,
      childRunId: CHILD_A.runId,
      childSessionKey: CHILD_A.sessionKey as string,
      requesterSessionKey: PARENT.sessionKey,
      agentId: "main",
    },
    {
      type: "subagent.spawned",
      at: 1_240,
      childRunId: CHILD_B.runId,
      childSessionKey: CHILD_B.sessionKey as string,
      requesterSessionKey: PARENT.sessionKey,
      agentId: "main",
    },
    {
      type: "tool.ended",
      at: 1_250,
      toolCallId: "call_A",
      toolName: "sessions_spawn",
      durationMs: 40,
      result: `{"status":"accepted","childSessionKey":"${CHILD_A.sessionKey}","runId":"${CHILD_A.runId}"}`,
      ...PARENT,
    },
    {
      type: "tool.ended",
      at: 1_260,
      toolCallId: "call_B",
      toolName: "sessions_spawn",
      durationMs: 50,
      result: `{"status":"accepted","childSessionKey":"${CHILD_B.sessionKey}","runId":"${CHILD_B.runId}"}`,
      ...PARENT,
    },
    ...childRunEvents(CHILD_A, 1_270, "任务A"),
    ...childRunEvents(CHILD_B, 1_280, "任务B"),
    {
      type: "subagent.ended",
      at: 1_560,
      childRunId: CHILD_A.runId,
      childSessionKey: CHILD_A.sessionKey,
      reason: "subagent-complete",
      outcome: "ok",
    },
    {
      type: "subagent.ended",
      at: 1_570,
      childRunId: CHILD_B.runId,
      childSessionKey: CHILD_B.sessionKey,
      reason: "subagent-complete",
      outcome: "ok",
    },
    ...parentTurnEnd(1_700),
  ];

  const spans = runEvents(events, buildVerifyConfig("full"));
  const issues = validateSpans(spans, { contentEnabled: true });
  assert.deepEqual(issues, [], `protocol issues: ${JSON.stringify(issues, null, 2)}`);

  const toolA = spanByName(spans, "execute_tool sessions_spawn");
  const subagents = spans.filter((span) => span.attributes["gen_ai.agent.scope"] === "subagent");
  assert.equal(subagents.length, 2, "both children must be linked");

  const parentToolIds = new Map(
    subagents.map((span) => [
      span.attributes["gen_ai.subagent.parent_tool_call.id"],
      span.parentSpanContext?.spanId,
    ]),
  );
  const toolSpansByCallId = new Map(
    spansOfKind(spans, "tool").map((span) => [
      span.attributes["gen_ai.tool.call.id"],
      span.spanContext().spanId,
    ]),
  );
  for (const [parentToolCallId, parentSpanId] of parentToolIds) {
    assert.equal(
      parentSpanId,
      toolSpansByCallId.get(parentToolCallId),
      `subagent must attach to the tool span of ${String(parentToolCallId)}`,
    );
  }
  assert.ok(parentToolIds.has("callA") || parentToolIds.has("calla") || [...parentToolIds.keys()].some(
    (key) => String(key).startsWith("call"),
  ));
  assert.equal(toolA.attributes["gen_ai.tool.name"], "sessions_spawn");
});

test("spawn failure closes the subagent span as an error with zero counts", () => {
  const events: ObservationEvent[] = [
    ...parentTurn(1_000),
    {
      type: "tool.started",
      at: 1_210,
      toolCallId: "call_00_spawnF",
      toolName: "sessions_spawn",
      arguments: '{"task":"失败的任务"}',
      ...PARENT,
    },
    {
      type: "subagent.spawned",
      at: 1_230,
      childRunId: "child-run-f",
      childSessionKey: "agent:main:subagent:uf",
      requesterSessionKey: PARENT.sessionKey,
      agentId: "main",
    },
    {
      type: "tool.ended",
      at: 1_250,
      toolCallId: "call_00_spawnF",
      toolName: "sessions_spawn",
      durationMs: 40,
      result: '{"status":"accepted","childSessionKey":"agent:main:subagent:uf","runId":"child-run-f"}',
      ...PARENT,
    },
    // No child run hooks at all: the agent process failed to start.
    {
      type: "subagent.ended",
      at: 1_300,
      childRunId: "child-run-f",
      childSessionKey: "agent:main:subagent:uf",
      reason: "spawn-failed",
      outcome: "error",
      errorMessage: "agent failed to start",
    },
    ...parentTurnEnd(1_400),
  ];

  const spans = runEvents(events, buildVerifyConfig("full"));
  const issues = validateSpans(spans, { contentEnabled: true });
  assert.deepEqual(issues, [], `protocol issues: ${JSON.stringify(issues, null, 2)}`);

  const subagent = spans.find((span) => span.attributes["gen_ai.agent.scope"] === "subagent");
  assert.ok(subagent);
  assert.equal(subagent.status.code, 2, "spawn-failed subagent span must be ERROR");
  assert.equal(subagent.attributes["error.type"], "subagent_error");
  assert.equal(subagent.attributes["gen_ai.agent.message_count"], 0);
});

test("child hooks without a spawn link keep the current standalone behavior", () => {
  const spans = runEvents(childRunEvents(CHILD_A, 1_000, "孤立任务"), buildVerifyConfig("full"));
  const entries = spansOfKind(spans, "entry");
  assert.equal(entries.length, 1, "an unlinked child run is still a standalone turn");
  assert.equal(
    spans.some((span) => span.attributes["gen_ai.agent.scope"] === "subagent"),
    false,
    "no subagent span is fabricated without a spawn link",
  );
});

// When the subagent finishes, OpenClaw wakes the parent with a fresh turn
// whose run id is `announce:v1:{childSessionKey}:{childRunId}`. That turn is
// the one that posts the result to the user, so linking it back to the
// subagent run is what makes the two traces relatable.
test("announce turn entry links back to the subagent run it came from", () => {
  const spans = runEvents(
    loadCapture(path.join(resolveCaptureDir(), "10-subagent.jsonl")),
    buildVerifyConfig("full"),
  );
  const entries = spansOfKind(spans, "entry");
  assert.equal(entries.length, 2, "parent turn plus announce turn");

  const announce = entries.find(
    (span) => span.attributes["openclaw.turn.trigger"] === "subagent_announce",
  );
  assert.ok(announce, "the announce turn must be recognizable on its entry span");
  assert.equal(
    announce.attributes["openclaw.turn.source_session_key"],
    "agent:main:subagent:7f22755d-5911-478a-b793-3ea772ce055b",
  );
  assert.equal(
    announce.attributes["openclaw.turn.source_run_id"],
    "742ec151-759f-41f2-9999-1b1ce8968ccf",
    "source run id is the subagent run embedded in the announce id",
  );

  // The link target: the subagent span in the other trace carries that run id.
  const subagent = spans.find((span) => span.attributes["gen_ai.agent.scope"] === "subagent");
  assert.ok(subagent);
  assert.equal(
    subagent.attributes["openclaw.run.id"],
    announce.attributes["openclaw.turn.source_run_id"],
  );

  // The ordinary parent turn must not be misclassified.
  const parent = entries.find((span) => span !== announce);
  assert.ok(parent);
  assert.equal(parent.attributes["openclaw.turn.trigger"], undefined);
});

test("orphan subagent span is closed by the sweep with zero counts", () => {
  const events: ObservationEvent[] = [
    ...parentTurn(1_000),
    {
      type: "tool.started",
      at: 1_210,
      toolCallId: "call_00_spawnO",
      toolName: "sessions_spawn",
      arguments: '{"task":"悬空的任务"}',
      ...PARENT,
    },
    {
      type: "subagent.spawned",
      at: 1_230,
      childRunId: "child-run-o",
      childSessionKey: "agent:main:subagent:uo",
      requesterSessionKey: PARENT.sessionKey,
      agentId: "main",
    },
    {
      type: "tool.ended",
      at: 1_250,
      toolCallId: "call_00_spawnO",
      toolName: "sessions_spawn",
      durationMs: 40,
      result: '{"status":"accepted","childSessionKey":"agent:main:subagent:uo","runId":"child-run-o"}',
      ...PARENT,
    },
    // Parent activity far past the orphan window so the sweep reaps the span.
    ...parentTurnEnd(400_000),
  ];

  const spans = runEvents(events, buildVerifyConfig("full"));
  const subagent = spans.find((span) => span.attributes["gen_ai.agent.scope"] === "subagent");
  assert.ok(subagent, "the emitted span must survive until the sweep closes it");
  assert.equal(subagent.attributes["gen_ai.agent.message_count"], 0);
  // Ended by the sweep (status unset), not left dangling.
  assert.ok(subagent.endTime[0] > 0);
});
