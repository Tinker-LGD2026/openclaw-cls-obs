// Process-wide collector shared across plugin registries.
import { DiagLogLevel, diag } from "@opentelemetry/api";
import { Collector, type CollectorLogger } from "./collector.js";
import { loadConfig } from "./config.js";
import { DEFAULT_LIMITS, type RunStateLimits } from "./domain/run-state.js";
import { createTracerProvider } from "./telemetry/provider.js";

/**
 * OpenClaw builds more than one plugin registry inside a single process: the
 * gateway registry starts plugin services, while a separate agent-runtime
 * registry is what actually dispatches hooks. Each registry calls `register`
 * again, so a collector scoped to one `register` closure would be permanently
 * undefined on the side that receives hook traffic.
 *
 * The collector is therefore owned by the process, keyed on a global symbol so
 * every registry in the process reaches the same instance.
 */
const STATE_KEY = Symbol.for("openclaw.clsAgentObservability.state.v1");

type SharedState = {
  collector?: Collector;
  refCount: number;
  droppedBeforeStart: number;
  initFailed: boolean;
};

type GlobalWithState = typeof globalThis & { [STATE_KEY]?: SharedState };

function state(): SharedState {
  const holder = globalThis as GlobalWithState;
  let existing = holder[STATE_KEY];
  if (!existing) {
    existing = { refCount: 0, droppedBeforeStart: 0, initFailed: false };
    holder[STATE_KEY] = existing;
  }
  return existing;
}

/** Returns the shared collector, or undefined while the exporter is idle. */
export function getCollector(): Collector | undefined {
  return state().collector;
}

/** Records that observation data arrived while no exporter was running. */
export function noteDroppedEvent(): void {
  state().droppedBeforeStart += 1;
}

export type StartOutcome =
  | { status: "started"; serviceName: string; contentMode: string }
  | { status: "reused" }
  | { status: "disabled"; reason: string }
  | { status: "invalid"; reason: string };

/**
 * Starts the shared collector if needed and takes a reference.
 *
 * Repeated calls from additional registries reuse the running exporter instead
 * of creating a second tracer provider and a second OTLP connection.
 */
export function acquireCollector(logger: CollectorLogger): StartOutcome {
  const shared = state();
  shared.refCount += 1;

  if (shared.collector) {
    return { status: "reused" };
  }
  if (shared.initFailed) {
    return { status: "invalid", reason: "previous initialization failed" };
  }

  const result = loadConfig();
  if (result.status === "disabled") {
    return { status: "disabled", reason: result.reason };
  }
  if (result.status === "invalid") {
    shared.initFailed = true;
    return { status: "invalid", reason: result.reason };
  }

  for (const warning of result.warnings) {
    logger.warn(`cls observability config: ${warning}`);
  }
  // BatchSpanProcessor reports a full queue ("spans were dropped") and export
  // failures only through the OTel diag channel; without this they vanish.
  // setLogger is a no-op when another plugin already owns the channel.
  const diagRegistered = diag.setLogger(
    {
      warn: (message) => logger.warn(`otel: ${message}`),
      error: (message) => (logger.error ?? logger.warn)(`otel: ${message}`),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN,
  );
  if (!diagRegistered) {
    logger.warn("otel diag channel already owned; queue/export warnings may go elsewhere");
  }

  const handle = createTracerProvider(result.config);
  const limits: Partial<RunStateLimits> = {};
  const limitPairs = [
    [result.config.attemptQuiescenceMs, "attemptQuiescenceMs"],
    [result.config.stateMaxActiveRuns, "maxActiveRuns"],
    [result.config.stateMaxCursorSessions, "maxCursorSessions"],
    [result.config.stateMaxStepsPerRun, "maxStepsPerRun"],
    [result.config.stateMaxModelsPerRun, "maxModelsPerRun"],
    [result.config.stateMaxToolsPerRun, "maxToolsPerRun"],
    [result.config.stateRunIdleMs, "runIdleMs"],
  ] as const;
  for (const [value, key] of limitPairs) {
    if (value !== undefined) {
      (limits as Record<string, number>)[key] = value;
    }
  }
  const collector = new Collector(result.config, handle, logger, {
    ...DEFAULT_LIMITS,
    ...limits,
  });
  collector.start();
  shared.collector = collector;
  return {
    status: "started",
    serviceName: result.config.serviceName,
    contentMode: result.config.contentMode,
  };
}

/** Releases a reference, shutting the exporter down when the last one goes. */
export async function releaseCollector(logger: CollectorLogger): Promise<boolean> {
  const shared = state();
  shared.refCount = Math.max(0, shared.refCount - 1);
  if (shared.refCount > 0) {
    return false;
  }
  if (shared.droppedBeforeStart > 0) {
    logger.warn(
      `cls observability dropped ${shared.droppedBeforeStart} event(s) observed before the exporter was running`,
    );
    shared.droppedBeforeStart = 0;
  }
  const collector = shared.collector;
  shared.collector = undefined;
  if (!collector) {
    return false;
  }
  await collector.shutdown();
  return true;
}
