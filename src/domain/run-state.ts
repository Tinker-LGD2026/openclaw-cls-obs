// Run-scoped state machine that mirrors OpenClaw's real span tree onto CLS spans.
import type { ClsObservabilityConfig } from "../config.js";
import {
  buildInputContentAttributes,
  buildOutputContentAttributes,
  buildToolArgumentAttributes,
  buildToolResultAttributes,
  renderMessages,
} from "../content/attributes.js";
import {
  announceTurnAttributes,
  buildCommonAttributes,
  normalizeErrorType,
  resolveEntryType,
  withClsKind,
  withExtensionKind,
} from "../mapping/attributes.js";
import { parseSpawnLinkText } from "../hooks/spawn-link.js";
import {
  buildTurnMessages,
  canonicalToolCallId,
  MessageCursor,
  roundMessages,
} from "./conversation.js";
import { decideRoundForModel, deriveRoundFinishReason } from "./rounds.js";
import { classifyToolOutcome } from "./tool-outcome.js";
import { callUsageAttributes, normalizeUsage, usageAttributes } from "./usage.js";
import {
  type ClsMessage,
  encodeMessages,
  messagesHash,
  toolCallMessage,
} from "../protocol/messages.js";
import type { SessionRegistry } from "./session-registry.js";
import type {
  Attributes,
  NodeId,
  ObservationEvent,
  RunIdentity,
  SessionIdentity,
  SpanCommand,
  SpanStatus,
  TokenUsage,
} from "./types.js";

export type RunStateLimits = {
  maxActiveRuns: number;
  maxStepsPerRun: number;
  maxModelsPerRun: number;
  maxToolsPerRun: number;
  runIdleMs: number;
  attemptQuiescenceMs: number;
  /** Sessions whose delta cursor is retained; each entry holds a count + hash. */
  maxCursorSessions: number;
};

// Defaults are sized from real long-running agentic tasks, not nominal ones:
// a coding or research run routinely exceeds a few hundred ReAct rounds, and
// the per-record overhead is a few hundred bytes plus shared string references,
// so these caps cost ~1MB of metadata per run while staying out of the way.
export const DEFAULT_LIMITS: RunStateLimits = {
  maxActiveRuns: 1024,
  maxStepsPerRun: 2_048,
  maxModelsPerRun: 4_096,
  maxToolsPerRun: 4_096,
  runIdleMs: 2 * 60 * 60 * 1000,
  attemptQuiescenceMs: 5_000,
  maxCursorSessions: 2_048,
};

/** One semantic ReAct round synthesized from model/tool transitions. */
type StepRecord = {
  nodeId: NodeId;
  hostSpanId?: string;
  round: number;
  modelCalls: number;
  successfulModelCalls: number;
  toolCalls: number;
  failedModelCalls: number;
  finishReason?: string;
  inference?: "host_transition" | "ambiguous_no_tool_transition" | "synthetic";
  startTimeMs: number;
  lastActivityMs: number;
  finalized: boolean;
};

type ChatRecord = {
  nodeId: NodeId;
  stepNodeId: NodeId;
  provider: string;
  model: string;
  startTimeMs: number;
  observedEndTimeMs?: number;
  status?: SpanStatus;
  statusMessage?: string;
  /** Exact per-call usage attributed from the persisted assistant message. */
  callUsageAttrs?: Attributes;
  finalized: boolean;
};

type ToolRecord = {
  nodeId: NodeId;
  stepNodeId: NodeId;
  toolCallId: string;
  toolName: string;
  argumentsText?: string;
  resultText?: string;
  startTimeMs: number;
  finalized: boolean;
};

/** A subagent_spawned notification whose parent tool call is not resolved yet. */
type PendingSpawn = {
  childRunId?: string;
  childSessionKey: string;
  requesterSessionKey?: string;
  agentId?: string;
  label?: string;
  model?: string;
  provider?: string;
  at: number;
};

/**
 * The binding between a child subagent run and the sessions_spawn tool call that
 * created it. The child agent span hangs off that tool span, which belongs to a
 * different (parent) run, so everything the child needs is snapshotted here.
 */
type SubagentLink = {
  childRunId?: string;
  childSessionKey: string;
  parentRunId: string;
  parentToolCallId: string;
  parentToolNodeId: NodeId;
  agentNodeId: NodeId;
  agentName: string;
  /** Task title from sessions_spawn (label/taskName) — the human-meaningful name. */
  label?: string;
  model?: string;
  provider?: string;
  /** Parent identity snapshot — user/channel fields are inherited from it. */
  parentIdentity: RunIdentity;
  /** Parent session snapshot — the child shares session.id with the parent turn. */
  session: SessionIdentity;
  /** The child's own turn number within that session, allocated at link time. */
  turnId: string;
  emitted: boolean;
  runAttached: boolean;
  createdAtMs: number;
};

type RunRecord = {
  identity: RunIdentity;
  session: SessionIdentity;
  /** `{sessionId}:t{N}` — the turn half of the spec's id chain. */
  turnId: string;
  entryNodeId: NodeId;
  agentNodeId: NodeId;
  /** Set for runs spawned via sessions_spawn; entryNodeId aliases agentNodeId. */
  subagentLink?: SubagentLink;
  /** Host span id of the agent-level scope, used to detect step spans. */
  agentHostSpanId?: string;
  stepOrder: StepRecord[];
  currentStep?: StepRecord;
  chats: Map<string, ChatRecord>;
  tools: Map<string, ToolRecord>;
  usage: TokenUsage;
  usageSamples: number;
  attemptCount: number;
  chatSpanCount: number;
  toolCallCount: number;
  lastProvider?: string;
  lastModel?: string;
  /** Most recent model call id — the alignment key for assistant.persisted. */
  lastCallId?: string;
  /** Call ids whose per-call usage is already attributed (dedupe). */
  attributedCallIds: Set<string>;
  harnessId?: string;
  resolvedRef?: string;
  outcome?: { success: boolean; errorType?: string };
  /** Full model conversation reconstructed from hook payloads. */
  conversation: ClsMessage[];
  /** Tool calls of the round that has not been folded in yet. */
  pendingRoundTools: {
    toolCallId: string;
    toolName: string;
    argumentsText?: string;
    resultText?: string;
  }[];
  hasModelSpan: boolean;
  degradedReasons: Set<string>;
  createdAtMs: number;
  lastActivityMs: number;
  pendingFinalizeAtMs?: number;
  finalized: boolean;
};

/**
 * Owns all live run state and produces span commands.
 *
 * The reducer is fully synchronous so fire-and-forget hooks can never interleave
 * a partially applied state transition.
 */
export class RunStateMachine {
  private readonly runs = new Map<string, RunRecord>();
  private readonly messageCursor: MessageCursor;
  private readonly tombstones = new Map<string, number>();
  private readonly pendingSpawns = new Map<string, PendingSpawn>();
  private readonly subagentLinksByRunId = new Map<string, SubagentLink>();
  private readonly subagentLinksBySessionKey = new Map<string, SubagentLink>();
  private nodeSeq = 0;
  private droppedRuns = 0;
  private orphanEvents = 0;

  constructor(
    private readonly config: ClsObservabilityConfig,
    private readonly sessions: SessionRegistry,
    private readonly limits: RunStateLimits = DEFAULT_LIMITS,
  ) {
    this.messageCursor = new MessageCursor(limits.maxCursorSessions);
  }

  get stats(): { activeRuns: number; droppedRuns: number; orphanEvents: number } {
    return {
      activeRuns: this.runs.size,
      droppedRuns: this.droppedRuns,
      orphanEvents: this.orphanEvents,
    };
  }

  apply(event: ObservationEvent): SpanCommand[] {
    // Subagent lifecycle events carry childRunId rather than runId, so they are
    // dispatched before the run-scoped tombstone check.
    if (event.type === "subagent.spawned") {
      return this.onSubagentSpawned(event);
    }
    if (event.type === "subagent.ended") {
      return this.onSubagentEnded(event);
    }

    // assistant.persisted may carry no runId (the hook context lacks one);
    // the tombstone check only applies to run-scoped events.
    if (event.runId !== undefined && this.tombstones.has(event.runId)) {
      this.orphanEvents += 1;
      return [];
    }

    switch (event.type) {
      case "run.activity":
      case "run.attempt.started": {
        const commands: SpanCommand[] = [];
        const run = this.ensureRun(event, commands);
        if (!run) {
          return commands;
        }
        if (event.type === "run.attempt.started") {
          run.attemptCount += 1;
          run.pendingFinalizeAtMs = undefined;
        }
        return commands;
      }

      case "run.attempt.ended": {
        const run = this.runs.get(event.runId);
        if (!run) {
          this.orphanEvents += 1;
          return [];
        }
        run.lastActivityMs = event.at;
        run.outcome = { success: event.success, errorType: event.errorType };
        // The outer runner may still retry, so only arm a quiescence timer here.
        run.pendingFinalizeAtMs = event.at + this.limits.attemptQuiescenceMs;
        return [];
      }

      case "model.started":
        return this.onModelStarted(event);

      case "model.ended":
        return this.onModelEnded(event);

      case "model.turn.observed":
        return this.onModelTurnObserved(event);

      case "assistant.persisted":
        return this.onAssistantPersisted(event);

      case "turn.input.observed":
        return this.onTurnInputObserved(event);

      case "tool.started":
        return this.onToolStarted(event);

      case "tool.ended":
        return this.onToolEnded(event);

      case "extension.instant":
        return this.onExtensionInstant(event);

      case "run.finalize":
        return this.finalizeRun(event.runId, event.at, event.reason);

      default:
        return [];
    }
  }

  sweep(now: number): SpanCommand[] {
    const commands: SpanCommand[] = [];
    for (const [runId, run] of this.runs) {
      if (run.pendingFinalizeAtMs !== undefined && now >= run.pendingFinalizeAtMs) {
        commands.push(...this.finalizeRun(runId, now, "attempt_quiescence"));
        continue;
      }
      if (now - run.lastActivityMs > this.limits.runIdleMs) {
        commands.push(...this.finalizeRun(runId, now, "idle_ttl"));
      }
    }
    for (const [runId, expiry] of this.tombstones) {
      if (now > expiry) {
        this.tombstones.delete(runId);
      }
    }
    // Orphan subagent spans: emitted but the child run never started and no
    // subagent_ended arrived (e.g. a gateway restart between hooks).
    const orphanSpawnMs = 5 * 60 * 1000;
    for (const link of [...this.subagentLinksBySessionKey.values()]) {
      if (!link.runAttached && link.emitted && now - link.createdAtMs > orphanSpawnMs) {
        commands.push({
          op: "update",
          nodeId: link.agentNodeId,
          attributes: this.emptySubagentCounts(),
        });
        commands.push({
          op: "finalize",
          nodeId: link.agentNodeId,
          endTimeMs: now,
          status: "unset",
        });
        this.dropSubagentLink(link);
      }
    }
    for (const [key, pending] of this.pendingSpawns) {
      if (now - pending.at > orphanSpawnMs) {
        this.pendingSpawns.delete(key);
      }
    }
    return commands;
  }

  drain(now: number): SpanCommand[] {
    const commands: SpanCommand[] = [];
    for (const runId of [...this.runs.keys()]) {
      commands.push(...this.finalizeRun(runId, now, "shutdown"));
    }
    return commands;
  }

  private ensureRun(
    identity: RunIdentity & { at: number },
    out: SpanCommand[],
  ): RunRecord | undefined {
    const existing = this.runs.get(identity.runId);
    if (existing) {
      existing.lastActivityMs = identity.at;
      this.mergeIdentity(existing, identity);
      return existing;
    }
    if (this.runs.size >= this.limits.maxActiveRuns) {
      this.droppedRuns += 1;
      return undefined;
    }

    // A run created by sessions_spawn attaches to the agent span that was opened
    // when the spawn was linked, instead of starting a fresh entry/agent pair.
    const subagentLink =
      this.subagentLinksByRunId.get(identity.runId) ??
      (identity.sessionKey
        ? this.subagentLinksBySessionKey.get(identity.sessionKey)
        : undefined);
    if (subagentLink) {
      if (!subagentLink.emitted) {
        out.push(...this.emitSubagentSpan(subagentLink, identity.at));
      }
      subagentLink.runAttached = true;
      const subagentRun: RunRecord = {
        identity: {
          ...identity,
          senderId: identity.senderId ?? subagentLink.parentIdentity.senderId,
          accountId: identity.accountId ?? subagentLink.parentIdentity.accountId,
          channelId: identity.channelId ?? subagentLink.parentIdentity.channelId,
          trigger: identity.trigger ?? subagentLink.parentIdentity.trigger,
        },
        session: subagentLink.session,
        turnId: subagentLink.turnId,
        entryNodeId: subagentLink.agentNodeId,
        agentNodeId: subagentLink.agentNodeId,
        subagentLink,
        stepOrder: [],
        chats: new Map(),
        tools: new Map(),
        usage: {},
        usageSamples: 0,
        attemptCount: 0,
        chatSpanCount: 0,
        toolCallCount: 0,
        conversation: [],
        pendingRoundTools: [],
        hasModelSpan: false,
        attributedCallIds: new Set(),
        degradedReasons: new Set(),
        createdAtMs: identity.at,
        lastActivityMs: identity.at,
        finalized: false,
      };
      if (identity.trace?.spanId && !identity.trace.parentSpanId) {
        subagentRun.agentHostSpanId = identity.trace.spanId;
      }
      this.runs.set(identity.runId, subagentRun);
      return subagentRun;
    }

    const session = this.sessions.resolve({
      sessionKey: identity.sessionKey,
      sessionId: identity.sessionId,
      now: identity.at,
    });
    const turnId = this.sessions.allocateTurnId(session.clsSessionId, identity.at);
    const common = buildCommonAttributes({
      config: this.config,
      identity,
      session,
      turnId,
    });

    const entryNodeId = this.nextNodeId("entry");
    const agentNodeId = this.nextNodeId("agent");
    const agentName = identity.agentId ?? "main";

    const run: RunRecord = {
      identity: { ...identity },
      session,
      turnId,
      entryNodeId,
      agentNodeId,
      stepOrder: [],
      chats: new Map(),
      tools: new Map(),
      usage: {},
      usageSamples: 0,
      attemptCount: 0,
      chatSpanCount: 0,
      toolCallCount: 0,
      conversation: [],
      pendingRoundTools: [],
      hasModelSpan: false,
      attributedCallIds: new Set(),
      degradedReasons: new Set(),
      createdAtMs: identity.at,
      lastActivityMs: identity.at,
      finalized: false,
    };
    // Agent-level hooks all report the same host span id; recording it lets
    // deeper spans be recognized as step scopes rather than agent scopes.
    if (identity.trace?.spanId && !identity.trace.parentSpanId) {
      run.agentHostSpanId = identity.trace.spanId;
    }
    this.runs.set(identity.runId, run);

    out.push({
      op: "start",
      nodeId: entryNodeId,
      runId: identity.runId,
      name: "enter_application",
      kind: "entry",
      startTimeMs: identity.at,
      attributes: withClsKind(
        {
          ...common,
          "gen_ai.entry.type": resolveEntryType(identity),
          ...(identity.channelId ? { "gen_ai.entry.channel_id": identity.channelId } : {}),
          ...announceTurnAttributes(identity.runId),
        },
        "entry",
      ),
    });
    out.push({
      op: "start",
      nodeId: agentNodeId,
      parentNodeId: entryNodeId,
      runId: identity.runId,
      name: `invoke_agent ${agentName}`,
      kind: "agent",
      startTimeMs: identity.at,
      attributes: withClsKind({ ...common, "gen_ai.agent.name": agentName }, "agent"),
    });
    return run;
  }

  // -- subagent orchestration ------------------------------------------

  /**
   * Records a spawn and, when the parent tool call is unambiguous, links the
   * child immediately. `subagent_spawned` fires inside the sessions_spawn tool
   * execution, so an in-flight sessions_spawn tool span is still open.
   */
  private onSubagentSpawned(
    event: Extract<ObservationEvent, { type: "subagent.spawned" }>,
  ): SpanCommand[] {
    const pending: PendingSpawn = {
      childRunId: event.childRunId,
      childSessionKey: event.childSessionKey,
      requesterSessionKey: event.requesterSessionKey,
      agentId: event.agentId,
      label: event.label,
      model: event.model,
      provider: event.provider,
      at: event.at,
    };
    this.pendingSpawns.set(event.childSessionKey, pending);

    const parentRun = this.findRequesterRun(event.requesterSessionKey);
    if (!parentRun) {
      return [];
    }
    const inFlight = [...parentRun.tools.values()].filter(
      (tool) => tool.toolName === "sessions_spawn" && !tool.finalized,
    );
    if (inFlight.length !== 1) {
      // Parallel spawns: the tool result, which carries childSessionKey, is the
      // only unambiguous link source and arrives at tool.ended.
      return [];
    }
    const link = this.createSubagentLink(pending, parentRun, inFlight[0] as ToolRecord);
    this.pendingSpawns.delete(event.childSessionKey);
    return this.emitSubagentSpan(link, event.at);
  }

  private findRequesterRun(requesterSessionKey: string | undefined): RunRecord | undefined {
    if (!requesterSessionKey) {
      return undefined;
    }
    for (const run of this.runs.values()) {
      if (!run.finalized && run.identity.sessionKey === requesterSessionKey) {
        return run;
      }
    }
    return undefined;
  }

  private createSubagentLink(
    pending: PendingSpawn,
    parentRun: RunRecord,
    parentTool: ToolRecord,
  ): SubagentLink {
    const link: SubagentLink = {
      childRunId: pending.childRunId,
      childSessionKey: pending.childSessionKey,
      parentRunId: parentRun.identity.runId,
      parentToolCallId: parentTool.toolCallId,
      parentToolNodeId: parentTool.nodeId,
      agentNodeId: this.nextNodeId("agent"),
      agentName: pending.agentId ?? parentRun.identity.agentId ?? "main",
      label: pending.label,
      model: pending.model,
      provider: pending.provider,
      parentIdentity: { ...parentRun.identity },
      session: parentRun.session,
      turnId: this.sessions.allocateTurnId(parentRun.session.clsSessionId, pending.at),
      emitted: false,
      runAttached: false,
      createdAtMs: pending.at,
    };
    if (link.childRunId) {
      this.subagentLinksByRunId.set(link.childRunId, link);
    }
    this.subagentLinksBySessionKey.set(link.childSessionKey, link);
    return link;
  }

  /** Opens the invoke_subagent agent span as a child of the sessions_spawn tool span. */
  private emitSubagentSpan(link: SubagentLink, at: number): SpanCommand[] {
    const attrs = withClsKind(
      {
        ...buildCommonAttributes({
          config: this.config,
          // The user of a subagent turn is the user of the parent turn.
          identity: {
            ...link.parentIdentity,
            runId: link.childRunId ?? link.parentIdentity.runId,
            agentId: link.agentName,
          },
          session: link.session,
          turnId: link.turnId,
        }),
        "gen_ai.agent.name": link.agentName,
        "gen_ai.agent.scope": "subagent",
        "gen_ai.subagent.parent_tool_call.id": canonicalToolCallId(link.parentToolCallId),
        // Subagents default to the caller's agentId, so the spec-conformant span
        // name is often identical to the parent's. The task label is the only
        // human-meaningful discriminator; the spec has no field for it.
        ...(link.label ? { "openclaw.subagent.label": link.label } : {}),
        ...providerAttributes(link.provider ?? "unknown"),
        ...(link.model ? { "gen_ai.request.model": link.model } : {}),
      },
      "agent",
    );
    // The spec keeps the span name "invoke_agent {name}" but distinguishes the
    // operation for subagents.
    attrs["gen_ai.operation.name"] = "invoke_subagent";
    link.emitted = true;
    return [
      {
        op: "start",
        nodeId: link.agentNodeId,
        parentNodeId: link.parentToolNodeId,
        runId: link.childRunId ?? link.parentRunId,
        name: `invoke_agent ${link.agentName}`,
        kind: "agent",
        startTimeMs: at,
        attributes: attrs,
      },
    ];
  }

  /**
   * Links a child from the sessions_spawn tool result — the only ambiguity-free
   * source when several spawns are in flight at once. Must run before the tool
   * span is finalized so the child can attach to it.
   */
  private linkSubagentFromToolResult(
    run: RunRecord,
    tool: ToolRecord,
    resultText: string | undefined,
    spawnLink: { childSessionKey: string; childRunId?: string } | undefined,
  ): SpanCommand[] {
    // The hook layer extracts the linkage keys regardless of content mode, so
    // they are authoritative; parsing the (possibly truncated or absent) result
    // text is only a fallback for events produced without them.
    let childSessionKey = spawnLink?.childSessionKey;
    let childRunId = spawnLink?.childRunId;
    if (!childSessionKey && resultText) {
      const fromText = parseSpawnLinkText(resultText);
      childSessionKey = fromText?.childSessionKey;
      childRunId = fromText?.childRunId;
    }
    if (!childSessionKey) {
      return [];
    }

    const existing = this.subagentLinksBySessionKey.get(childSessionKey);
    if (existing) {
      // Fast path already linked and emitted; only the result can supply the
      // child runId, so bind it for ensureRun.
      if (childRunId && !existing.childRunId) {
        existing.childRunId = childRunId;
        this.subagentLinksByRunId.set(childRunId, existing);
      }
      this.pendingSpawns.delete(childSessionKey);
      return [];
    }

    const pending = this.pendingSpawns.get(childSessionKey) ?? {
      childSessionKey,
      childRunId,
      // The spawn happened during this tool's execution, so its start is the
      // best available timestamp when the spawned hook was never observed.
      at: tool.startTimeMs,
    };
    if (childRunId && !pending.childRunId) {
      pending.childRunId = childRunId;
    }
    const link = this.createSubagentLink(pending, run, tool);
    this.pendingSpawns.delete(childSessionKey);
    return this.emitSubagentSpan(link, pending.at);
  }

  private onSubagentEnded(
    event: Extract<ObservationEvent, { type: "subagent.ended" }>,
  ): SpanCommand[] {
    const link =
      (event.childRunId ? this.subagentLinksByRunId.get(event.childRunId) : undefined) ??
      (event.childSessionKey
        ? this.subagentLinksBySessionKey.get(event.childSessionKey)
        : undefined);
    if (!link) {
      // The child run may already be finalized (its link is dropped then), which
      // makes a late subagent_ended purely informational.
      return [];
    }
    const failed = event.outcome !== undefined && event.outcome !== "ok";
    const errorType = failed ? `subagent_${event.outcome}` : undefined;
    const statusMessage = event.errorMessage ?? (failed ? event.reason : undefined);

    const childRun = event.childRunId ? this.runs.get(event.childRunId) : undefined;
    if (childRun && !childRun.finalized) {
      if (failed) {
        childRun.outcome = { success: false, errorType };
      }
      return this.finalizeRun(childRun.identity.runId, event.at, event.reason ?? "subagent_ended");
    }

    if (link.emitted && !link.runAttached) {
      // spawn-failed: the span was opened but no child run ever started.
      const commands: SpanCommand[] = [];
      commands.push({
        op: "update",
        nodeId: link.agentNodeId,
        attributes: {
          ...this.emptySubagentCounts(),
          ...(errorType ? { "error.type": errorType } : {}),
        },
      });
      commands.push({
        op: "finalize",
        nodeId: link.agentNodeId,
        endTimeMs: event.at,
        status: failed ? "error" : "ok",
        statusMessage,
      });
      this.dropSubagentLink(link);
      return commands;
    }
    return [];
  }

  private dropSubagentLink(link: SubagentLink): void {
    if (link.childRunId) {
      this.subagentLinksByRunId.delete(link.childRunId);
    }
    this.subagentLinksBySessionKey.delete(link.childSessionKey);
  }

  /** Zeroed aggregation for subagent spans that close before any child run started. */
  private emptySubagentCounts(): Attributes {
    return {
      "gen_ai.agent.message_count": 0,
      "gen_ai.agent.tool_call_count": 0,
      "openclaw.usage.unavailable": true,
      ...usageAttributes(normalizeUsage({ input: 0, output: 0 })),
    };
  }

  /** Opens one CLS ReAct round. Host ids are retained only for correlation. */
  private startStep(
    run: RunRecord,
    hostSpanId: string | undefined,
    at: number,
    out: SpanCommand[],
    inference?: StepRecord["inference"],
  ): StepRecord | undefined {
    if (run.stepOrder.length >= this.limits.maxStepsPerRun) {
      // Returning the current step here would hand back an already-finalized
      // node: the caller closes it before asking for a new step, and the
      // emitter silently re-roots any child of an ended node as a new trace.
      // Attaching to the agent span degrades the shape, not the integrity.
      run.degradedReasons.add("step_limit_reached");
      return undefined;
    }
    const round = run.stepOrder.length + 1;
    const step: StepRecord = {
      nodeId: this.nextNodeId("step"),
      hostSpanId,
      round,
      modelCalls: 0,
      successfulModelCalls: 0,
      toolCalls: 0,
      failedModelCalls: 0,
      inference,
      startTimeMs: at,
      lastActivityMs: at,
      finalized: false,
    };
    run.stepOrder.push(step);
    run.currentStep = step;

    const attrs: Attributes = withClsKind(
      {
        ...this.commonFor(run),
        "gen_ai.step.id": this.stepId(run, step),
        "gen_ai.react.round": round,
      },
      "step",
    );
    if (hostSpanId) {
      attrs["openclaw.host.span_id"] = hostSpanId;
    }
    if (inference) {
      attrs["openclaw.step.inference"] = inference;
    }
    if (inference === "ambiguous_no_tool_transition" || inference === "synthetic") {
      attrs["openclaw.observation.degraded"] = true;
    }

    out.push({
      op: "start",
      nodeId: step.nodeId,
      parentNodeId: run.agentNodeId,
      runId: run.identity.runId,
      name: `react round_${round}`,
      kind: "step",
      startTimeMs: at,
      attributes: attrs,
    });
    return step;
  }

  private closeStep(step: StepRecord, at: number, out: SpanCommand[]): void {
    if (step.finalized) {
      return;
    }
    step.finalized = true;
    step.finishReason = step.finishReason ?? deriveRoundFinishReason(step);
    out.push({ op: "update", nodeId: step.nodeId, attributes: this.stepSummaryAttributes(step) });
    out.push({
      op: "finalize",
      nodeId: step.nodeId,
      endTimeMs: Math.max(step.lastActivityMs, at, step.startTimeMs),
      status: step.failedModelCalls > 0 && step.modelCalls === step.failedModelCalls ? "error" : "ok",
    });
  }

  /**
   * Folds a finished tool round into the conversation.
   *
   * The model sees one assistant message carrying every tool call of the round
   * followed by the responses, so the round is appended as a unit rather than
   * per tool; interleaving would misrepresent parallel calls.
   */
  private flushRoundIntoConversation(run: RunRecord): void {
    if (run.pendingRoundTools.length === 0) {
      return;
    }
    run.conversation.push(...roundMessages(run.pendingRoundTools));
    run.pendingRoundTools = [];
  }

  /**
   * Reports the model input for one chat span.
   *
   * The whole conversation is reported once per session and later calls carry
   * only what they added, which is the increment the CLS protocol describes.
   * The hash always covers the full conversation so a delta can still be tied
   * back to the state it extends.
   */
  private chatInputAttributes(run: RunRecord): Attributes {
    if (this.config.contentMode === "off" || run.conversation.length === 0) {
      return {};
    }
    // The cursor and the fingerprint operate on the raw conversation, not the
    // rendered one: truncation is a display concern, and fingerprinting
    // truncated text would make the chain depend on the truncation algorithm —
    // live-captured and host-replayed text were truncated differently, which
    // reset the delta chain on every long tool payload (review D-5).
    //
    // Consequence: `gen_ai.input.messages.hash` identifies the actual model
    // context. It cannot be recomputed from the stored (truncated) messages.
    const raw = run.conversation;
    // Subagent runs share the parent's session.id, so they must not advance the
    // same delta cursor — each child gets its own chain keyed by run id.
    const cursorKey = run.subagentLink
      ? `${run.session.clsSessionId}#${run.identity.runId}`
      : run.session.clsSessionId;
    const decision =
      this.config.inputMessagesMode === "full"
        ? { mode: "full" as const, start: 0 }
        : this.messageCursor.next(cursorKey, raw);

    const attrs: Attributes = {
      "gen_ai.input.messages.hash": messagesHash(raw),
      "openclaw.input.message_count": raw.length,
    };
    const toReport =
      decision.mode === "full" ? raw : raw.slice(decision.start);
    if (toReport.length === 0) {
      return attrs;
    }
    const rendered = renderMessages(this.config, toReport);
    if (rendered.messages.length === 0) {
      return attrs;
    }
    if (decision.mode === "full") {
      attrs["gen_ai.input.messages"] = encodeMessages(rendered.messages);
      if (decision.reason && decision.reason !== "first_report") {
        // A delta was expected here; recording why it was unsafe turns a silent
        // storage regression into something queryable.
        attrs["openclaw.input.delta_reset"] = decision.reason;
      }
    } else {
      attrs["gen_ai.input.messages_delta"] = encodeMessages(rendered.messages);
      attrs["openclaw.input.delta_start"] = decision.start;
    }
    if (rendered.redactedLabels.length > 0) {
      attrs["openclaw.input.redacted"] = true;
      attrs["openclaw.input.redacted_types"] = rendered.redactedLabels;
    }
    if (rendered.truncated) {
      attrs["openclaw.input.truncated"] = true;
    }
    return attrs;
  }

  private toolCallOutputAttributes(run: RunRecord, step: StepRecord): Attributes {
    if (this.config.contentMode === "off") {
      return {};
    }
    const calls = [...run.tools.values()]
      .filter((tool) => tool.stepNodeId === step.nodeId)
      .map((tool) =>
        toolCallMessage(
          canonicalToolCallId(tool.toolCallId),
          tool.toolName,
          tool.argumentsText ?? "{}",
        ),
      );
    if (calls.length === 0) {
      return {};
    }
    return { "gen_ai.output.messages": encodeMessages(calls) };
  }

  private finalizePendingChat(
    run: RunRecord,
    step: StepRecord | undefined,
    finishReason: "tool_calls" | "stop",
    out: SpanCommand[],
    outputAttrs: Attributes = {},
  ): void {
    if (!step) {
      return;
    }
    const pending = [...run.chats.values()]
      .reverse()
      .find(
        (chat) =>
          chat.stepNodeId === step.nodeId &&
          !chat.finalized &&
          chat.observedEndTimeMs !== undefined &&
          chat.status === "ok",
      );
    if (!pending || pending.observedEndTimeMs === undefined) {
      return;
    }
    pending.finalized = true;
    out.push({
      op: "update",
      nodeId: pending.nodeId,
      attributes: {
        ...(finishReason === "tool_calls" ? this.toolCallOutputAttributes(run, step) : {}),
        // Per-call usage attributed before this point must survive finalization
        // even if the live update command landed after the span ended.
        ...(pending.callUsageAttrs ?? {}),
        ...outputAttrs,
        "gen_ai.response.finish_reasons": [finishReason],
        "gen_ai.react.finish_reason": finishReason,
      },
    });
    out.push({
      op: "finalize",
      nodeId: pending.nodeId,
      endTimeMs: pending.observedEndTimeMs,
      status: "ok",
    });
  }

  /** Resolves the semantic round for an arriving model attempt. */
  private resolveStepForModel(
    run: RunRecord,
    hostSpanId: string | undefined,
    at: number,
    out: SpanCommand[],
  ): StepRecord | undefined {
    const current = run.currentStep;
    const decision = decideRoundForModel(current);
    if (decision.action === "reuse" && current) {
      current.lastActivityMs = at;
      return current;
    }
    if (current) {
      this.finalizePendingChat(run, current, current.toolCalls > 0 ? "tool_calls" : "stop", out);
      this.closeStep(current, at, out);
    }
    this.flushRoundIntoConversation(run);
    if (decision.ambiguous) {
      run.degradedReasons.add("ambiguous_no_tool_transition");
    }
    return this.startStep(
      run,
      hostSpanId,
      at,
      out,
      decision.ambiguous ? "ambiguous_no_tool_transition" : "host_transition",
    );
  }

  private resolveStepForTool(
    run: RunRecord,
    hostSpanId: string | undefined,
    at: number,
    out: SpanCommand[],
  ): StepRecord | undefined {
    if (run.currentStep && !run.currentStep.finalized) {
      run.currentStep.lastActivityMs = at;
      return run.currentStep;
    }
    run.degradedReasons.add("tool_without_model_round");
    return this.startStep(run, hostSpanId, at, out, "synthetic");
  }

  private onModelStarted(
    event: Extract<ObservationEvent, { type: "model.started" }>,
  ): SpanCommand[] {
    const commands: SpanCommand[] = [];
    const run = this.ensureRun(event, commands);
    if (!run) {
      return commands;
    }
    if (run.chats.size >= this.limits.maxModelsPerRun) {
      run.degradedReasons.add("model_limit_reached");
      return commands;
    }

    // Host trace ids identify the physical turn scope; CLS rounds are semantic
    // model/tool cycles and are resolved from the event transition sequence.
    const step = this.resolveStepForModel(run, event.trace?.parentSpanId, event.at, commands);
    const parentNodeId = step?.nodeId ?? run.agentNodeId;
    if (!step) {
      run.degradedReasons.add("model_without_step");
    }

    const nodeId = this.nextNodeId("chat");
    run.lastProvider = event.provider;
    run.lastModel = event.model;
    run.lastCallId = event.callId;
    run.hasModelSpan = true;
    run.chatSpanCount += 1;
    if (step) {
      step.modelCalls += 1;
    }

    const attrs: Attributes = withClsKind(
      {
        ...this.commonFor(run),
        "gen_ai.agent.id": run.identity.agentId ?? "main",
        "gen_ai.react.round": step?.round ?? 1,
        ...providerAttributes(event.provider),
        "gen_ai.request.model": event.model,
        // The spec's request id is the host's own call identifier.
        "gen_ai.request.id": event.callId,
        "openclaw.model.call.id": event.callId,
        "openclaw.model.observation_unit": "request",
      },
      "chat",
    );
    if (step) {
      attrs["gen_ai.step.id"] = this.stepId(run, step);
    }
    Object.assign(attrs, this.chatInputAttributes(run));
    if (event.trace?.spanId) {
      attrs["openclaw.host.span_id"] = event.trace.spanId;
    }
    if (event.api) {
      attrs["openclaw.model.api"] = event.api;
    }
    if (event.transport) {
      attrs["openclaw.model.transport"] = event.transport;
    }
    if (typeof event.contextTokenBudget === "number") {
      attrs["openclaw.model.context_token_budget"] = event.contextTokenBudget;
    }

    // A repeated call id would silently replace the record: the old span's
    // nodeId is then lost, its finalize command is never emitted, and the
    // emitter has no TTL to recover it. Close the displaced span instead.
    const displacedChat = run.chats.get(event.callId);
    if (displacedChat && !displacedChat.finalized) {
      run.degradedReasons.add("duplicate_model_call_id");
      displacedChat.finalized = true;
      commands.push({
        op: "finalize",
        nodeId: displacedChat.nodeId,
        endTimeMs: event.at,
        status: "unset",
        statusMessage: "displaced by a duplicate call id",
      });
    }
    run.chats.set(event.callId, {
      nodeId,
      stepNodeId: parentNodeId,
      provider: event.provider,
      model: event.model,
      startTimeMs: event.at,
      finalized: false,
    });

    commands.push({
      op: "start",
      nodeId,
      parentNodeId,
      runId: run.identity.runId,
      name: `chat ${event.model}`,
      kind: "chat",
      startTimeMs: event.at,
      attributes: attrs,
    });
    return commands;
  }

  /**
   * Attributes one persisted assistant message's usage to its model call.
   *
   * before_message_write fires once per completed model call and message.usage
   * is that call's exact meter — this is the per-call source llm_output cannot
   * provide. The hook context carries no runId, so the run is resolved by
   * session and the call by recency: within a run, calls are sequential (the
   * next call cannot start before the previous assistant message is persisted),
   * so `lastCallId` is unambiguous. Dedupe covers repeated writes of the same
   * message.
   */
  private onAssistantPersisted(
    event: Extract<ObservationEvent, { type: "assistant.persisted" }>,
  ): SpanCommand[] {
    const run = event.runId
      ? this.runs.get(event.runId)
      : this.findActiveRunBySessionKey(event.sessionKey);
    if (!run || run.finalized) {
      this.orphanEvents += 1;
      return [];
    }
    run.lastActivityMs = event.at;

    const callId = run.lastCallId;
    if (!callId || !event.usage) {
      return [];
    }
    if (run.attributedCallIds.has(callId)) {
      return [];
    }
    const chat = run.chats.get(callId);
    if (!chat) {
      return [];
    }
    run.attributedCallIds.add(callId);
    const attrs = callUsageAttributes(event.usage);
    chat.callUsageAttrs = attrs;
    if (chat.finalized) {
      // The span is already ended; the finalize path re-applies callUsageAttrs,
      // so nothing more is needed here.
      return [];
    }
    return [{ op: "update", nodeId: chat.nodeId, attributes: attrs }];
  }

  /** Active (non-finalized) run for a session, most recent activity wins. */
  private findActiveRunBySessionKey(sessionKey: string | undefined): RunRecord | undefined {
    if (!sessionKey) {
      return undefined;
    }
    let best: RunRecord | undefined;
    for (const run of this.runs.values()) {
      if (run.finalized || run.identity.sessionKey !== sessionKey) {
        continue;
      }
      if (!best || run.lastActivityMs >= best.lastActivityMs) {
        best = run;
      }
    }
    return best;
  }

  private onModelEnded(event: Extract<ObservationEvent, { type: "model.ended" }>): SpanCommand[] {
    const run = this.runs.get(event.runId);
    if (!run) {
      this.orphanEvents += 1;
      return [];
    }
    const chat = run.chats.get(event.callId);
    if (!chat || chat.finalized) {
      this.orphanEvents += 1;
      return [];
    }
    run.lastActivityMs = event.at;

    const step = run.stepOrder.find((entry) => entry.nodeId === chat.stepNodeId);
    if (step) {
      step.lastActivityMs = event.at;
    }

    const attrs: Attributes = {
      "gen_ai.chat.duration_ms": event.durationMs,
      "gen_ai.response.model": event.model,
    };
    // assistant.persisted may already have attributed this call's exact usage;
    // do not overwrite its scope marker with the aggregate one.
    if (!chat.callUsageAttrs) {
      // The usage on a chat without call attribution can only come from the
      // turn-level llm_output aggregate.
      attrs["openclaw.usage.scope"] = "turn_only";
    }
    if (typeof event.requestBytes === "number") {
      attrs["openclaw.model.request_bytes"] = event.requestBytes;
    }
    if (typeof event.responseBytes === "number") {
      attrs["openclaw.model.response_bytes"] = event.responseBytes;
    }
    if (typeof event.ttfbMs === "number") {
      // The spec defines this measurement, so it must appear under the
      // protocol name; the vendor key stays for continuity with existing
      // OpenClaw dashboards.
      attrs["gen_ai.response.time_to_first_token_ms"] = event.ttfbMs;
      attrs["openclaw.model.ttfb_ms"] = event.ttfbMs;
    }
    if (event.upstreamRequestIdHash) {
      attrs["openclaw.model.upstream_request_id_hash"] = event.upstreamRequestIdHash;
    }

    let status: SpanStatus = "ok";
    let statusMessage: string | undefined;
    if (event.outcome === "error") {
      status = "error";
      const errorType = normalizeErrorType(event.errorType ?? event.failureKind, "model_error");
      attrs["error.type"] = errorType;
      statusMessage = errorType;
      if (step) {
        step.failedModelCalls += 1;
      }
      if (event.failureKind) {
        attrs["openclaw.model.failure_kind"] = event.failureKind;
      }
    } else if (step) {
      step.successfulModelCalls += 1;
    }

    chat.observedEndTimeMs = event.at;
    chat.status = status;
    chat.statusMessage = statusMessage;
    if (status === "error") {
      chat.finalized = true;
      return [
        { op: "update", nodeId: chat.nodeId, attributes: attrs },
        { op: "finalize", nodeId: chat.nodeId, endTimeMs: event.at, status, statusMessage },
      ];
    }
    // Successful calls remain open until the next semantic boundary reveals
    // whether the model stopped or requested tools.
    return [{ op: "update", nodeId: chat.nodeId, attributes: attrs }];
  }

  private onTurnInputObserved(
    event: Extract<ObservationEvent, { type: "turn.input.observed" }>,
  ): SpanCommand[] {
    const commands: SpanCommand[] = [];
    const run = this.ensureRun(event, commands);
    if (!run) {
      return commands;
    }
    run.lastProvider = event.provider;
    run.lastModel = event.model;

    // The reconstructed conversation is what each model call receives; the
    // entry span keeps only this turn's question, matching how CLS agents
    // report the turn itself.
    run.conversation = buildTurnMessages({
      systemPrompt: event.input.systemPrompt,
      prompt: event.input.prompt,
      history: event.input.history,
      includeSystemPrompt: this.config.systemPromptMode === "full",
    });
    run.pendingRoundTools = [];

    const contentAttrs = buildInputContentAttributes(this.config, event.input);
    if (Object.keys(contentAttrs).length === 0) {
      return commands;
    }
    commands.push({ op: "update", nodeId: run.entryNodeId, attributes: contentAttrs });
    return commands;
  }

  private onModelTurnObserved(
    event: Extract<ObservationEvent, { type: "model.turn.observed" }>,
  ): SpanCommand[] {
    const commands: SpanCommand[] = [];
    const run = this.ensureRun(event, commands);
    if (!run) {
      return commands;
    }
    run.lastProvider = event.provider;
    run.lastModel = event.model;
    run.harnessId = event.harnessId ?? run.harnessId;
    run.resolvedRef = event.resolvedRef ?? run.resolvedRef;

    if (event.usage) {
      run.usageSamples += 1;
      run.usage = mergeUsage(run.usage, event.usage);
    }

    const outputAttrs = event.output
      ? buildOutputContentAttributes(this.config, event.output)
      : {};
    // Output text is turn-scoped, so it lands on the entry span alongside the
    // turn input. The step span only carries the derived finish reason.
    if (Object.keys(outputAttrs).length > 0) {
      commands.push({ op: "update", nodeId: run.entryNodeId, attributes: outputAttrs });
    }

    // The spec requires token usage on the chat span, but OpenClaw reports it
    // only once per turn through `llm_output` while `model_call_ended` fires per
    // model call. The console reads usage from chat spans (verified: a turn
    // llm_output usage is the attempt aggregate. Per-call usage arrives with
    // each persisted assistant message (assistant.persisted) and is attributed
    // to its own chat span; the aggregate must never be pasted onto one call.
    const chatAttrs: Attributes = { ...outputAttrs };

    const lastStep = run.stepOrder[run.stepOrder.length - 1];
    if (lastStep && !lastStep.finalized) {
      lastStep.finishReason = event.finishReason ?? lastStep.finishReason ?? "stop";
      this.finalizePendingChat(run, lastStep, "stop", commands, chatAttrs);
    }

    if (!run.hasModelSpan) {
      // Opaque harnesses (Claude CLI / Codex / ACP) expose no request-level model
      // hooks, so a single turn-scoped chat span is synthesized instead.
      commands.push(...this.emitOpaqueChat(run, event, chatAttrs));
    }
    return commands;
  }

  private emitOpaqueChat(
    run: RunRecord,
    event: Extract<ObservationEvent, { type: "model.turn.observed" }>,
    chatAttrs: Attributes,
  ): SpanCommand[] {
    const commands: SpanCommand[] = [];
    run.hasModelSpan = true;
    run.chatSpanCount += 1;
    run.degradedReasons.add("opaque_harness_turn");

    // Opaque harnesses expose no request-level transitions, so their whole turn
    // is represented as one explicitly degraded synthetic round.
    const step = this.startStep(
      run,
      event.trace?.spanId,
      run.createdAtMs,
      commands,
      "synthetic",
    );
    const parentNodeId = step?.nodeId ?? run.agentNodeId;
    const nodeId = this.nextNodeId("chat");
    if (step) {
      step.modelCalls += 1;
      step.successfulModelCalls += 1;
      step.lastActivityMs = event.at;
      step.finishReason = event.finishReason ?? step.finishReason;
    }

    const attrs: Attributes = withClsKind(
      {
        ...this.commonFor(run),
        "gen_ai.agent.id": run.identity.agentId ?? "main",
        "gen_ai.react.round": step?.round ?? 1,
        ...providerAttributes(event.provider),
        "gen_ai.request.model": event.model,
        "gen_ai.response.model": event.model,
        "gen_ai.chat.duration_ms": Math.max(0, event.at - run.createdAtMs),
        "openclaw.model.observation_unit": "turn",
        ...chatAttrs,
        // This span stands for the whole turn: it carries the turn-level
        // aggregate because there are no per-call spans to attribute to.
        ...(event.usage ? usageAttributes(normalizeUsage(event.usage)) : {}),
        "openclaw.usage.scope": "turn_only",
      },
      "chat",
    );
    if (step) {
      attrs["gen_ai.step.id"] = this.stepId(run, step);
    }
    if (event.harnessId) {
      attrs["openclaw.harness.id"] = event.harnessId;
    }
    if (event.finishReason) {
      attrs["gen_ai.response.finish_reasons"] = [event.finishReason];
    }

    commands.push({
      op: "start",
      nodeId,
      parentNodeId,
      runId: run.identity.runId,
      name: `chat ${event.model}`,
      kind: "chat",
      startTimeMs: run.createdAtMs,
      attributes: attrs,
    });
    commands.push({ op: "finalize", nodeId, endTimeMs: event.at, status: "ok" });
    return commands;
  }

  private onToolStarted(event: Extract<ObservationEvent, { type: "tool.started" }>): SpanCommand[] {
    const commands: SpanCommand[] = [];
    const run = this.ensureRun(event, commands);
    if (!run) {
      return commands;
    }
    if (run.tools.size >= this.limits.maxToolsPerRun) {
      run.degradedReasons.add("tool_limit_reached");
      return commands;
    }

    const step = this.resolveStepForTool(run, event.trace?.spanId, event.at, commands);
    const parentNodeId = step?.nodeId ?? run.agentNodeId;
    if (!step) {
      run.degradedReasons.add("tool_without_step");
    }

    const nodeId = this.nextNodeId("tool");
    if (step) {
      step.toolCalls += 1;
    }
    run.toolCallCount += 1;

    const canonicalId = canonicalToolCallId(event.toolCallId);
    const attrs: Attributes = withClsKind(
      {
        ...this.commonFor(run),
        "gen_ai.agent.id": run.identity.agentId ?? "main",
        "gen_ai.react.round": step?.round ?? 1,
        "gen_ai.tool.call.id": canonicalId,
        "gen_ai.tool.name": event.toolName,
        "gen_ai.tool.type": "function",
        ...providerAttributes(run.lastProvider ?? "unknown"),
        "gen_ai.request.model": run.lastModel ?? "unknown",
      },
      "tool",
    );
    if (canonicalId !== event.toolCallId) {
      // The provider's own id is kept so a raw id from provider logs can still
      // be matched, while spans and messages join on the canonical form.
      attrs["openclaw.tool.call.id_provider"] = event.toolCallId;
    }
    if (step) {
      attrs["gen_ai.step.id"] = this.stepId(run, step);
    }
    if (event.toolKind) {
      attrs["openclaw.tool.kind"] = event.toolKind;
    }
    if (event.toolInputKind) {
      attrs["openclaw.tool.input_kind"] = event.toolInputKind;
    }
    Object.assign(attrs, buildToolArgumentAttributes(this.config, event.arguments));

    // The conversation record keeps the raw captured text — not the rendered
    // attribute — so the delta fingerprint compares the same bytes the host
    // will replay in history, unclamped by the display limit.
    const rawArguments = event.arguments;

    // Same displaced-span leak guard as for model calls: without it a repeated
    // tool call id strands the old span in the emitter, which has no TTL.
    const displacedTool = run.tools.get(event.toolCallId);
    if (displacedTool && !displacedTool.finalized) {
      run.degradedReasons.add("duplicate_tool_call_id");
      displacedTool.finalized = true;
      commands.push({
        op: "finalize",
        nodeId: displacedTool.nodeId,
        endTimeMs: event.at,
        status: "unset",
        statusMessage: "displaced by a duplicate tool call id",
      });
    }
    run.tools.set(event.toolCallId, {
      nodeId,
      stepNodeId: parentNodeId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(typeof rawArguments === "string" ? { argumentsText: rawArguments } : {}),
      startTimeMs: event.at,
      finalized: false,
    });
    run.pendingRoundTools.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(typeof rawArguments === "string" ? { argumentsText: rawArguments } : {}),
    });

    commands.push({
      op: "start",
      nodeId,
      parentNodeId,
      runId: run.identity.runId,
      name: `execute_tool ${event.toolName}`,
      kind: "tool",
      startTimeMs: event.at,
      attributes: attrs,
    });
    return commands;
  }

  private onToolEnded(event: Extract<ObservationEvent, { type: "tool.ended" }>): SpanCommand[] {
    const run = this.runs.get(event.runId);
    if (!run) {
      this.orphanEvents += 1;
      return [];
    }
    // after_tool_call carries no trace context, so the tool is matched purely by
    // toolCallId recorded at start time.
    const tool = run.tools.get(event.toolCallId);
    if (!tool || tool.finalized) {
      this.orphanEvents += 1;
      return [];
    }
    run.lastActivityMs = event.at;
    tool.finalized = true;

    const step = run.stepOrder.find((entry) => entry.nodeId === tool.stepNodeId);
    if (step) {
      step.lastActivityMs = event.at;
    }

    const durationMs =
      typeof event.durationMs === "number" && event.durationMs >= 0
        ? event.durationMs
        : Math.max(0, event.at - tool.startTimeMs);
    const attrs: Attributes = {
      "gen_ai.tool.call.duration_ms": durationMs,
      ...buildToolResultAttributes(this.config, event.result),
    };
    // Raw captured envelope goes into the conversation record (see the
    // arguments side): truncation and redaction are render-time concerns.
    if (typeof event.result === "string") {
      tool.resultText = event.result;
      const pending = run.pendingRoundTools.find(
        (entry) => entry.toolCallId === event.toolCallId,
      );
      if (pending) {
        pending.resultText = event.result;
      }
    }

    const outcome = classifyToolOutcome(event.toolName, event.resultMeta, event.errorMessage);
    let status: SpanStatus = outcome.status;
    let statusMessage: string | undefined;
    if (outcome.status === "error") {
      const specificErrorType = normalizeErrorType(outcome.errorType, "tool_error");
      attrs["gen_ai.tool.error.type"] = specificErrorType;
      attrs["error.type"] = "tool_error";
      statusMessage = specificErrorType;
      if (this.config.captureErrorMessages && event.errorMessage) {
        const captured = buildToolResultAttributes(this.config, event.errorMessage);
        const text = captured["gen_ai.tool.call.result"];
        if (typeof text === "string") {
          // The spec defines a tool error message field, so the text belongs
          // under the protocol name.
          attrs["gen_ai.tool.error.message"] = text;
          attrs["openclaw.tool.error.message"] = text;
        }
      }
    }

    // Linking must happen before the tool span is finalized: the child's agent
    // span attaches to this tool span, which the emitter only keeps live until
    // its finalize command.
    const subagentCommands =
      tool.toolName === "sessions_spawn"
        ? this.linkSubagentFromToolResult(run, tool, event.result, event.spawnLink)
        : [];

    return [
      { op: "update", nodeId: tool.nodeId, attributes: attrs },
      ...subagentCommands,
      { op: "finalize", nodeId: tool.nodeId, endTimeMs: event.at, status, statusMessage },
    ];
  }

  private onExtensionInstant(
    event: Extract<ObservationEvent, { type: "extension.instant" }>,
  ): SpanCommand[] {
    const commands: SpanCommand[] = [];
    const run = this.ensureRun(event, commands);
    if (!run) {
      return commands;
    }
    const openStep = run.stepOrder.find((entry) => !entry.finalized);
    const parentNodeId = openStep?.nodeId ?? run.agentNodeId;
    const nodeId = this.nextNodeId("ext");
    const durationMs = Math.max(0, event.durationMs ?? 0);

    commands.push({
      op: "start",
      nodeId,
      parentNodeId,
      runId: run.identity.runId,
      name: event.name,
      kind: "extension",
      startTimeMs: event.at - durationMs,
      attributes: withExtensionKind(
        { ...this.commonFor(run), ...(event.attributes ?? {}) },
        event.operation,
      ),
    });
    commands.push({ op: "finalize", nodeId, endTimeMs: event.at, status: "unset" });
    return commands;
  }

  private finalizeRun(runId: string, now: number, reason: string): SpanCommand[] {
    const run = this.runs.get(runId);
    if (!run || run.finalized) {
      return [];
    }
    run.finalized = true;
    const commands: SpanCommand[] = [];
    // Sweeps observe the run long after it went quiet, so the last observed
    // activity is the truthful end time.
    const endAt = Math.max(run.lastActivityMs, run.createdAtMs);
    const incompleteAttrs: Attributes = {
      "openclaw.observation.incomplete": true,
      "openclaw.observation.end_reason": reason,
    };

    this.finalizePendingChat(run, run.currentStep, "stop", commands);

    // Leaves first so no parent is closed before its children.
    for (const tool of run.tools.values()) {
      if (!tool.finalized) {
        tool.finalized = true;
        commands.push({ op: "update", nodeId: tool.nodeId, attributes: incompleteAttrs });
        commands.push({ op: "finalize", nodeId: tool.nodeId, endTimeMs: endAt, status: "unset" });
      }
    }
    for (const chat of run.chats.values()) {
      if (!chat.finalized) {
        chat.finalized = true;
        commands.push({ op: "update", nodeId: chat.nodeId, attributes: incompleteAttrs });
        commands.push({ op: "finalize", nodeId: chat.nodeId, endTimeMs: endAt, status: "unset" });
      }
    }
    for (const step of run.stepOrder) {
      if (step.finalized) {
        continue;
      }
      step.finalized = true;
      commands.push({
        op: "update",
        nodeId: step.nodeId,
        attributes: this.stepSummaryAttributes(step),
      });
      commands.push({
        op: "finalize",
        nodeId: step.nodeId,
        endTimeMs: Math.max(step.lastActivityMs, step.startTimeMs),
        status: step.failedModelCalls > 0 && step.modelCalls === step.failedModelCalls ? "error" : "ok",
      });
    }

    const runStatus: SpanStatus = run.outcome ? (run.outcome.success ? "ok" : "error") : "unset";
    const runError = run.outcome?.success === false ? run.outcome.errorType : undefined;

    const agentAttrs: Attributes = {
      "gen_ai.agent.message_count": run.chatSpanCount,
      "gen_ai.agent.tool_call_count": run.tools.size,
      "openclaw.step.count": run.stepOrder.length,
      "openclaw.attempt.count": run.attemptCount,
      "openclaw.usage.scope": "turn_only",
      ...usageAttributes(
        normalizeUsage(run.usageSamples > 0 ? run.usage : { input: 0, output: 0 }),
      ),
    };
    if (run.usageSamples === 0) {
      agentAttrs["openclaw.usage.unavailable"] = true;
    }
    if (run.harnessId) {
      agentAttrs["openclaw.harness.id"] = run.harnessId;
    }
    if (run.resolvedRef) {
      agentAttrs["openclaw.model.resolved_ref"] = run.resolvedRef;
    }
    if (run.degradedReasons.size > 0) {
      agentAttrs["openclaw.observation.degraded"] = true;
      agentAttrs["openclaw.observation.reason"] = [...run.degradedReasons].sort().join(",");
    }
    if (runError) {
      agentAttrs["error.type"] = normalizeErrorType(runError, "agent_error");
    }

    const entryAttrs: Attributes = {
      // Identity arrives across several hooks, so the values known when the
      // entry span opened can be incomplete. The entry span is the turn root
      // that entry-level queries filter on, so it is refreshed here with the
      // identity as finally resolved.
      ...this.commonFor(run),
      ...providerAttributes(run.lastProvider ?? "unknown"),
      "gen_ai.request.model": run.lastModel ?? "unknown",
      "gen_ai.entry.type": resolveEntryType(run.identity),
      ...(run.identity.channelId
        ? { "gen_ai.entry.channel_id": run.identity.channelId }
        : {}),
      ...announceTurnAttributes(run.identity.runId),
    };
    if (runError) {
      entryAttrs["error.type"] = normalizeErrorType(runError, "agent_error");
    }

    if (run.subagentLink) {
      // A subagent run has no entry span: the provider/model summary that would
      // live on the entry goes onto the invoke_subagent agent span instead.
      Object.assign(agentAttrs, {
        ...providerAttributes(run.lastProvider ?? "unknown"),
        "gen_ai.request.model": run.lastModel ?? "unknown",
      });
    }

    commands.push({ op: "update", nodeId: run.agentNodeId, attributes: agentAttrs });
    commands.push({
      op: "finalize",
      nodeId: run.agentNodeId,
      endTimeMs: endAt,
      status: runStatus,
      statusMessage: runError,
    });
    if (!run.subagentLink) {
      commands.push({ op: "update", nodeId: run.entryNodeId, attributes: entryAttrs });
      commands.push({
        op: "finalize",
        nodeId: run.entryNodeId,
        endTimeMs: endAt,
        status: runStatus,
        statusMessage: runError,
      });
    }

    if (run.subagentLink) {
      this.dropSubagentLink(run.subagentLink);
    }
    this.runs.delete(runId);
    this.tombstones.set(runId, now + 10 * 60 * 1000);
    return commands;
  }

  private stepSummaryAttributes(step: StepRecord): Attributes {
    const finishReason =
      step.finishReason ??
      (step.toolCalls > 0
        ? "tool_calls"
        : step.failedModelCalls === step.modelCalls && step.modelCalls > 0
          ? "error"
          : "stop");
    return {
      "gen_ai.react.finish_reason": finishReason,
      "openclaw.model.call_count": step.modelCalls,
      "openclaw.tool.count": step.toolCalls,
    };
  }

  private commonFor(run: RunRecord): Attributes {
    return buildCommonAttributes({
      config: this.config,
      identity: run.identity,
      session: run.session,
      turnId: run.turnId,
    });
  }

  private stepId(run: RunRecord, step: StepRecord): string {
    return `${run.turnId}:s${step.round}`;
  }

  private mergeIdentity(run: RunRecord, identity: RunIdentity): void {
    run.identity = {
      ...run.identity,
      sessionId: identity.sessionId ?? run.identity.sessionId,
      sessionKey: identity.sessionKey ?? run.identity.sessionKey,
      agentId: identity.agentId ?? run.identity.agentId,
      trigger: identity.trigger ?? run.identity.trigger,
      channelId: identity.channelId ?? run.identity.channelId,
      senderId: identity.senderId ?? run.identity.senderId,
      accountId: identity.accountId ?? run.identity.accountId,
    };
    if (!run.agentHostSpanId && identity.trace?.spanId && !identity.trace.parentSpanId) {
      run.agentHostSpanId = identity.trace.spanId;
    }
  }

  private nextNodeId(prefix: string): NodeId {
    this.nodeSeq += 1;
    return `${prefix}-${this.nodeSeq}`;
  }
}

/**
 * Reports the model vendor under both names the spec defines.
 *
 * The spec lists `gen_ai.system` and `gen_ai.provider.name` side by side in its
 * common-identity section, with the same vendor vocabulary. OpenClaw exposes a
 * single provider value, so both carry it rather than leaving `gen_ai.system`
 * empty for consumers that group by it.
 */
function providerAttributes(provider: string): Attributes {
  return { "gen_ai.system": provider, "gen_ai.provider.name": provider };
}

function mergeUsage(base: TokenUsage, next: TokenUsage): TokenUsage {
  const add = (a: number | undefined, b: number | undefined): number | undefined => {
    if (typeof a !== "number" && typeof b !== "number") {
      return undefined;
    }
    return (a ?? 0) + (b ?? 0);
  };
  return {
    input: add(base.input, next.input),
    output: add(base.output, next.output),
    cacheRead: add(base.cacheRead, next.cacheRead),
    cacheWrite: add(base.cacheWrite, next.cacheWrite),
    // `total` is intentionally not summed here; the mapping layer derives the
    // CLS total from input+output because the host total includes cache reads.
    total: add(base.total, next.total),
  };
}
