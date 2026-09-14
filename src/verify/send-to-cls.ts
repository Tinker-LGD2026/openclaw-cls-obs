// Sends captured real OpenClaw traffic to a live CLS Agent Trace topic.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Collector } from "../collector.js";
import { loadConfig } from "../config.js";
import { createTracerProvider } from "../telemetry/provider.js";
import { loadCapture } from "./load-capture.js";

const DEFAULT_CAPTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../evidence/captures",
);
const CAPTURE_DIR = process.env.CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;

const logger = {
  info: (message: string) => console.log(`[verify:cls] ${message}`),
  warn: (message: string) => console.warn(`[verify:cls] ${message}`),
};

async function main(): Promise<void> {
  const result = loadConfig();
  if (result.status !== "ready") {
    console.error(`[verify:cls] configuration ${result.status}: ${result.reason}`);
    console.error(
      "[verify:cls] required: CLS_ENDPOINT CLS_TRACE_TOPIC_ID CLS_SECRET_ID CLS_SECRET_KEY",
    );
    process.exitCode = 1;
    return;
  }

  const files = readdirSync(CAPTURE_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) {
    console.error(`[verify:cls] no capture files in ${CAPTURE_DIR}`);
    process.exitCode = 1;
    return;
  }

  const handle = createTracerProvider(result.config);
  const collector = new Collector(result.config, handle, logger);

  let sent = 0;
  let lastAt = 0;
  for (const file of files) {
    const events = loadCapture(path.join(CAPTURE_DIR, file));
    for (const event of events) {
      collector.ingest(event);
      lastAt = Math.max(lastAt, event.at);
      sent += 1;
    }
    logger.info(`replayed ${file} events=${events.length}`);
  }
  collector.sweep(lastAt + 30_000);

  logger.info(`endpoint=${result.config.tracesUrl} events=${sent} content=${result.config.contentMode}`);
  await collector.shutdown();
  logger.info("flush complete");
}

void main();
