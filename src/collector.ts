// Wires the state machine, span emitter, and background sweeper together.
import type { ClsObservabilityConfig } from "./config.js";
import { DEFAULT_LIMITS, type RunStateLimits, RunStateMachine } from "./domain/run-state.js";
import { SessionRegistry } from "./domain/session-registry.js";
import type { ObservationEvent } from "./domain/types.js";
import { SpanEmitter } from "./telemetry/emitter.js";
import type { TracerHandle } from "./telemetry/provider.js";

export type CollectorLogger = {
  warn: (message: string) => void;
  info: (message: string) => void;
  /** Optional; otel diag errors fall back to warn when absent. */
  error?: (message: string) => void;
};

const SWEEP_INTERVAL_MS = 1_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Single synchronous entry point for all observation events.
 *
 * Hooks are fire-and-forget, so every ingest call completes its state transition
 * synchronously and never throws back into OpenClaw.
 */
export class Collector {
  private readonly sessions: SessionRegistry;
  private readonly runs: RunStateMachine;
  private readonly emitter: SpanEmitter;
  private sweepTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
  private accepting = true;
  private ingested = 0;

  constructor(
    private readonly clsConfig: ClsObservabilityConfig,
    private readonly tracerHandle: TracerHandle,
    private readonly logger: CollectorLogger,
    limits: RunStateLimits = DEFAULT_LIMITS,
  ) {
    this.sessions = new SessionRegistry(clsConfig);
    this.runs = new RunStateMachine(clsConfig, this.sessions, limits);
    this.emitter = new SpanEmitter(tracerHandle.tracer);
  }

  /** Live configuration, read by hook adapters registered before startup. */
  getConfig(): ClsObservabilityConfig {
    return this.clsConfig;
  }

  start(): void {
    if (this.sweepTimer) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      this.sweep(Date.now());
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    // Self-observability: a low-frequency stats line gives operators something
    // to alert on (dropped spans, export pressure) between shutdowns. This is
    // a log, not a span — self-observation must not pollute the observed data.
    const statsInterval = this.clsConfig.statsIntervalMs ?? 300_000;
    if (statsInterval > 0) {
      this.statsTimer = setInterval(() => {
        this.logger.info(`cls observability stats ${JSON.stringify(this.stats)}`);
      }, statsInterval);
      this.statsTimer.unref?.();
    }
  }

  ingest(event: ObservationEvent): void {
    if (!this.accepting) {
      return;
    }
    try {
      this.ingested += 1;
      this.emitter.applyAll(this.runs.apply(event));
    } catch (error) {
      this.logger.warn(`cls observability ingest failed: ${describeError(error)}`);
    }
  }

  sweep(now: number): void {
    try {
      this.emitter.applyAll(this.runs.sweep(now));
      this.sessions.prune(SESSION_TTL_MS, now);
    } catch (error) {
      this.logger.warn(`cls observability sweep failed: ${describeError(error)}`);
    }
  }

  get stats(): Record<string, number | string> {
    return {
      ...this.runs.stats,
      ...this.emitter.stats,
      ingested: this.ingested,
      sessions: this.sessions.size,
      contentMode: this.clsConfig.contentMode,
    };
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
    try {
      this.emitter.applyAll(this.runs.drain(Date.now()));
    } catch (error) {
      this.logger.warn(`cls observability drain failed: ${describeError(error)}`);
    }
    this.logger.info(
      `cls observability shutdown stats ${JSON.stringify(this.stats)}`,
    );
    try {
      await this.tracerHandle.forceFlush();
    } catch (error) {
      this.logger.warn(`cls observability flush failed: ${describeError(error)}`);
    }
    try {
      await this.tracerHandle.shutdown();
    } catch (error) {
      this.logger.warn(`cls observability shutdown failed: ${describeError(error)}`);
    }
  }
}

/** Credential-bearing fields that must never reach the log. */
const SENSITIVE_KEY_RE = /(authorization|secret|token|password|passwd|cookie)/i;

type ExportErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  data?: unknown;
};

/**
 * Renders one export error with the fields that identify its cause.
 *
 * OTLP exporter errors are plain objects carrying `code` and `data` rather than
 * real `Error` instances, so instanceof-based handling would discard exactly the
 * information needed to diagnose a failure.
 */
function describeSingleError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return typeof error === "string" && error.length > 0 ? error.slice(0, 120) : "unknown_error";
  }
  const candidate = error as ExportErrorLike;
  const parts: string[] = [];
  parts.push(typeof candidate.name === "string" ? candidate.name : "Error");
  if (typeof candidate.message === "string" && candidate.message.trim().length > 0) {
    parts.push(candidate.message.trim().slice(0, 160));
  }
  if (typeof candidate.code === "string" || typeof candidate.code === "number") {
    parts.push(`status=${candidate.code}`);
  }
  if (typeof candidate.data === "string" && candidate.data.trim().length > 0) {
    const reason = candidate.data.trim().slice(0, 120);
    if (!SENSITIVE_KEY_RE.test(reason)) {
      parts.push(`reason=${reason}`);
    }
  }
  return parts.join(" ");
}

/**
 * Renders an export failure.
 *
 * `BatchSpanProcessor.forceFlush` rejects with an array of per-batch errors, so
 * a single-error assumption would collapse every failure to "unknown_error" and
 * hide actionable detail such as a wrong-region 404.
 */
function describeError(error: unknown): string {
  if (Array.isArray(error)) {
    if (error.length === 0) {
      return "unknown_error";
    }
    const rendered = error.slice(0, 3).map(describeSingleError);
    const suffix = error.length > 3 ? ` (+${error.length - 3} more)` : "";
    return `${rendered.join("; ")}${suffix}`;
  }
  return describeSingleError(error);
}
