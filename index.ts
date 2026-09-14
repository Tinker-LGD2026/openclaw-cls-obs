// CLS Agent Observability plugin entrypoint.
import type { Collector } from "./src/collector.js";
import type { ClsObservabilityConfig } from "./src/config.js";
import { registerObservationHooks } from "./src/hooks/register.js";
import {
  acquireCollector,
  getCollector,
  noteDroppedEvent,
  releaseCollector,
} from "./src/shared-state.js";

type PluginLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type PluginApi = {
  on: (hookName: string, handler: (...args: never[]) => unknown, opts?: unknown) => void;
  /** Validated `plugins.entries.cls-agent-observability.config` from openclaw.json. */
  pluginConfig?: Record<string, unknown>;
  registerService: (service: {
    id: string;
    start: (ctx: { logger?: PluginLogger }) => void | Promise<void>;
    stop?: (ctx: { logger?: PluginLogger }) => void | Promise<void>;
  }) => void;
};

const PLUGIN_ID = "cls-agent-observability";

const consoleLogger: PluginLogger = {
  info: (message) => console.log(`[${PLUGIN_ID}] ${message}`),
  warn: (message) => console.warn(`[${PLUGIN_ID}] ${message}`),
  error: (message) => console.error(`[${PLUGIN_ID}] ${message}`),
};

/**
 * Registers the plugin.
 *
 * OpenClaw instantiates several plugin registries per process and calls this
 * function once per registry, so all mutable state lives in a process-wide
 * singleton. Hooks are always registered, while the exporter only starts when
 * CLS configuration is complete; missing configuration puts the plugin to sleep
 * instead of failing gateway startup.
 */
export function register(api: PluginApi): void {
  const proxy = {
    ingest: ((event) => {
      const collector = getCollector();
      if (!collector) {
        noteDroppedEvent();
        return;
      }
      collector.ingest(event);
    }) as Collector["ingest"],
  } as Collector;

  // Hooks are registered before the config is known, so content capture reads
  // the live config through this view rather than a stale snapshot. While the
  // plugin is idle every field reads as undefined, which keeps `contentMode`
  // falsy and content capture off.
  const configProxy = new Proxy({} as ClsObservabilityConfig, {
    get: (_target, prop) => {
      const collector = getCollector();
      return collector?.getConfig()[prop as keyof ClsObservabilityConfig];
    },
    has: (_target, prop) => {
      const collector = getCollector();
      return collector ? prop in collector.getConfig() : false;
    },
  });

  registerObservationHooks(api, proxy, configProxy);

  api.registerService({
    id: PLUGIN_ID,
    start(ctx) {
      const logger = ctx.logger ?? consoleLogger;
      const outcome = acquireCollector(logger, api.pluginConfig);
      switch (outcome.status) {
        case "started":
          logger.info(
            `CLS agent trace export enabled service=${outcome.serviceName} content=${outcome.contentMode}`,
          );
          return;
        case "reused":
          logger.info("CLS agent trace export already running in this process");
          return;
        case "disabled":
          logger.info("CLS configuration absent; agent trace export stays idle");
          return;
        default:
          logger.error(`CLS configuration invalid: ${outcome.reason}`);
      }
    },
    async stop(ctx) {
      const logger = ctx.logger ?? consoleLogger;
      if (await releaseCollector(logger)) {
        logger.info("CLS agent trace export stopped");
      }
    },
  });
}

export default {
  id: PLUGIN_ID,
  name: "CLS Agent Observability",
  description: "Export OpenClaw agent execution as Tencent Cloud CLS Agent Trace spans.",
  register,
};
