// Config-file (plugins.entries.<id>.config) support: merge precedence, schema
// consistency, fingerprint/summary, restart latch, and the stats timer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Collector, type CollectorLogger } from "../src/collector.js";
import {
  configFingerprint,
  loadConfig,
  summarizeConfig,
  type ClsObservabilityConfig,
} from "../src/config.js";
import {
  acquireCollector,
  releaseCollector,
} from "../src/shared-state.js";
import type { TracerHandle } from "../src/telemetry/provider.js";

const REQUIRED_ENV = {
  CLS_ENDPOINT: "https://ap-shanghai.cls.tencentcs.com",
  CLS_TRACE_TOPIC_ID: "topic-1",
  CLS_SECRET_ID: "sid",
  CLS_SECRET_KEY: "skey",
};

function envOf(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...REQUIRED_ENV, ...overrides };
}

function silentLogger(): CollectorLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

test("file-only config satisfies the required keys", () => {
  const result = loadConfig({}, {
    endpoint: "https://ap-shanghai.cls.tencentcs.com",
    traceTopicId: "topic-file",
    secretId: "fsid",
    secretKey: "fskey",
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.config.topicId, "topic-file");
  assert.equal(result.config.contentMode, "off");
  // Secrets from the file must trigger the plaintext-on-disk warning.
  assert.ok(result.warnings.some((w) => w.includes("config file")));
});

test("env wins over the config file for the same key", () => {
  const result = loadConfig(envOf({ CLS_CONTENT_MODE: "full" }), {
    contentMode: "truncate",
    traceTopicId: "topic-file",
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.config.contentMode, "full");
  assert.equal(result.config.topicId, "topic-1"); // env topic wins too
});

test("explicit valid enum values never warn; typos do", () => {
  const clean = loadConfig(envOf({ CLS_CONTENT_MODE: "off", CLS_IDENTITY_HMAC_KEY: "k" }));
  assert.equal(clean.status, "ready");
  if (clean.status !== "ready") return;
  assert.equal(
    clean.warnings.filter((w) => w.includes("contentMode")).length,
    0,
    "explicit off is a valid value, not a typo",
  );

  const typo = loadConfig({}, { ...requiredFile(), contentMode: "truncated" });
  assert.equal(typo.status, "ready");
  if (typo.status !== "ready") return;
  assert.equal(typo.config.contentMode, "off");
  assert.ok(typo.warnings.some((w) => w.includes('contentMode="truncated"')));
});

test("typed file values need no string parsing", () => {
  const result = loadConfig({}, {
    ...requiredFile(),
    contentMaxChars: 5000,
    traceSampleRate: 0.5,
    captureErrorMessages: true,
    stateMaxStepsPerRun: 99,
    statsIntervalMs: 0,
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.config.contentMaxChars, 5000);
  assert.equal(result.config.sampleRate, 0.5);
  assert.equal(result.config.captureErrorMessages, true);
  assert.equal(result.config.stateMaxStepsPerRun, 99);
  assert.equal(result.config.statsIntervalMs, 0);
});

test("manifest configSchema defaults match the code defaults", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "..", "..", "openclaw.plugin.json"), "utf8"),
  ) as { configSchema: { properties: Record<string, { default?: unknown }> } };
  const result = loadConfig(envOf());
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const config = result.config as unknown as Record<string, unknown>;
  const fieldMap: Record<string, string> = {
    serviceName: "serviceName",
    traceSampleRate: "sampleRate",
    contentMode: "contentMode",
    contentMaxChars: "contentMaxChars",
    inputMessagesMode: "inputMessagesMode",
    systemPromptMode: "systemPromptMode",
    captureErrorMessages: "captureErrorMessages",
    identityMode: "identityMode",
    exportTimeoutMs: "exportTimeoutMs",
    exportDelayMs: "scheduledDelayMs",
    exportQueueSize: "maxQueueSize",
    exportBatchSize: "maxExportBatchSize",
    statsIntervalMs: "statsIntervalMs",
  };
  for (const [schemaKey, configKey] of Object.entries(fieldMap)) {
    const schemaDefault = manifest.configSchema.properties[schemaKey]?.default;
    assert.notEqual(schemaDefault, undefined, `schema must carry a default for ${schemaKey}`);
    // identityMode falls back to static without an hmac key; assert the schema
    // default against the pre-fallback value instead.
    if (schemaKey === "identityMode") {
      assert.equal(schemaDefault, "hash");
      continue;
    }
    assert.equal(
      config[configKey],
      schemaDefault,
      `${schemaKey}: schema default ${schemaDefault} != code default ${config[configKey]}`,
    );
  }
});

test("fingerprint ignores serviceInstanceId but reacts to real changes", () => {
  const a = loadConfig(envOf());
  const b = loadConfig(envOf({ CLS_SERVICE_INSTANCE_ID: "other" }));
  const c = loadConfig(envOf({ CLS_CONTENT_MODE: "truncate" }));
  assert.equal(a.status, "ready");
  assert.equal(b.status, "ready");
  assert.equal(c.status, "ready");
  if (a.status !== "ready" || b.status !== "ready" || c.status !== "ready") return;
  assert.equal(configFingerprint(a.config), configFingerprint(b.config));
  assert.notEqual(configFingerprint(a.config), configFingerprint(c.config));
});

test("summary carries no secret material", () => {
  const result = loadConfig(
    envOf({ CLS_IDENTITY_HMAC_KEY: "hmac-secret" }),
    { secretId: "file-sid", secretKey: "file-skey" },
  );
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const summary = summarizeConfig(result.config);
  assert.ok(!summary.includes("file-sid"));
  assert.ok(!summary.includes("file-skey"));
  assert.ok(!summary.includes("hmac-secret"));
  assert.ok(!summary.includes(result.config.authorization));
  assert.ok(summary.includes("auth=set"));
  assert.ok(summary.includes("content=off"));
});

// --- shared-state restart semantics ---------------------------------------
//
// acquireCollector reads process.env, so these tests set and restore it. The
// shared state is process-wide; each test fully releases what it acquires.

// acquireCollector scrubs secrets from process.env after each load, so the
// overrides must be re-applied before every acquire.
function withProcessEnv(overrides: Record<string, string>, fn: (apply: () => void) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  const apply = () => Object.assign(process.env, REQUIRED_ENV, overrides);
  apply();
  return fn(apply).finally(() => {
    process.env = saved;
  });
}

test("config change restarts the exporter; same config reuses it", async () => {
  await withProcessEnv({}, async (apply) => {
    const logger = silentLogger();
    const first = acquireCollector(logger);
    assert.equal(first.status, "started");
    apply();
    const reused = acquireCollector(logger);
    assert.equal(reused.status, "reused");
    apply();
    const changed = acquireCollector(logger, { contentMode: "truncate" });
    assert.equal(changed.status, "started");
    if (changed.status === "started") {
      assert.equal(changed.contentMode, "truncate");
    }
    assert.ok(logger.lines.some((l) => l.includes("configuration changed")));
    await releaseCollector(logger);
    await releaseCollector(logger);
    await releaseCollector(logger);
  });
});

test("failure latch clears after a full stop so a fixed config recovers", async () => {
  await withProcessEnv({ CLS_ENDPOINT: "https://evil.example.com" }, async (apply) => {
    const logger = silentLogger();
    const bad = acquireCollector(logger);
    assert.equal(bad.status, "invalid");
    apply();
    const latched = acquireCollector(logger);
    assert.equal(latched.status, "invalid");
    await releaseCollector(logger);
    await releaseCollector(logger);
    // Latch cleared on full stop; fixing the (env-sourced) endpoint recovers.
    apply();
    process.env.CLS_ENDPOINT = REQUIRED_ENV.CLS_ENDPOINT;
    const fixed = acquireCollector(logger);
    assert.equal(fixed.status, "started");
    await releaseCollector(logger);
  });
});

// --- periodic stats (P1-4) -------------------------------------------------

function fakeTracerHandle(): TracerHandle {
  const span = {
    setAttributes: () => span,
    setStatus: () => span,
    addEvent: () => span,
    end: () => {},
    recordException: () => {},
    spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
    setAttribute: () => span,
    updateName: () => span,
    isRecording: () => true,
  };
  const tracer = {
    startSpan: () => span,
    startActiveSpan: (_name: string, fn: (s: unknown) => unknown) => fn(span),
  };
  return {
    tracer: tracer as unknown as TracerHandle["tracer"],
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

function configForStats(intervalMs: number): ClsObservabilityConfig {
  const result = loadConfig(envOf({ CLS_STATS_INTERVAL_MS: String(intervalMs) }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("unreachable");
  return result.config;
}

test("stats timer logs periodically and stops on shutdown", async () => {
  const logger = silentLogger();
  const collector = new Collector(configForStats(20), fakeTracerHandle(), logger);
  collector.start();
  await new Promise((resolve) => setTimeout(resolve, 70));
  await collector.shutdown();
  const statsLines = logger.lines.filter((l) => l.startsWith("info cls observability stats "));
  assert.ok(statsLines.length >= 2, `expected periodic stats lines, got ${statsLines.length}`);
  const afterShutdown = statsLines.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    logger.lines.filter((l) => l.startsWith("info cls observability stats ")).length,
    afterShutdown,
    "no stats after shutdown",
  );
});

test("statsIntervalMs=0 disables the periodic stats line", async () => {
  const logger = silentLogger();
  const collector = new Collector(configForStats(0), fakeTracerHandle(), logger);
  collector.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await collector.shutdown();
  assert.equal(
    logger.lines.filter((l) => l.startsWith("info cls observability stats ")).length,
    0,
  );
});

function requiredFile() {
  return {
    endpoint: "https://ap-shanghai.cls.tencentcs.com",
    traceTopicId: "topic-1",
    secretId: "sid",
    secretKey: "skey",
  };
}
