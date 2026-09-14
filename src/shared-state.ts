// Process-wide collector shared across plugin registries.
import { DiagLogLevel, diag } from "@opentelemetry/api";
import { Collector, type CollectorLogger } from "./collector.js";
import {
  configFingerprint,
  loadConfig,
  summarizeConfig,
  type ClsObservabilityConfig,
  type PluginFileConfig,
} from "./config.js";
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
  /** Fingerprint of the config the running collector was built from. */
  fingerprint?: string;
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
export function acquireCollector(logger: CollectorLogger, pluginConfig?: PluginFileConfig): StartOutcome {
  const shared = state();
  shared.refCount += 1;

  const result = loadConfig(process.env, pluginConfig);

  if (shared.collector) {
    // A config-file edit reloads the plugin while a collector may still be
    // running: swap it when the effective config actually changed, keep the
    // last-good exporter when the new config is broken.
    if (result.status === "ready") {
      const nextFingerprint = configFingerprint(result.config);
      if (nextFingerprint !== shared.fingerprint) {
        logger.info("CLS configuration changed; restarting the exporter");
        const previous = shared.collector;
        const collector = startCollector(result.config, logger);
        shared.collector = collector;
        shared.fingerprint = nextFingerprint;
        void previous.shutdown().catch(() => {});
        return {
          status: "started",
          serviceName: result.config.serviceName,
          contentMode: result.config.contentMode,
        };
      }
    } else if (result.status !== "disabled") {
      logger.warn(`cls observability new config is invalid (${result.reason}); keeping the running exporter`);
    }
    return { status: "reused" };
  }
  if (shared.initFailed) {
    return { status: "invalid", reason: "previous initialization failed" };
  }

  if (result.status === "disabled") {
    return { status: "disabled", reason: result.reason };
  }
  if (result.status === "invalid") {
    shared.initFailed = true;
    return { status: "invalid", reason: result.reason };
  }

  const collector = startCollector(result.config, logger);
  shared.collector = collector;
  shared.fingerprint = configFingerprint(result.config);
  shared.initFailed = false;
  return {
    status: "started",
    serviceName: result.config.serviceName,
    contentMode: result.config.contentMode,
  };
}

/** Builds and starts a collector, registering shared diagnostics on the way. */
function startCollector(config: ClsObservabilityConfig, logger: CollectorLogger): Collector {
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

  const handle = createTracerProvider(config);
  const limits: Partial<RunStateLimits> = {};
  const limitPairs = [
    [config.attemptQuiescenceMs, "attemptQuiescenceMs"],
    [config.stateMaxActiveRuns, "maxActiveRuns"],
    [config.stateMaxCursorSessions, "maxCursorSessions"],
    [config.stateMaxStepsPerRun, "maxStepsPerRun"],
    [config.stateMaxModelsPerRun, "maxModelsPerRun"],
    [config.stateMaxToolsPerRun, "maxToolsPerRun"],
    [config.stateRunIdleMs, "runIdleMs"],
  ] as const;
  for (const [value, key] of limitPairs) {
    if (value !== undefined) {
      (limits as Record<string, number>)[key] = value;
    }
  }
  const collector = new Collector(config, handle, logger, {
    ...DEFAULT_LIMITS,
    ...limits,
  });
  collector.start();
  logger.info(`cls observability effective config: ${summarizeConfig(config)}`);
  return collector;
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
  shared.fingerprint = undefined;
  // A full stop clears the failure latch so a fixed config can start again.
  shared.initFailed = false;
  if (!collector) {
    return false;
  }
  await collector.shutdown();
  return true;
}
