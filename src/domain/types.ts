// Normalized observation events and span commands shared by the domain layer.
import type { ToolResultMeta } from "./tool-outcome.js";

/** CLS Agent Trace span categories. */
export type ClsSpanKind = "entry" | "agent" | "step" | "chat" | "tool";

/** Node categories tracked by the run state machine. */
export type SpanNodeKind = ClsSpanKind | "extension";

export type SpanStatus = "unset" | "ok" | "error";

export type AttributeValue = string | number | boolean | string[];
export type Attributes = Record<string, AttributeValue>;

export type NodeId = string;

/**
 * Trace context reported by OpenClaw.
 *
 * OpenClaw maintains real span ids in async-local storage and forwards them to
 * hooks, so span parentage is read from here instead of being inferred from
 * event ordering. `after_tool_call` is the one observed hook that omits it.
 */
export type HostTrace = {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
};

export type StartSpanCommand = {
  op: "start";
  nodeId: NodeId;
  parentNodeId?: NodeId;
  runId: string;
  name: string;
  kind: SpanNodeKind;
  startTimeMs: number;
  attributes: Attributes;
};

export type UpdateSpanCommand = {
  op: "update";
  nodeId: NodeId;
  attributes: Attributes;
};

export type FinalizeSpanCommand = {
  op: "finalize";
  nodeId: NodeId;
  endTimeMs: number;
  status: SpanStatus;
  statusMessage?: string;
};

export type SpanCommand = StartSpanCommand | UpdateSpanCommand | FinalizeSpanCommand;

export type RunIdentity = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  trigger?: string;
  channelId?: string;
  senderId?: string;
  accountId?: string;
  /** Host trace context, absent on hooks that do not forward it. */
  trace?: HostTrace;
};

export type ObservationEvent =
  | ({ type: "run.activity"; at: number } & RunIdentity)
  | ({ type: "run.attempt.started"; at: number } & RunIdentity)
  | ({
      type: "run.attempt.ended";
      at: number;
      success: boolean;
      errorType?: string;
      durationMs?: number;
    } & RunIdentity)
  | ({
      type: "model.started";
      at: number;
      callId: string;
      provider: string;
      model: string;
      api?: string;
      transport?: string;
      contextTokenBudget?: number;
    } & RunIdentity)
  | ({
      type: "model.ended";
      at: number;
      callId: string;
      provider: string;
      model: string;
      outcome: "completed" | "error";
      durationMs: number;
      errorType?: string;
      failureKind?: string;
      requestBytes?: number;
      responseBytes?: number;
      ttfbMs?: number;
      upstreamRequestIdHash?: string;
    } & RunIdentity)
  | ({
      type: "model.turn.observed";
      at: number;
      provider: string;
      model: string;
      harnessId?: string;
      resolvedRef?: string;
      usage?: TokenUsage;
      finishReason?: string;
      output?: TurnOutputContent;
    } & RunIdentity)
  | {
      /**
       * An assistant message was persisted (before_message_write). Each
       * assistant message corresponds to one completed model call and carries
       * that call's exact usage. The hook context has no runId, so the state
       * machine resolves the active run by session and the call by recency.
       */
      type: "assistant.persisted";
      at: number;
      runId?: string;
      sessionKey?: string;
      agentId?: string;
      stopReason?: string;
      responseId?: string;
      usage?: AssistantUsage;
    }
  | ({
      type: "turn.input.observed";
      at: number;
      provider: string;
      model: string;
      input: TurnInputContent;
    } & RunIdentity)
  | ({
      type: "tool.started";
      at: number;
      toolCallId: string;
      toolName: string;
      toolKind?: string;
      toolInputKind?: string;
      arguments?: string;
    } & RunIdentity)
  | ({
      type: "tool.ended";
      at: number;
      toolCallId: string;
      toolName: string;
      durationMs?: number;
      errorMessage?: string;
      errorType?: string;
      result?: string;
      resultMeta?: ToolResultMeta;
      /**
       * Linkage metadata from a sessions_spawn result. It is topology, not
       * content, so it is extracted regardless of the content-capture mode —
       * otherwise parallel spawns become unlinkable whenever content is off.
       */
      spawnLink?: { childSessionKey: string; childRunId?: string };
    } & RunIdentity)
  | ({
      type: "extension.instant";
      at: number;
      name: string;
      operation: string;
      durationMs?: number;
      attributes?: Attributes;
    } & RunIdentity)
  | ({
      // Fired inside the sessions_spawn tool execution, while the tool span is
      // still open. Carries no toolCallId, so the parent tool call is resolved
      // from the tool result (or the single in-flight sessions_spawn).
      type: "subagent.spawned";
      at: number;
      childRunId?: string;
      childSessionKey: string;
      requesterSessionKey?: string;
      agentId?: string;
      label?: string;
      model?: string;
      provider?: string;
    })
  | ({
      type: "subagent.ended";
      at: number;
      childRunId?: string;
      childSessionKey?: string;
      reason?: string;
      outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
      errorMessage?: string;
    })
  | ({ type: "run.finalize"; at: number; reason: RunEndReason } & RunIdentity);

export type RunEndReason = "attempt_quiescence" | "idle_ttl" | "shutdown";

/**
 * Turn-level model input.
 *
 * OpenClaw exposes prompt content only at the turn boundary, never per model
 * request, so this cannot be attributed to a single chat span.
 */
export type TurnInputContent = {
  systemPrompt?: string;
  prompt?: string;
  /** Structured prior conversation, normalized by the domain layer. */
  history?: readonly unknown[];
  historyMessageCount?: number;
  imagesCount?: number;
  toolCount?: number;
};

export type TurnOutputContent = {
  assistantTexts?: string[];
};

export type TokenUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

/** Price-table cost estimate carried by AssistantMessage.usage.cost. */
export type UsageCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

/**
 * Usage of one completed model call, as persisted on its assistant message.
 * Unlike the `llm_output` aggregate, this is exact per call.
 */
export type AssistantUsage = TokenUsage & {
  reasoningTokens?: number;
  cost?: UsageCost;
};

export type SessionIdentity = {
  clsSessionId: string;
  instanceId?: string;
  lineageDegraded: boolean;
};
