// Resolves the stable CLS session identity across OpenClaw session rotation.
import type { ClsObservabilityConfig } from "../config.js";
import { pseudonymize } from "../config.js";
import type { SessionIdentity } from "./types.js";

type SessionEntry = {
  instanceId?: string;
  lastSeenAt: number;
};

type TurnCounter = {
  count: number;
  lastSeenAt: number;
};

const MAX_ENTRIES = 10_000;

/**
 * Maps OpenClaw session routing keys to CLS session ids.
 *
 * OpenClaw rotates `sessionId` on compaction and daily/idle rollover, so using
 * it directly would split one conversation into many CLS sessions. The stable
 * routing `sessionKey` is used instead, which also means an explicit `/new`
 * continues the same CLS session; that is preferred over a process-local epoch
 * counter that would silently reset on every gateway restart.
 */
export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();
  // Keyed by CLS session id rather than routing key so degraded sessions, which
  // have no routing key, still get numbered turns.
  private readonly turnCounters = new Map<string, TurnCounter>();

  constructor(private readonly config: ClsObservabilityConfig) {}

  resolve(params: { sessionKey?: string; sessionId?: string; now: number }): SessionIdentity {
    const { sessionKey, sessionId, now } = params;
    if (!sessionKey) {
      return {
        clsSessionId: sessionId ?? "unknown-session",
        instanceId: sessionId,
        lineageDegraded: true,
      };
    }

    const entry = this.touch(sessionKey, now);
    entry.instanceId = sessionId ?? entry.instanceId;

    const clsSessionId =
      pseudonymize(this.config, "session-key", sessionKey) ??
      (this.config.identityMode === "raw" ? sessionKey : hashFallback(sessionKey));

    return {
      clsSessionId,
      instanceId: sessionId,
      lineageDegraded: false,
    };
  }

  prune(olderThanMs: number, now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt > olderThanMs) {
        this.entries.delete(key);
      }
    }
    for (const [key, counter] of this.turnCounters) {
      if (now - counter.lastSeenAt > olderThanMs) {
        this.turnCounters.delete(key);
      }
    }
  }

  /**
   * Allocates the next turn id for a CLS session.
   *
   * The spec names ids as a chain — `{sessionId}:t{N}` and `{turnId}:s{N}` — so
   * that a session, its turns and their steps can be related by prefix matching
   * alone. The counter is process-local: after a gateway restart an ongoing
   * session restarts at `t1`, so `openclaw.run.id` remains the identifier that
   * is unique without qualification.
   */
  allocateTurnId(clsSessionId: string, now: number): string {
    const existing = this.turnCounters.get(clsSessionId);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = now;
      // Re-insert so iteration order tracks recency for eviction.
      this.turnCounters.delete(clsSessionId);
      this.turnCounters.set(clsSessionId, existing);
      return `${clsSessionId}:t${existing.count}`;
    }
    if (this.turnCounters.size >= MAX_ENTRIES) {
      const oldest = this.turnCounters.keys().next();
      if (!oldest.done) {
        this.turnCounters.delete(oldest.value);
      }
    }
    this.turnCounters.set(clsSessionId, { count: 1, lastSeenAt: now });
    return `${clsSessionId}:t1`;
  }

  get size(): number {
    return this.entries.size;
  }

  private touch(sessionKey: string, now: number): SessionEntry {
    const existing = this.entries.get(sessionKey);
    if (existing) {
      existing.lastSeenAt = now;
      // Re-insert to keep Map iteration order aligned with recency for eviction.
      this.entries.delete(sessionKey);
      this.entries.set(sessionKey, existing);
      return existing;
    }
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    const created: SessionEntry = { lastSeenAt: now };
    this.entries.set(sessionKey, created);
    return created;
  }
}

function hashFallback(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sk-${hash.toString(16).padStart(8, "0")}`;
}
