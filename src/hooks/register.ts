// Translates OpenClaw typed hooks into normalized observation events.
import type { Collector } from "../collector.js";
import type { ClsObservabilityConfig } from "../config.js";
import { serializeForCapture } from "../content/attributes.js";
import type { RunIdentity, HostTrace } from "../domain/types.js";
import { extractSpawnLink } from "./spawn-link.js";

/** Minimal structural view of the OpenClaw hook registration API. */
export type HookRegistrar = {
  on: (hookName: string, handler: (...args: never[]) => unknown, opts?: unknown) => void;
};

type AnyRecord = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;

/** Extracts and validates the host trace context forwarded by OpenClaw. */
function traceFrom(ctx: AnyRecord): HostTrace | undefined {
  const raw = ctx.trace;
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as AnyRecord;
  const traceId = str(candidate.traceId);
  if (!traceId || !HEX_TRACE_ID.test(traceId)) {
    return undefined;
  }
  const spanId = str(candidate.spanId);
  const parentSpanId = str(candidate.parentSpanId);
  return {
    traceId,
    ...(spanId && HEX_SPAN_ID.test(spanId) ? { spanId } : {}),
    ...(parentSpanId && HEX_SPAN_ID.test(parentSpanId) ? { parentSpanId } : {}),
  };
}

function identityFrom(event: AnyRecord, ctx: AnyRecord): RunIdentity | undefined {
  const runId = str(event.runId) ?? str(ctx.runId);
  if (!runId) {
    return undefined;
  }
  const trace = traceFrom(ctx);
  return {
    runId,
    sessionId: str(event.sessionId) ?? str(ctx.sessionId),
    sessionKey: str(event.sessionKey) ?? str(ctx.sessionKey),
    agentId: str(ctx.agentId),
    trigger: str(ctx.trigger),
    channelId: str(ctx.channelId) ?? str(event.channelId),
    senderId: str(event.senderId),
    accountId: str(event.accountId),
    ...(trace ? { trace } : {}),
  };
}

/**
 * Registers every observation hook.
 *
 * All handlers are synchronous and return `undefined` so they never alter agent
 * behaviour, even for hooks that support mutation.
 *
 * Hook names are registered defensively: an older OpenClaw may not know a name
 * (e.g. `before_message_write` predates some deployments), and a failed
 * registration must degrade that capability, not break the plugin.
 */
export function registerObservationHooks(
  api: HookRegistrar,
  collector: Collector,
  config: ClsObservabilityConfig,
): void {
  const unavailable: string[] = [];
  const on: HookRegistrar["on"] = (hookName, handler, opts) => {
    try {
      api.on(hookName, handler, opts);
    } catch {
      unavailable.push(hookName);
    }
  };
  const safe =
    (handler: (event: AnyRecord, ctx: AnyRecord) => void) =>
    (event: unknown, ctx: unknown): undefined => {
      try {
        handler((event ?? {}) as AnyRecord, (ctx ?? {}) as AnyRecord);
      } catch {
        // Observation must never surface an error into the agent run.
      }
      return undefined;
    };

  on(
    "message_received",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      if (!identity) {
        return;
      }
      collector.ingest({ type: "run.activity", at: Date.now(), ...identity });
    }) as never,
  );

  on(
    "before_agent_run",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      if (!identity) {
        return;
      }
      collector.ingest({ type: "run.attempt.started", at: Date.now(), ...identity });
    }) as never,
  );

  on(
    "model_call_started",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      const callId = str(event.callId);
      const provider = str(event.provider);
      const model = str(event.model);
      if (!identity || !callId || !provider || !model) {
        return;
      }
      collector.ingest({
        type: "model.started",
        at: Date.now(),
        callId,
        provider,
        model,
        api: str(event.api),
        transport: str(event.transport),
        contextTokenBudget: num(event.contextTokenBudget),
        ...identity,
      });
    }) as never,
  );

  on(
    "model_call_ended",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      const callId = str(event.callId);
      const provider = str(event.provider);
      const model = str(event.model);
      if (!identity || !callId || !provider || !model) {
        return;
      }
      collector.ingest({
        type: "model.ended",
        at: Date.now(),
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
      });
    }) as never,
  );

  // before_message_write fires when each assistant message is persisted — one
  // per completed model call — and message.usage is that call's exact usage.
  // This is the per-call metering source; llm_output is only the attempt
  // aggregate and must not be attributed to a single call.
  on(
    "before_message_write",
    safe((event, ctx) => {
      const message = event?.message as AnyRecord | undefined;
      if (!message || message.role !== "assistant") {
        return;
      }
      const usage = message.usage as AnyRecord | undefined;
      const cost = usage?.cost as AnyRecord | undefined;
      collector.ingest({
        type: "assistant.persisted",
        at: Date.now(),
        runId: str((event as AnyRecord)?.runId) ?? str((ctx as AnyRecord)?.runId),
        sessionKey: str(event?.sessionKey) ?? str(ctx?.sessionKey),
        agentId: str(event?.agentId) ?? str(ctx?.agentId),
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
      });
      return undefined;
    }) as never,
  );

  on(
    "llm_input",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      const provider = str(event.provider);
      const model = str(event.model);
      if (!identity || !provider || !model) {
  return;
      }
      const history = Array.isArray(event.historyMessages) ? event.historyMessages : undefined;
      const tools = Array.isArray(event.tools) ? event.tools : undefined;
      collector.ingest({
      type: "turn.input.observed",
        at: Date.now(),
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
      });
    }) as never,
  );

  on(
    "llm_output",
    safe((event, ctx) => {
    const identity = identityFrom(event, ctx);
      const provider = str(event.provider);
      const model = str(event.model);
      if (!identity || !provider || !model) {
        return;
      }
      const usage = (event.usage ?? undefined) as AnyRecord | undefined;
   const assistantTexts = Array.isArray(event.assistantTexts)
        ? event.assistantTexts.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      collector.ingest({
        type: "model.turn.observed",
        at: Date.now(),
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
      });
    }) as never,
  );

  on(
    "before_tool_call",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      const toolName = str(event.toolName) ?? str(ctx.toolName);
      const toolCallId = str(event.toolCallId) ?? str(ctx.toolCallId);
      if (!identity || !toolName || !toolCallId) {
        return;
      }
      collector.ingest({
        type: "tool.started",
        at: Date.now(),
        toolCallId,
        toolName,
        toolKind: str(event.toolKind) ?? str(ctx.toolKind),
        toolInputKind: str(event.toolInputKind) ?? str(ctx.toolInputKind),
        arguments: serializeForCapture(config, event.params),
...identity,
      });
    }) as never,
    // Run last so policy plugins decide first; this hook only observes.
    { priority: -1000 },
  );

  on(
    "after_tool_call",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      const toolName = str(event.toolName) ?? str(ctx.toolName);
      const toolCallId = str(event.toolCallId) ?? str(ctx.toolCallId);
      if (!identity || !toolName || !toolCallId) {
        return;
      }
      const resultRecord =
        typeof event.result === "object" && event.result !== null
          ? (event.result as AnyRecord)
          : undefined;
      const details =
        typeof resultRecord?.details === "object" && resultRecord.details !== null
          ? (resultRecord.details as AnyRecord)
          : undefined;
      const exitCode = num(details?.exitCode);
      const resultStatus = str(details?.status);
      collector.ingest({
        type: "tool.ended",
        at: Date.now(),
        toolCallId,
        toolName,
        durationMs: num(event.durationMs),
        errorMessage: str(event.error),
        errorType: str(event.error) ? "tool_error" : undefined,
        result: serializeForCapture(config, event.result),
        ...(exitCode !== undefined || resultStatus
          ? { resultMeta: { exitCode, status: resultStatus } }
          : {}),
        // Spawn linkage is topology metadata, not message content: it must not
        // depend on the content-capture mode, or parallel spawns unlink under
        // the default `off` mode.
        ...(toolName === "sessions_spawn"
          ? { spawnLink: extractSpawnLink(resultRecord) }
          : {}),
        ...identity,
      });
    }) as never,
  );

  on(
    "agent_end",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      if (!identity) {
        return;
      }
      collector.ingest({
        type: "run.attempt.ended",
        at: Date.now(),
        success: event.success !== false,
        errorType: str(event.error) ? "agent_error" : undefined,
        durationMs: num(event.durationMs),
        ...identity,
      });
    }) as never,
  );

  on(
    "after_compaction",
    safe((event, ctx) => {
      const identity = identityFrom(event, ctx);
      if (!identity) {
        return;
      }
      collector.ingest({
        type: "extension.instant",
        at: Date.now(),
        name: "openclaw.session.compaction",
        operation: "compaction",
        attributes: {
          "openclaw.compaction.message_count": num(event.messageCount) ?? -1,
          "openclaw.compaction.compacted_count": num(event.compactedCount) ?? -1,
          "openclaw.compaction.tokens_after": num(event.tokenCount) ?? -1,
        },
        ...identity,
      });
    }) as never,
  );

  // Fired inside the sessions_spawn tool execution, before after_tool_call.
  // The event carries the child identity but no toolCallId, so the domain
  // layer resolves the parent tool call from the tool result.
  on(
    "subagent_spawned",
    safe((event, ctx) => {
      const childSessionKey = str(event.childSessionKey) ?? str(ctx.childSessionKey);
      if (!childSessionKey) {
        return;
      }
      collector.ingest({
        type: "subagent.spawned",
        at: Date.now(),
        childRunId: str(event.runId) ?? str(ctx.runId),
        childSessionKey,
        requesterSessionKey: str(ctx.requesterSessionKey),
        agentId: str(event.agentId),
        label: str(event.label),
        model: str(event.resolvedModel),
        provider: str(event.resolvedProvider),
      });
    }) as never,
  );

  on(
    "subagent_ended",
    safe((event, ctx) => {
      collector.ingest({
        type: "subagent.ended",
        at: Date.now(),
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
      });
    }) as never,
  );

  if (unavailable.length > 0) {
    // One line, once per registry: which capabilities this host cannot provide.
    // before_message_write missing means per-call usage/cost silently absent.
    console.warn(
      `[cls-agent-observability] hooks unavailable on this host, related capabilities degraded: ${unavailable.join(", ")}`,
    );
  }
}
