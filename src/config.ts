// Loads and validates CLS exporter configuration from the runtime environment.
import { createHmac, randomBytes } from "node:crypto";
import { hostname } from "node:os";

export type ContentMode = "off" | "truncate" | "full";
export type IdentityMode = "hash" | "raw" | "static";

/**
 * How the system prompt is reported.
 *
 * The system prompt is tens of KB. Under delta reporting it is sent once per
 * session rather than once per turn, so `full` is affordable and makes the
 * first chat a complete record of what the model received. `hash` keeps only a
 * fingerprint and length; `off` omits it entirely.
 */
export type SystemPromptMode = "full" | "hash" | "off";

/**
 * How model input is reported across the calls of a session.
 *
 * `delta` reports the whole conversation once and then only the messages each
 * later call adds, which keeps storage linear in turn count. `full` repeats the
 * entire conversation on every call, which is easier to read in isolation but
 * grows quadratically.
 */
export type InputMessagesMode = "delta" | "full";

export type ClsObservabilityConfig = {
  endpoint: string;
  tracesUrl: string;
  topicId: string;
  authorization: string;
  serviceName: string;
  serviceVersion?: string;
  serviceInstanceId: string;
  hostName: string;
  environment?: string;
  sampleRate: number;
  contentMode: ContentMode;
  systemPromptMode: SystemPromptMode;
  inputMessagesMode: InputMessagesMode;
  contentMaxChars: number;
  captureErrorMessages: boolean;
  identityMode: IdentityMode;
  identityHmacKey?: string;
  staticUserId?: string;
  staticUserName?: string;
  exportTimeoutMs: number;
  scheduledDelayMs: number;
  maxQueueSize: number;
  maxExportBatchSize: number;
  /**
   * How long to wait after `run.attempt.ended` before finalizing the run, so a
   * retried attempt can still attach. Retries arriving later are dropped as
   * orphans; raise this if provider backoff commonly exceeds the default.
   */
  attemptQuiescenceMs?: number;
  /** In-flight run cap; beyond it new runs are dropped and counted. */
  stateMaxActiveRuns?: number;
  /** Sessions whose delta cursor is retained in memory. */
  stateMaxCursorSessions?: number;
  /** ReAct rounds per run before the shape degrades onto the agent span. */
  stateMaxStepsPerRun?: number;
  /** Model-call spans per run. */
  stateMaxModelsPerRun?: number;
  /** Tool spans per run. */
  stateMaxToolsPerRun?: number;
  /** A run with no activity for this long is finalized (2h default). */
  stateRunIdleMs?: number;
  /** Periodic self-observability stats log interval; 0 disables it. */
  statsIntervalMs?: number;
};

/**
 * Plugin configuration from `plugins.entries.<id>.config` in openclaw.json,
 * already validated against the manifest configSchema by the host. Keys are
 * camelCase without the `CLS_` prefix (e.g. `contentMode`, `traceTopicId`).
 */
export type PluginFileConfig = Record<string, unknown>;

export type ConfigLoadResult =
  | { status: "ready"; config: ClsObservabilityConfig; warnings: string[] }
  | { status: "disabled"; reason: string }
  | { status: "invalid"; reason: string };

/**
 * Records a warning when a value was set but did not parse. A typo like
 * `CLS_CONTENT_MODE=truncated` silently disabling all content capture is
 * exactly the kind of misconfiguration that must be loud, not silent.
 */
function noteInvalid(
  warnings: string[],
  label: string,
  raw: unknown,
  parsed: unknown,
  fallback: unknown,
): void {
  if (raw !== undefined && parsed === undefined) {
    warnings.push(
      `${label}=${JSON.stringify(raw)} is not a recognized value; falling back to ${String(fallback)}`,
    );
  }
}

/** Environment wins over the plugin config file; either may be absent. */
function pickRaw(envRaw: string | undefined, fileVal: unknown): unknown {
  return envRaw !== undefined ? envRaw : fileVal;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

const DEFAULT_CLS_HOST_SUFFIXES = [".cls.tencentcs.com", ".cls.tencentyun.com"];

/**
 * Process-lifetime stash of credentials from the last successful load.
 *
 * Secrets are scrubbed from `process.env` right after reading, which collides
 * with config hot reload: the host re-registers the plugin in the SAME process,
 * where the env no longer carries them. The running exporter already holds the
 * resolved Authorization header in memory, so a module-level stash adds no new
 * exposure while letting reloads keep working. To disable the plugin, remove
 * the endpoint/topic or flip `entries.<id>.enabled` — deleting just the secrets
 * intentionally does NOT tear down a running exporter.
 */
const secretStash: {
  secretId?: string;
  secretKey?: string;
  identityHmacKey?: string;
} = {};

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseContentMode(raw: unknown): ContentMode | undefined {
  return raw === "off" || raw === "truncate" || raw === "full" ? raw : undefined;
}

function parseSystemPromptMode(raw: unknown): SystemPromptMode | undefined {
  return raw === "full" || raw === "hash" || raw === "off" ? raw : undefined;
}

function parseInputMessagesMode(raw: unknown): InputMessagesMode | undefined {
  return raw === "delta" || raw === "full" ? raw : undefined;
}

function parseIdentityMode(raw: unknown): IdentityMode | undefined {
  return raw === "hash" || raw === "raw" || raw === "static" ? raw : undefined;
}

function parseRate(raw: unknown): number | undefined {
  const value = asNumber(raw);
  if (value === undefined || value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function parsePositiveInt(raw: unknown): number | undefined {
  const value = asNumber(raw);
  if (value === undefined || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * Validates the CLS endpoint and derives the OTLP traces URL.
 *
 * Rejects credentials-bearing, non-HTTPS, or non-CLS hosts so the exporter can
 * never forward the CLS Authorization header to an unrelated origin.
 */
export function resolveTracesUrl(
  rawEndpoint: string,
  allowInsecureHosts: readonly string[] = [],
): { ok: true; url: string; endpoint: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint.includes("://") ? rawEndpoint : `https://${rawEndpoint}`);
  } catch {
    return { ok: false, reason: "CLS_ENDPOINT is not a valid URL" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "CLS_ENDPOINT must not embed credentials" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: "CLS_ENDPOINT must not contain query or fragment" };
  }
  const host = parsed.hostname.toLowerCase();
  const isAllowedDevHost = allowInsecureHosts.some((entry) => entry.toLowerCase() === host);
  const isClsHost = DEFAULT_CLS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!isClsHost && !isAllowedDevHost) {
    return { ok: false, reason: `CLS_ENDPOINT host is not an allowed CLS host: ${host}` };
  }
  if (parsed.protocol !== "https:" && !isAllowedDevHost) {
    return { ok: false, reason: "CLS_ENDPOINT must use https" };
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const url = `${parsed.origin}${basePath}/v1/traces`;
  return { ok: true, url, endpoint: parsed.origin };
}

/**
 * Reads configuration from the environment and the plugin config file
 * (`plugins.entries.cls-agent-observability.config`), environment first, and
 * immediately scrubs secrets from `process.env` so agent-spawned child
 * processes cannot inherit them.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  file?: PluginFileConfig,
): ConfigLoadResult {
  const warnings: string[] = [];
  const pick = (envKey: string, fileKey: string): unknown =>
    pickRaw(readTrimmed(env, envKey), file?.[fileKey]);

  const endpointRaw = asString(pick("CLS_ENDPOINT", "endpoint"));
  const topicId = asString(pick("CLS_TRACE_TOPIC_ID", "traceTopicId"));
  const envOrFileSecretId = asString(pick("CLS_SECRET_ID", "secretId"));
  const envOrFileSecretKey = asString(pick("CLS_SECRET_KEY", "secretKey"));
  // Hot reload runs in the same process after secrets were scrubbed from env;
  // fall back to the stash when the address (endpoint + topic) is still set.
  const secretId = envOrFileSecretId ?? (endpointRaw && topicId ? secretStash.secretId : undefined);
  const secretKey = envOrFileSecretKey ?? (endpointRaw && topicId ? secretStash.secretKey : undefined);
  const missing = [
    ["CLS_ENDPOINT / endpoint", endpointRaw],
    ["CLS_TRACE_TOPIC_ID / traceTopicId", topicId],
    ["CLS_SECRET_ID / secretId", secretId],
    ["CLS_SECRET_KEY / secretKey", secretKey],
  ].filter(([, value]) => value === undefined);
  if (missing.length === 4) {
    scrubSecrets(env);
    return { status: "disabled", reason: "no CLS configuration present" };
  }
  if (missing.length > 0) {
    scrubSecrets(env);
    return {
      status: "invalid",
      reason: `missing required config: ${missing.map(([key]) => key).join(", ")}`,
    };
  }
  if (
    (!readTrimmed(env, "CLS_SECRET_ID") && file?.secretId !== undefined) ||
    (!readTrimmed(env, "CLS_SECRET_KEY") && file?.secretKey !== undefined)
  ) {
    warnings.push(
      "credentials were read from the plugin config file; env vars are recommended " +
        "because the file sits on disk in plaintext",
    );
  }

  const allowInsecure = asStringList(
    pickRaw(readTrimmed(env, "CLS_ENDPOINT_DEV_ALLOWLIST"), file?.endpointDevAllowlist),
  );
  const resolved = resolveTracesUrl(endpointRaw as string, allowInsecure);
  if (!resolved.ok) {
    scrubSecrets(env);
    return { status: "invalid", reason: resolved.reason };
  }

  const rawContentMode = pick("CLS_CONTENT_MODE", "contentMode");
  const contentMode = parseContentMode(rawContentMode) ?? "off";
  noteInvalid(warnings, "contentMode", rawContentMode, parseContentMode(rawContentMode), "off");
  const rawSystemPromptMode = pick("CLS_SYSTEM_PROMPT_MODE", "systemPromptMode");
  const systemPromptMode = parseSystemPromptMode(rawSystemPromptMode) ?? "full";
  noteInvalid(
    warnings,
    "systemPromptMode",
    rawSystemPromptMode,
    parseSystemPromptMode(rawSystemPromptMode),
    "full",
  );
  const rawInputMessagesMode = pick("CLS_INPUT_MESSAGES_MODE", "inputMessagesMode");
  const inputMessagesMode = parseInputMessagesMode(rawInputMessagesMode) ?? "delta";
  noteInvalid(
    warnings,
    "inputMessagesMode",
    rawInputMessagesMode,
    parseInputMessagesMode(rawInputMessagesMode),
    "delta",
  );
  const rawIdentityMode = pick("CLS_IDENTITY_MODE", "identityMode");
  const parsedIdentityMode = parseIdentityMode(rawIdentityMode) ?? "hash";
  noteInvalid(
    warnings,
    "identityMode",
    rawIdentityMode,
    parseIdentityMode(rawIdentityMode),
    "hash",
  );
  const identityHmacKey =
    asString(pick("CLS_IDENTITY_HMAC_KEY", "identityHmacKey")) ?? secretStash.identityHmacKey;
  if (parsedIdentityMode === "hash" && !identityHmacKey) {
    warnings.push(
      "identityMode=hash requires identityHmacKey; falling back to static identity",
    );
  }

  const rawSampleRate = pick("CLS_TRACE_SAMPLE_RATE", "traceSampleRate");
  const sampleRate = parseRate(rawSampleRate) ?? 1;
  noteInvalid(warnings, "traceSampleRate", rawSampleRate, parseRate(rawSampleRate), 1);

  const rawCaptureErrors = pick("CLS_CAPTURE_ERROR_MESSAGES", "captureErrorMessages");
  const captureErrorMessages = asBool(rawCaptureErrors) ?? false;
  noteInvalid(warnings, "captureErrorMessages", rawCaptureErrors, asBool(rawCaptureErrors), false);

  const rawStatsInterval = pick("CLS_STATS_INTERVAL_MS", "statsIntervalMs");
  let statsIntervalMs = 300_000;
  if (rawStatsInterval !== undefined) {
    const parsed = asNumber(rawStatsInterval);
    if (parsed === undefined || parsed < 0) {
      warnings.push(
        `statsIntervalMs=${JSON.stringify(rawStatsInterval)} is not a non-negative number; using 300000`,
      );
    } else {
      statsIntervalMs = Math.floor(parsed);
    }
  }

  const config: ClsObservabilityConfig = {
    endpoint: resolved.endpoint,
    tracesUrl: resolved.url,
    topicId: topicId as string,
    authorization: `Basic ${Buffer.from(`${secretId}:${secretKey}`, "utf8").toString("base64")}`,
    serviceName: asString(pick("CLS_SERVICE_NAME", "serviceName")) ?? "openclaw-gateway",
    serviceVersion: asString(pick("CLS_SERVICE_VERSION", "serviceVersion")),
    serviceInstanceId:
      asString(pick("CLS_SERVICE_INSTANCE_ID", "serviceInstanceId")) ??
      readTrimmed(env, "HOSTNAME") ??
      randomBytes(8).toString("hex"),
    hostName: asString(pick("CLS_HOST_NAME", "hostName")) ?? hostname(),
    environment: asString(pick("CLS_DEPLOYMENT_ENVIRONMENT", "deploymentEnvironment")),
    sampleRate,
    contentMode,
    systemPromptMode,
    inputMessagesMode,
    // 1.1M chars: tool outputs are routinely tens of KB and the conversation
    // they join accumulates over turns; a KB-scale default would truncate
    // ordinary outputs, not just pathological ones.
    contentMaxChars:
      parsePositiveInt(pick("CLS_CONTENT_MAX_CHARS", "contentMaxChars")) ?? 1_100_000,
    captureErrorMessages,
    identityMode: parsedIdentityMode === "hash" && !identityHmacKey ? "static" : parsedIdentityMode,
    identityHmacKey,
    staticUserId: asString(pick("CLS_IDENTITY_STATIC_ID", "staticUserId")),
    staticUserName: asString(pick("CLS_IDENTITY_STATIC_NAME", "staticUserName")),
    exportTimeoutMs: parsePositiveInt(pick("CLS_EXPORT_TIMEOUT_MS", "exportTimeoutMs")) ?? 10_000,
    scheduledDelayMs: parsePositiveInt(pick("CLS_EXPORT_DELAY_MS", "exportDelayMs")) ?? 5_000,
    maxQueueSize: parsePositiveInt(pick("CLS_EXPORT_QUEUE_SIZE", "exportQueueSize")) ?? 2048,
    maxExportBatchSize:
      parsePositiveInt(pick("CLS_EXPORT_BATCH_SIZE", "exportBatchSize")) ?? 256,
    statsIntervalMs,
    ...optionalPositiveInt(warnings, "attemptQuiescenceMs", pick("CLS_ATTEMPT_QUIESCENCE_MS", "attemptQuiescenceMs")),
    ...optionalPositiveInt(warnings, "stateMaxActiveRuns", pick("CLS_STATE_MAX_ACTIVE_RUNS", "stateMaxActiveRuns")),
    ...optionalPositiveInt(warnings, "stateMaxCursorSessions", pick("CLS_STATE_MAX_CURSOR_SESSIONS", "stateMaxCursorSessions")),
    ...optionalPositiveInt(warnings, "stateMaxStepsPerRun", pick("CLS_STATE_MAX_STEPS_PER_RUN", "stateMaxStepsPerRun")),
    ...optionalPositiveInt(warnings, "stateMaxModelsPerRun", pick("CLS_STATE_MAX_MODELS_PER_RUN", "stateMaxModelsPerRun")),
    ...optionalPositiveInt(warnings, "stateMaxToolsPerRun", pick("CLS_STATE_MAX_TOOLS_PER_RUN", "stateMaxToolsPerRun")),
    ...optionalPositiveInt(warnings, "stateRunIdleMs", pick("CLS_STATE_RUN_IDLE_MS", "stateRunIdleMs")),
  };

  secretStash.secretId = secretId as string;
  secretStash.secretKey = secretKey as string;
  if (identityHmacKey) {
    secretStash.identityHmacKey = identityHmacKey;
  }
  scrubSecrets(env);
  return { status: "ready", config, warnings };
}

/** Reads an optional positive-integer value into a config field. */
function optionalPositiveInt(
  warnings: string[],
  label: string,
  raw: unknown,
): Record<string, number> {
  if (raw === undefined) {
    return {};
  }
  const value = parsePositiveInt(raw);
  if (value === undefined) {
    warnings.push(`${label}=${JSON.stringify(raw)} is not a positive integer; using the built-in default`);
    return {};
  }
  return { [label]: value };
}

/**
 * A stable fingerprint of the exporter-relevant configuration, used to detect
 * config-file edits that require an exporter restart. `serviceInstanceId` is
 * excluded because it defaults to a random value per boot.
 */
export function configFingerprint(config: ClsObservabilityConfig): string {
  const { serviceInstanceId: _ignored, ...rest } = config;
  return JSON.stringify(rest);
}

/** One-line, secret-free summary of the effective configuration. */
export function summarizeConfig(config: ClsObservabilityConfig): string {
  return (
    `endpoint=${config.endpoint} topic=${config.topicId} service=${config.serviceName}` +
    (config.environment ? ` env=${config.environment}` : "") +
    ` content=${config.contentMode}(max=${config.contentMaxChars})` +
    ` input=${config.inputMessagesMode} system=${config.systemPromptMode}` +
    ` identity=${config.identityMode} sample=${config.sampleRate}` +
    ` queue=${config.maxQueueSize} batch=${config.maxExportBatchSize}` +
    ` stats=${config.statsIntervalMs ?? 0}ms auth=set hmac=${config.identityHmacKey ? "set" : "unset"}`
  );
}

/** Removes CLS credentials from the environment shared with child processes. */
export function scrubSecrets(env: NodeJS.ProcessEnv): void {
  delete env.CLS_SECRET_ID;
  delete env.CLS_SECRET_KEY;
  delete env.CLS_IDENTITY_HMAC_KEY;
}

/** Builds a keyed, domain-separated pseudonym for an identifier. */
export function pseudonymize(
  config: ClsObservabilityConfig,
  domain: string,
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  if (config.identityMode === "raw") {
    return value;
  }
  if (!config.identityHmacKey) {
    return undefined;
  }
  return createHmac("sha256", config.identityHmacKey)
    .update(`${domain}:${value}`)
    .digest("hex")
    .slice(0, 32);
}
