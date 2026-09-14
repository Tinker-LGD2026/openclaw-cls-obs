// Semantic validation for the CLS Agent Trace contract.
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ClsSpanKind } from "../domain/types.js";
import { CLS_SPAN_CONTRACTS } from "../protocol/contracts.js";
import { SPEC_GEN_AI_ATTRIBUTES } from "../protocol/spec-attributes.js";

export type ValidationIssue = {
  span: string;
  problem: string;
};

const COMMON_REQUIRED = [
  "gen_ai.operation.name",
  "gen_ai.agent.type",
  "gen_ai.session.id",
  "gen_ai.turn.id",
  "gen_ai.user.id",
  "gen_ai.user.name",
] as const;

const KIND_REQUIRED: Record<ClsSpanKind, readonly string[]> = {
  entry: ["gen_ai.entry.type"],
  agent: [
    "gen_ai.agent.name",
    "gen_ai.agent.message_count",
    "gen_ai.agent.tool_call_count",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
  ],
  step: ["gen_ai.step.id", "gen_ai.react.round", "gen_ai.react.finish_reason"],
  chat: [
    "gen_ai.agent.id",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.step.id",
    "gen_ai.chat.duration_ms",
    "gen_ai.react.round",
    "gen_ai.provider.name",
  ],
  tool: [
    "gen_ai.agent.id",
    "gen_ai.tool.name",
    "gen_ai.tool.type",
    "gen_ai.tool.call.id",
    "gen_ai.tool.call.duration_ms",
    "gen_ai.step.id",
    "gen_ai.react.round",
  ],
};

const CONTENT_KEYS = [
  "gen_ai.input.messages",
  "gen_ai.input.messages_delta",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
] as const;

// The spec lists input/output messages on entry, agent and chat. step and tool
// carry no conversation: a step is a round marker and a tool reports its call
// through the dedicated `gen_ai.tool.call.*` fields.
const MESSAGE_ALLOWED_KINDS = new Set<ClsSpanKind>(["entry", "agent", "chat"]);

function isKind(value: unknown): value is ClsSpanKind {
  return typeof value === "string" && value in CLS_SPAN_CONTRACTS;
}

/** Session ids are pseudonymized values, so they may carry regex metacharacters. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attrsOf(span: ReadableSpan): Record<string, unknown> {
  return span.attributes as Record<string, unknown>;
}

function parseMessages(value: unknown, key: string, label: string): ValidationIssue[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== "string") {
    return [{ span: label, problem: `${key} must be a JSON string` }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [{ span: label, problem: `${key} is not valid JSON` }];
  }
  if (!Array.isArray(parsed)) {
    return [{ span: label, problem: `${key} must decode to an array` }];
  }
  for (const message of parsed) {
    if (typeof message !== "object" || message === null) {
      return [{ span: label, problem: `${key} entries must be objects` }];
    }
    const record = message as Record<string, unknown>;
    if (typeof record.role !== "string" || !Array.isArray(record.parts)) {
      return [{ span: label, problem: `${key} entries need role and parts[]` }];
    }
    if ("content" in record) {
      return [{ span: label, problem: `${key} must not use legacy top-level content` }];
    }
    for (const part of record.parts) {
      if (typeof part !== "object" || part === null) {
        return [{ span: label, problem: `${key} parts must be objects` }];
      }
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type === "text" && typeof partRecord.content === "string") {
        continue;
      }
      if (
        partRecord.type === "tool_call" &&
        typeof partRecord.id === "string" &&
        typeof partRecord.name === "string" &&
        typeof partRecord.arguments === "string"
      ) {
        continue;
      }
      if (
        partRecord.type === "tool_call_response" &&
        typeof partRecord.id === "string" &&
        typeof partRecord.result === "string"
      ) {
        continue;
      }
      return [{ span: label, problem: `${key} contains an invalid message part` }];
    }
  }
  return [];
}

function validateUsage(attrs: Record<string, unknown>, label: string): ValidationIssue[] {
  const keys = [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
    "gen_ai.usage.cache_read.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "openclaw.usage.cache_miss.input_tokens",
  ] as const;
  const issues: ValidationIssue[] = [];
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
      issues.push({ span: label, problem: `${key} must be a non-negative integer` });
    }
  }
  const input = attrs["gen_ai.usage.input_tokens"];
  const output = attrs["gen_ai.usage.output_tokens"];
  const total = attrs["gen_ai.usage.total_tokens"];
  if (
    typeof input === "number" &&
    typeof output === "number" &&
    typeof total === "number" &&
    total !== input + output
  ) {
    issues.push({ span: label, problem: "usage total_tokens must equal input_tokens + output_tokens" });
  }
  const read = attrs["gen_ai.usage.cache_read.input_tokens"];
  const created = attrs["gen_ai.usage.cache_creation.input_tokens"];
  const miss = attrs["openclaw.usage.cache_miss.input_tokens"];
  if (
    typeof input === "number" &&
    typeof read === "number" &&
    typeof created === "number" &&
    typeof miss === "number" &&
    input !== read + created + miss
  ) {
    issues.push({ span: label, problem: "input_tokens must equal cache_read + cache_creation + cache_miss" });
  }
  return issues;
}

export function validateSpans(
  spans: readonly ReadableSpan[],
  opts: { contentEnabled?: boolean } = {},
): ValidationIssue[] {
  // A batch can hold several traces (e.g. a parent turn and an announce turn in
  // one session), and every trace-level rule — single entry root, session/turn
  // consistency, round sequence — is defined per trace. Validate each trace on
  // its own instead of conflating the whole batch into one.
  const byTrace = new Map<string, ReadableSpan[]>();
  for (const span of spans) {
    const traceId = span.spanContext().traceId;
    const group = byTrace.get(traceId) ?? [];
    group.push(span);
    byTrace.set(traceId, group);
  }
  const issues: ValidationIssue[] = [];
  for (const traceSpans of byTrace.values()) {
    issues.push(...validateOneTrace(traceSpans, opts));
  }
  return issues;
}

function validateOneTrace(
  spans: readonly ReadableSpan[],
  opts: { contentEnabled?: boolean },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
  const protocolSpans = spans.filter((span) => isKind(attrsOf(span)["gen_ai.span.kind"]));
  const roots = protocolSpans.filter((span) => !span.parentSpanContext?.spanId);
  if (roots.length !== 1 || attrsOf(roots[0] as ReadableSpan)["gen_ai.span.kind"] !== "entry") {
    issues.push({ span: "trace", problem: "trace must have exactly one entry root" });
  }

  const baselineSession = protocolSpans[0] ? attrsOf(protocolSpans[0])["gen_ai.session.id"] : undefined;
  const baselineTurn = protocolSpans[0] ? attrsOf(protocolSpans[0])["gen_ai.turn.id"] : undefined;
  const traceHasSubagent = protocolSpans.some(
    (span) => attrsOf(span)["gen_ai.agent.scope"] === "subagent",
  );
  const secretLike = /\b(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{16,})/;

  for (const span of spans) {
    const attrs = attrsOf(span);
    const resource = span.resource.attributes as Record<string, unknown>;
    const label = span.name;
    const kindValue = attrs["gen_ai.span.kind"];

    for (const key of ["service.name", "host.name"] as const) {
      if (typeof resource[key] !== "string" || resource[key] === "") {
        issues.push({ span: label, problem: `missing resource attribute ${key}` });
      }
    }

    for (const key of COMMON_REQUIRED) {
      if (attrs[key] === undefined || attrs[key] === "") {
        issues.push({ span: label, problem: `missing common attribute ${key}` });
      }
    }

    // `gen_ai.*` is the spec's namespace. A key invented there collides with
    // whatever the spec later assigns to it, and a consumer cannot tell it
    // apart from a real protocol field.
    for (const key of Object.keys(attrs)) {
      if (key.startsWith("gen_ai.") && !SPEC_GEN_AI_ATTRIBUTES.has(key)) {
        issues.push({
          span: label,
          problem: `${key} is not in the spec; vendor fields belong under openclaw.*`,
        });
      }
    }

    if (baselineSession !== undefined && attrs["gen_ai.session.id"] !== baselineSession) {
      issues.push({ span: label, problem: "session id differs within trace" });
    }
    if (baselineTurn !== undefined && attrs["gen_ai.turn.id"] !== baselineTurn) {
      // A subagent run joins its parent's trace under its own turn id (§3.9);
      // every turn id still has to chain off the same session id, which the
      // prefix rule below enforces.
      if (!traceHasSubagent) {
        issues.push({ span: label, problem: "turn id differs within trace" });
      }
    }

    // session -> turn -> step is a prefix chain, which is what makes the three
    // ids relatable by prefix matching alone.
    const sessionId = attrs["gen_ai.session.id"];
    const turnId = attrs["gen_ai.turn.id"];
    if (typeof sessionId === "string" && typeof turnId === "string") {
      if (!new RegExp(`^${escapeForRegExp(sessionId)}:t\\d+$`).test(turnId)) {
        issues.push({ span: label, problem: "turn id must be {sessionId}:t{N}" });
      }
    }
    const stepId = attrs["gen_ai.step.id"];
    if (typeof stepId === "string" && typeof turnId === "string") {
      if (!new RegExp(`^${escapeForRegExp(turnId)}:s\\d+$`).test(stepId)) {
        issues.push({ span: label, problem: "step id must be {turnId}:s{N}" });
      }
    }

    if (!opts.contentEnabled) {
      for (const key of CONTENT_KEYS) {
        if (attrs[key] !== undefined) {
          issues.push({ span: label, problem: `content leaked while capture is off: ${key}` });
        }
      }
    }

    for (const key of ["gen_ai.input.messages", "gen_ai.output.messages"] as const) {
      if (attrs[key] !== undefined && isKind(kindValue) && !MESSAGE_ALLOWED_KINDS.has(kindValue)) {
        issues.push({ span: label, problem: `${key} must not appear on a ${kindValue} span` });
      }
      issues.push(...parseMessages(attrs[key], key, label));
    }
    if (attrs["gen_ai.input.messages_delta"] !== undefined) {
      if (kindValue !== "chat") {
        issues.push({
          span: label,
          problem: "gen_ai.input.messages_delta must only appear on a chat span",
        });
      }
      if (attrs["gen_ai.input.messages"] !== undefined) {
        // A span reporting both cannot tell a reader whether the delta is
        // already contained in the full list.
        issues.push({
          span: label,
          problem: "gen_ai.input.messages and messages_delta are mutually exclusive",
        });
      }
      issues.push(
        ...parseMessages(attrs["gen_ai.input.messages_delta"], "gen_ai.input.messages_delta", label),
      );
    }

    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === "string" && secretLike.test(value)) {
        issues.push({ span: label, problem: `unredacted secret in ${key}` });
      }
    }

    if (kindValue === undefined) {
      if (attrs["openclaw.span.kind"] !== "extension") {
        issues.push({ span: label, problem: "span has neither gen_ai.span.kind nor extension mark" });
      }
      validateParentTiming(span, byId, issues);
      continue;
    }
    if (!isKind(kindValue)) {
      issues.push({ span: label, problem: `unknown gen_ai.span.kind: ${String(kindValue)}` });
      continue;
    }

    const contract = CLS_SPAN_CONTRACTS[kindValue];
    const isSubagent = kindValue === "agent" && attrs["gen_ai.agent.scope"] === "subagent";
    if (isSubagent) {
      // Spec §3.9: subagents keep the agent name pattern but carry a distinct
      // operation and hang off the tool call that spawned them.
      if (attrs["gen_ai.operation.name"] !== "invoke_subagent") {
        issues.push({ span: label, problem: "subagent operation.name must be invoke_subagent" });
      }
      for (const key of ["gen_ai.agent.scope", "gen_ai.subagent.parent_tool_call.id"] as const) {
        if (attrs[key] === undefined || attrs[key] === "") {
          issues.push({ span: label, problem: `missing subagent attribute ${key}` });
        }
      }
    } else if (attrs["gen_ai.operation.name"] !== contract.operation) {
      issues.push({
        span: label,
        problem: `operation.name should be ${contract.operation} for kind ${kindValue}`,
      });
    }
    if (!contract.namePattern.test(span.name)) {
      issues.push({ span: label, problem: `invalid ${kindValue} span name` });
    }
    if (span.kind !== contract.otelKind) {
      issues.push({ span: label, problem: `invalid OTel kind for ${kindValue}` });
    }
    for (const key of KIND_REQUIRED[kindValue]) {
      if (attrs[key] === undefined || attrs[key] === "") {
        issues.push({ span: label, problem: `missing ${kindValue} attribute ${key}` });
      }
    }

    const parentId = span.parentSpanContext?.spanId;
    if (kindValue === "entry") {
      if (parentId) {
        issues.push({ span: label, problem: "entry span must be a root" });
      }
    } else if (!parentId) {
      issues.push({ span: label, problem: `non-entry span ${kindValue} has no parent` });
    } else {
      const parent = byId.get(parentId);
      const parentKind = parent ? attrsOf(parent)["gen_ai.span.kind"] : undefined;
      // A subagent's agent span hangs off the sessions_spawn tool call (§3.9),
      // not off the entry span like a top-level agent.
      const expectedParent = isSubagent ? "tool" : contract.allowedParent;
      if (expectedParent && parentKind !== expectedParent) {
        issues.push({
          span: label,
          problem: `${kindValue} parent must be ${expectedParent}, got ${String(parentKind)}`,
        });
      }
    }

    if (kindValue !== "chat" && kindValue !== "tool" && attrs["gen_ai.agent.id"] !== undefined) {
      issues.push({ span: label, problem: `gen_ai.agent.id must not appear on ${kindValue}` });
    }
    if (kindValue === "tool") {
      for (const key of ["gen_ai.tool.call.arguments", "gen_ai.tool.call.result"] as const) {
        if (attrs[key] !== undefined && typeof attrs[key] !== "string") {
          issues.push({ span: label, problem: `${key} must be a string attribute` });
        }
      }
    }
    if (span.status.code === SpanStatusCode.ERROR && attrs["error.type"] === undefined) {
      issues.push({ span: label, problem: "ERROR span must include error.type" });
    }
    issues.push(...validateUsage(attrs, label));
    validateParentTiming(span, byId, issues);
  }

  validateRoundSequence(protocolSpans, issues);
  validateAgentCounts(protocolSpans, issues);
  validateContentPresence(protocolSpans, Boolean(opts.contentEnabled), issues);
  return issues;
}

function validateParentTiming(
  span: ReadableSpan,
  byId: ReadonlyMap<string, ReadableSpan>,
  issues: ValidationIssue[],
): void {
  const parentId = span.parentSpanContext?.spanId;
  if (!parentId) {
    return;
  }
  // A subagent's agent span outlives the sessions_spawn tool call that started
  // it by design — the tool result is just the acceptance receipt.
  if (attrsOf(span)["gen_ai.agent.scope"] === "subagent") {
    return;
  }
  const parent = byId.get(parentId);
  if (parent && toMs(span.endTime) > toMs(parent.endTime) + 1) {
    issues.push({ span: span.name, problem: `child ends after parent ${parent.name}` });
  }
}

function validateRoundSequence(spans: readonly ReadableSpan[], issues: ValidationIssue[]): void {
  // Subagent runs interleave their steps into the same trace under their own
  // turn id, so the round sequence is validated per turn, not per trace.
  const stepsByTurn = new Map<string, ReadableSpan[]>();
  for (const span of spans) {
    if (attrsOf(span)["gen_ai.span.kind"] !== "step") {
      continue;
    }
    const turnId = String(attrsOf(span)["gen_ai.turn.id"] ?? "");
    const group = stepsByTurn.get(turnId) ?? [];
    group.push(span);
    stepsByTurn.set(turnId, group);
  }
  for (const steps of stepsByTurn.values()) {
    steps.sort(
      (left, right) =>
        Number(attrsOf(left)["gen_ai.react.round"]) - Number(attrsOf(right)["gen_ai.react.round"]),
    );
    steps.forEach((step, index) => {
      const expected = index + 1;
      if (attrsOf(step)["gen_ai.react.round"] !== expected) {
        issues.push({ span: step.name, problem: `step rounds must be consecutive from 1; expected ${expected}` });
      }
      const expectedStepIdSuffix = `:s${expected}`;
      const stepId = attrsOf(step)["gen_ai.step.id"];
      if (typeof stepId !== "string" || !stepId.endsWith(expectedStepIdSuffix)) {
        issues.push({ span: step.name, problem: `step id must end with ${expectedStepIdSuffix}` });
      }
    });
  }
}

function validateAgentCounts(spans: readonly ReadableSpan[], issues: ValidationIssue[]): void {
  const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
  // Counts are per agent subtree: a span belongs to the FIRST agent found walking
  // up its ancestors, so a subagent's chats and tools are counted on the subagent
  // span, not folded into the parent agent's totals.
  const belongsTo = (span: ReadableSpan, agentSpanId: string): boolean => {
    let current = span.parentSpanContext?.spanId;
    let hops = 0;
    while (current && hops < 16) {
      const ancestor = byId.get(current);
      if (!ancestor) {
        return false;
      }
      if (attrsOf(ancestor)["gen_ai.span.kind"] === "agent") {
        return current === agentSpanId;
      }
      current = ancestor.parentSpanContext?.spanId;
      hops += 1;
    }
    return false;
  };
  const agents = spans.filter((span) => attrsOf(span)["gen_ai.span.kind"] === "agent");
  for (const agent of agents) {
    const agentSpanId = agent.spanContext().spanId;
    const attrs = attrsOf(agent);
    const chatCount = spans.filter(
      (span) => attrsOf(span)["gen_ai.span.kind"] === "chat" && belongsTo(span, agentSpanId),
    ).length;
    const toolCount = spans.filter(
      (span) => attrsOf(span)["gen_ai.span.kind"] === "tool" && belongsTo(span, agentSpanId),
    ).length;
    if (attrs["gen_ai.agent.message_count"] !== chatCount) {
      issues.push({ span: agent.name, problem: `agent message_count must equal ${chatCount}` });
    }
    if (attrs["gen_ai.agent.tool_call_count"] !== toolCount) {
      issues.push({ span: agent.name, problem: `agent tool_call_count must equal ${toolCount}` });
    }
  }
}

function validateContentPresence(
  spans: readonly ReadableSpan[],
  enabled: boolean,
  issues: ValidationIssue[],
): void {
  if (!enabled) {
    return;
  }
  for (const span of spans) {
    const attrs = attrsOf(span);
    const kind = attrs["gen_ai.span.kind"];
    if (kind === "entry") {
      for (const key of ["gen_ai.input.messages", "gen_ai.output.messages"] as const) {
        if (attrs[key] === undefined) {
          issues.push({ span: span.name, problem: `content enabled but ${key} is missing` });
        }
      }
      // The entry span represents the turn: the question asked and the answer
      // returned. Extra messages here would duplicate the chat spans.
      const expectations = [
        ["gen_ai.input.messages", "user"],
        ["gen_ai.output.messages", "assistant"],
      ] as const;
      for (const [key, role] of expectations) {
        const decoded = decodeMessages(attrs[key]);
        if (decoded && (decoded.length !== 1 || decoded[0]?.role !== role)) {
          issues.push({
            span: span.name,
            problem: `entry ${key} must hold exactly one ${role} message`,
          });
        }
      }
    }
    if (kind === "chat") {
      const hasFull = attrs["gen_ai.input.messages"] !== undefined;
      const hasDelta = attrs["gen_ai.input.messages_delta"] !== undefined;
      if (!hasFull && !hasDelta) {
        issues.push({
          span: span.name,
          problem: "content enabled but chat has neither input messages nor a delta",
        });
      }
      if (attrs["gen_ai.input.messages.hash"] === undefined) {
        issues.push({ span: span.name, problem: "chat input messages require a hash" });
      }
      if (attrs["gen_ai.output.messages"] === undefined) {
        // A failed call produced no output, so only successful chats are held
        // to this rule.
        if (span.status.code !== SpanStatusCode.ERROR) {
          issues.push({ span: span.name, problem: "content enabled but chat output is missing" });
        }
      }
    }
    if (kind === "tool") {
      for (const key of ["gen_ai.tool.call.arguments", "gen_ai.tool.call.result"] as const) {
        if (attrs[key] === undefined) {
          issues.push({ span: span.name, problem: `content enabled but ${key} is missing` });
        }
      }
    }
  }
}

function decodeMessages(value: unknown): { role?: unknown }[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as { role?: unknown }[]) : undefined;
  } catch {
    return undefined;
  }
}

export function toMs(time: [number, number]): number {
  return time[0] * 1000 + time[1] / 1e6;
}
