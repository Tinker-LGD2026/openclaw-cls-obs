// Builds CLS Agent Trace attributes from normalized observation facts.
import type { ClsObservabilityConfig } from "../config.js";
import { pseudonymize } from "../config.js";
import type { Attributes, ClsSpanKind, RunIdentity, SessionIdentity } from "../domain/types.js";
import { CLS_SPAN_CONTRACTS } from "../protocol/contracts.js";

export const SCHEMA_VERSION = "1.0.0";

export type AnnounceTurnInfo = {
  /** Session key of the subagent that finished, e.g. `agent:main:subagent:<uuid>`. */
  childSessionKey: string;
  /** Run id of that subagent run. */
  childRunId: string;
};

/**
 * Parses the run id of a subagent-announce turn.
 *
 * When a subagent finishes, OpenClaw wakes the parent agent with a fresh turn
 * whose run id embeds the announce id —
 * `announce:v1:{childSessionKey}:{childRunId}` (see
 * `buildAnnounceIdFromChildRun` in the host). That shape is the only signal
 * that distinguishes the announce turn from an ordinary user turn, and it
 * carries everything needed to link back to the subagent run.
 */
export function parseAnnounceRunId(runId: string): AnnounceTurnInfo | undefined {
  const match = /^announce:v1:(?<childSessionKey>.+):(?<childRunId>[^:]+)$/.exec(runId);
  const { childSessionKey, childRunId } = match?.groups ?? {};
  if (!childSessionKey || !childRunId) {
    return undefined;
  }
  return { childSessionKey, childRunId };
}

/**
 * Vendor attributes linking an announce turn back to its subagent run.
 *
 * The host reports `trigger: "user"` for announce turns (kept as-is in
 * `openclaw.trigger`), so without these attributes the turn that posts a
 * subagent's result is indistinguishable from a human turn.
 */
export function announceTurnAttributes(runId: string): Attributes {
  const info = parseAnnounceRunId(runId);
  if (!info) {
    return {};
  }
  return {
    "openclaw.turn.trigger": "subagent_announce",
    "openclaw.turn.source_session_key": info.childSessionKey,
    "openclaw.turn.source_run_id": info.childRunId,
  };
}

/** Maps an OpenClaw trigger/channel to a CLS entry type. */
export function resolveEntryType(identity: RunIdentity): string {
  const trigger = identity.trigger?.toLowerCase();
  switch (trigger) {
    case "cron":
      return "cron";
    case "heartbeat":
      return "heartbeat";
    case "subagent":
      return "subagent";
    case "cli":
    case "local":
      return "cli";
    case "rpc":
    case "api":
      return "rpc";
    case "webhook":
      return "webhook";
    default:
      break;
  }
  return identity.channelId ? "channel" : "unknown";
}

export function resolveUserIdentity(
  config: ClsObservabilityConfig,
  identity: RunIdentity,
): { userId?: string; userName?: string } {
  if (config.identityMode === "static") {
    // Only emit identity when the operator actually supplied one; inventing
    // "anonymous" would make every run look like the same user in CLS.
    return {
      ...(config.staticUserId ? { userId: config.staticUserId } : {}),
      ...(config.staticUserName || config.staticUserId
        ? { userName: config.staticUserName ?? config.staticUserId }
        : {}),
    };
  }
  // sessionKey is the last-resort identity source for CLI/local runs where no
  // channel sender is available. Domain separation keeps it unlinkable to the
  // independently uploaded session-key fingerprint.
  const source = identity.senderId ?? identity.accountId ?? identity.sessionKey;
  const userId = pseudonymize(config, "user", source);
  if (!userId) {
    return {};
  }
  return { userId, userName: `user-${userId.slice(0, 8)}` };
}

/** Attributes required on every CLS span, including extension spans. */
export function buildCommonAttributes(params: {
  config: ClsObservabilityConfig;
  identity: RunIdentity;
  session: SessionIdentity;
  /** `{sessionId}:t{N}`, allocated once per turn by the session registry. */
  turnId: string;
}): Attributes {
  const { config, identity, session, turnId } = params;
  const user = resolveUserIdentity(config, identity);
  const attrs: Attributes = {
    "gen_ai.agent.type": "openclaw",
    "gen_ai.session.id": session.clsSessionId,
    "gen_ai.turn.id": turnId,
    "openclaw.run.id": identity.runId,
    "openclaw.schema.version": SCHEMA_VERSION,
  };
  if (user.userId) {
    attrs["gen_ai.user.id"] = user.userId;
  }
  if (user.userName) {
    attrs["gen_ai.user.name"] = user.userName;
  }
  if (!user.userId || !user.userName) {
    attrs["openclaw.observation.identity_degraded"] = true;
  }
  if (identity.trace?.traceId) {
    // Keeping the host trace id makes CLS spans joinable with the traces emitted
    // by OpenClaw's own diagnostics-otel exporter.
    attrs["openclaw.host.trace_id"] = identity.trace.traceId;
  }
  if (identity.agentId) {
    attrs["openclaw.agent.id"] = identity.agentId;
  }
  if (identity.trigger) {
    attrs["openclaw.trigger"] = identity.trigger;
  }
  if (identity.channelId) {
    attrs["openclaw.channel"] = identity.channelId;
  }
  if (session.instanceId) {
    attrs["openclaw.session.instance_id"] = session.instanceId;
  }
  if (session.lineageDegraded) {
    attrs["openclaw.session.lineage_degraded"] = true;
  }
  const sessionKeyHash = pseudonymize(config, "session-key", identity.sessionKey);
  if (sessionKeyHash) {
    attrs["openclaw.session.key_hash"] = sessionKeyHash;
  }
  return attrs;
}

/** Marks a span as one of the five CLS protocol kinds. */
export function withClsKind(attrs: Attributes, kind: ClsSpanKind): Attributes {
  return {
    ...attrs,
    "gen_ai.span.kind": kind,
    "gen_ai.operation.name": CLS_SPAN_CONTRACTS[kind].operation,
  };
}

/**
 * Marks a span as an OpenClaw extension span.
 *
 * Extension spans intentionally omit `gen_ai.span.kind` so CLS does not count
 * them as one of the five protocol kinds, but they keep the full identity
 * attribute set so they remain queryable by session and turn.
 */
export function withExtensionKind(attrs: Attributes, operation: string): Attributes {
  return {
    ...attrs,
    "gen_ai.operation.name": operation,
    "openclaw.span.kind": "extension",
  };
}

/** Normalizes provider/model failure details into a low-cardinality error type. */
export function normalizeErrorType(raw: string | undefined, fallback: string): string {
  if (!raw) {
    return fallback;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return fallback;
  }
  const normalized = trimmed.replace(/[^a-z0-9_.-]+/g, "_").slice(0, 64);
  return normalized.length > 0 ? normalized : fallback;
}
