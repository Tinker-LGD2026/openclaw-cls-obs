// Replays captured real OpenClaw hook traffic through the collector.
import { readFileSync } from "node:fs";
import type { ObservationEvent } from "../domain/types.js";
import { extractSpawnLink } from "../hooks/spawn-link.js";

type ProbeLine = {
  at: number;
  hook: string;
  ctxTrace: { traceId: string; spanId?: string; parentSpanId?: string } | null;
  ctx: Record<string, unknown>;
  event: Record<string, unknown>;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Converts one recorded hook invocation into a normalized observation event.
 *
 * This mirrors `src/hooks/register.ts` so replays exercise the same mapping the
 * plugin uses at runtime, but sourced from real captured payloads rather than
 * hand-written fixtures.
 */
function toEvent(line: ProbeLine): ObservationEvent | undefined {
  const { event, ctx } = line;
  const runId = str(event.runId) ?? str(ctx.runId);
  if (!runId) {
    return undefined;
  }
  const trace = line.ctxTrace
    ? {
        traceId: line.ctxTrace.traceId,
        ...(line.ctxTrace.spanId ? { spanId: line.ctxTrace.spanId } : {}),
        ...(line.ctxTrace.parentSpanId ? { parentSpanId: line.ctxTrace.parentSpanId } : {}),
      }
    : undefined;
  const identity = {
    runId,
    sessionId: str(event.sessionId) ?? str(ctx.sessionId),
    sessionKey: str(event.sessionKey) ?? str(ctx.sessionKey),
    agentId: str(ctx.agentId),
    trigger: str(ctx.trigger),
    channelId: str(ctx.channelId),
    ...(trace ? { trace } : {}),
  };
  const at = line.at;

  switch (line.hook) {
    case "message_received":
      return { type: "run.activity", at, ...identity };
    case "before_agent_run":
      return { type: "run.attempt.started", at, ...identity };
    case "model_call_started": {
      const callId = str(event.callId);
      const provider = str(event.provider);
      const model = str(event.model);
      if (!callId || !provider || !model) {
        return undefined;
      }
      return {
        type: "model.started",
        at,
        callId,
        provider,
        model,
        api: str(event.api),
        transport: str(event.transport),
        contextTokenBudget: num(event.contextTokenBudget),
        ...identity,
      };
    }
    case "model_call_ended": {
      const callId = str(event.callId);
      const provider = str(event.provider);
      const model = str(event.model);
      if (!callId || !provider || !model) {
        return undefined;
      }
      return {
        type: "model.ended",
        at,
        callId,
        provider,
        model,
        outcome: event.outcome === "error" ? "error" : "completed",
        durationMs: num(event.durationMs) ?? 0,
        errorType: str(event.errorCategory),
        failureKind: str(event.failureKind),
        requestBytes: num(event.requestPayloadBytes),
        responseBytes: num(event.responseStreamBytes),
        ttfbMs: num(event.timeToFirstByteMs),
        upstreamRequestIdHash: str(event.upstreamRequestIdHash),
        ...identity,
      };
    }
    case "before_message_write": {
      const message =
        typeof event.message === "object" && event.message !== null
          ? (event.message as Record<string, unknown>)
          : undefined;
      if (!message || message.role !== "assistant") {
        return undefined;
      }
      const usage =
        typeof message.usage === "object" && message.usage !== null
          ? (message.usage as Record<string, unknown>)
          : undefined;
      const cost =
        usage && typeof usage.cost === "object" && usage.cost !== null
          ? (usage.cost as Record<string, unknown>)
          : undefined;
      return {
        type: "assistant.persisted",
        at,
        runId: identity.runId,
        sessionKey: identity.sessionKey,
        agentId: identity.agentId,
        stopReason: str(message.stopReason),
        responseId: str(message.responseId),
        usage: usage
          ? {
              input: num(usage.input),
              output: num(usage.output),
              cacheRead: num(usage.cacheRead),
              cacheWrite: num(usage.cacheWrite),
              total: num(usage.totalTokens ?? usage.total),
              reasoningTokens: num(usage.reasoningTokens),
              ...(cost
                ? {
                    cost: {
                      input: num(cost.input),
                      output: num(cost.output),
                      cacheRead: num(cost.cacheRead),
                      cacheWrite: num(cost.cacheWrite),
                      total: num(cost.total),
                    },
                  }
                : {}),
            }
          : undefined,
      };
    }
    case "llm_input": {
      const provider = str(event.provider);
      const model = str(event.model);
      if (!provider || !model) {
        return undefined;
      }
      const history = Array.isArray(event.historyMessages) ? event.historyMessages : undefined;
      const tools = Array.isArray(event.tools) ? event.tools : undefined;
      return {
        type: "turn.input.observed",
        at,
        provider,
        model,
        input: {
          systemPrompt: str(event.systemPrompt),
          prompt: str(event.prompt),
          history,
          historyMessageCount: history?.length,
          imagesCount: num(event.imagesCount),
          toolCount: tools?.length,
        },
        ...identity,
      };
    }
    case "llm_output": {
      const provider = str(event.provider);
      const model = str(event.model);
      if (!provider || !model) {
        return undefined;
      }
      const usage = (event.usage ?? undefined) as Record<string, unknown> | undefined;
      const assistantTexts = Array.isArray(event.assistantTexts)
        ? event.assistantTexts.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      return {
        type: "model.turn.observed",
        at,
        provider,
        model,
        harnessId: str(event.harnessId),
        resolvedRef: str(event.resolvedRef),
        usage: usage
          ? {
              input: num(usage.input),
              output: num(usage.output),
              cacheRead: num(usage.cacheRead),
              cacheWrite: num(usage.cacheWrite),
              total: num(usage.total),
            }
          : undefined,
        output: assistantTexts ? { assistantTexts } : undefined,
        ...identity,
      };
    }
    case "before_tool_call": {
      const toolName = str(event.toolName) ?? str(ctx.toolName);
      const toolCallId = str(event.toolCallId) ?? str(ctx.toolCallId);
      if (!toolName || !toolCallId) {
        return undefined;
      }
      return {
        type: "tool.started",
        at,
        toolCallId,
        toolName,
        toolKind: str(event.toolKind) ?? str(ctx.toolKind),
        arguments: event.params === undefined ? undefined : JSON.stringify(event.params),
        ...identity,
      };
    }
    case "after_tool_call": {
      const toolName = str(event.toolName) ?? str(ctx.toolName);
      const toolCallId = str(event.toolCallId) ?? str(ctx.toolCallId);
      if (!toolName || !toolCallId) {
        return undefined;
      }
      const resultRecord =
        typeof event.result === "object" && event.result !== null
          ? (event.result as Record<string, unknown>)
          : undefined;
      const details =
        typeof resultRecord?.details === "object" && resultRecord.details !== null
          ? (resultRecord.details as Record<string, unknown>)
          : undefined;
      const exitCode = num(details?.exitCode);
      const resultStatus = str(details?.status);
      return {
        type: "tool.ended",
        at,
        toolCallId,
        toolName,
        durationMs: num(event.durationMs),
        errorMessage: str(event.error),
        errorType: str(event.error) ? "tool_error" : undefined,
        result: event.result === undefined ? undefined : JSON.stringify(event.result),
        ...(exitCode !== undefined || resultStatus
          ? { resultMeta: { exitCode, status: resultStatus } }
          : {}),
        // Mirror the live hook path: spawn linkage is extracted regardless of
        // the replay's content mode.
        ...(toolName === "sessions_spawn"
          ? { spawnLink: extractSpawnLink(resultRecord) }
          : {}),
        ...identity,
      };
    }
    case "agent_end":
      return {
        type: "run.attempt.ended",
        at,
        success: event.success !== false,
        errorType: str(event.error) ? "agent_error" : undefined,
        durationMs: num(event.durationMs),
        ...identity,
      };
    case "subagent_spawned": {
      const childSessionKey = str(event.childSessionKey) ?? str(ctx.childSessionKey);
      if (!childSessionKey) {
        return undefined;
      }
      return {
        type: "subagent.spawned",
        at,
        childRunId: str(event.runId) ?? str(ctx.runId),
        childSessionKey,
        requesterSessionKey: str(ctx.requesterSessionKey),
        agentId: str(event.agentId),
        label: str(event.label),
        model: str(event.resolvedModel),
        provider: str(event.resolvedProvider),
      };
    }
    case "subagent_ended":
      return {
        type: "subagent.ended",
        at,
        childRunId: str(event.runId) ?? str(ctx.runId),
        childSessionKey: str(event.childSessionKey) ?? str(ctx.childSessionKey),
        reason: str(event.reason),
        outcome: str(event.outcome) as
          | "ok"
          | "error"
          | "timeout"
          | "killed"
          | "reset"
          | "deleted"
          | undefined,
        errorMessage: str(event.error),
      };
    case "after_compaction":
      return {
        type: "extension.instant",
        at,
        name: "openclaw.session.compaction",
        operation: "compaction",
        attributes: {
          "openclaw.compaction.message_count": num(event.messageCount) ?? -1,
        },
        ...identity,
      };
    default:
      return undefined;
  }
}

/** Loads a probe capture file and returns normalized observation events. */
export function loadCapture(filePath: string): ObservationEvent[] {
  const raw = readFileSync(filePath, "utf8");
  const events: ObservationEvent[] = [];
  for (const rawLine of raw.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: ProbeLine;
    try {
      parsed = JSON.parse(trimmed) as ProbeLine;
    } catch {
      continue;
    }
    const event = toEvent(parsed);
    if (event) {
      events.push(event);
    }
  }
  return events;
}
