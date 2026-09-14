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
};

export type ConfigLoadResult =
  | { status: "ready"; config: ClsObservabilityConfig; warnings: string[] }
  | { status: "disabled"; reason: string }
  | { status: "invalid"; reason: string };

/**
 * Records a warning when an env var was set but did not parse. A typo like
 * `CLS_CONTENT_MODE=truncated` silently disabling all content capture is
 * exactly the kind of misconfiguration that must be loud, not silent.
 */
function noteFallback(
  warnings: string[],
  key: string,
  raw: string | undefined,
  parsed: unknown,
  fallback: unknown,
): void {
  if (raw !== undefined && parsed === fallback) {
    warnings.push(`${key}="${raw}" is not a recognized value; falling back to ${String(fallback)}`);
  }
}

const DEFAULT_CLS_HOST_SUFFIXES = [".cls.tencentcs.com", ".cls.tencentyun.com"];

const REQUIRED_KEYS = [
  "CLS_ENDPOINT",
  "CLS_TRACE_TOPIC_ID",
  "CLS_SECRET_ID",
  "CLS_SECRET_KEY",
] as const;

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseContentMode(raw: string | undefined): ContentMode {
  return raw === "truncate" || raw === "full" ? raw : "off";
}

function parseSystemPromptMode(raw: string | undefined): SystemPromptMode {
  return raw === "hash" || raw === "off" ? raw : "full";
}

function parseInputMessagesMode(raw: string | undefined): InputMessagesMode {
  return raw === "full" ? "full" : "delta";
}

function parseIdentityMode(raw: string | undefined): IdentityMode {
  return raw === "raw" || raw === "static" ? raw : "hash";
}

function parseRate(raw: string | undefined): number {
  if (!raw) {
    return 1;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return 1;
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
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
 * Reads configuration from the environment and immediately scrubs secrets from
 * `process.env` so agent-spawned child processes cannot inherit them.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoadResult {
  const present = REQUIRED_KEYS.filter((key) => readTrimmed(env, key) !== undefined);
  if (present.length === 0) {
    scrubSecrets(env);
    return { status: "disabled", reason: "no CLS configuration present" };
  }
  if (present.length !== REQUIRED_KEYS.length) {
    const missing = REQUIRED_KEYS.filter((key) => !present.includes(key));
    scrubSecrets(env);
    return { status: "invalid", reason: `missing required config: ${missing.join(", ")}` };
  }

  const endpointRaw = readTrimmed(env, "CLS_ENDPOINT") as string;
  const allowInsecure = (readTrimmed(env, "CLS_ENDPOINT_DEV_ALLOWLIST") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const resolved = resolveTracesUrl(endpointRaw, allowInsecure);
  if (!resolved.ok) {
    scrubSecrets(env);
    return { status: "invalid", reason: resolved.reason };
  }

  const secretId = readTrimmed(env, "CLS_SECRET_ID") as string;
  const secretKey = readTrimmed(env, "CLS_SECRET_KEY") as string;
  const warnings: string[] = [];

  const rawContentMode = readTrimmed(env, "CLS_CONTENT_MODE");
  const contentMode = parseContentMode(rawContentMode);
  noteFallback(warnings, "CLS_CONTENT_MODE", rawContentMode, contentMode, "off");
  const rawSystemPromptMode = readTrimmed(env, "CLS_SYSTEM_PROMPT_MODE");
  const systemPromptMode = parseSystemPromptMode(rawSystemPromptMode);
  noteFallback(warnings, "CLS_SYSTEM_PROMPT_MODE", rawSystemPromptMode, systemPromptMode, "full");
  const rawInputMessagesMode = readTrimmed(env, "CLS_INPUT_MESSAGES_MODE");
  const inputMessagesMode = parseInputMessagesMode(rawInputMessagesMode);
  noteFallback(warnings, "CLS_INPUT_MESSAGES_MODE", rawInputMessagesMode, inputMessagesMode, "delta");
  const rawIdentityMode = readTrimmed(env, "CLS_IDENTITY_MODE");
  const identityMode = parseIdentityMode(rawIdentityMode);
  noteFallback(warnings, "CLS_IDENTITY_MODE", rawIdentityMode, identityMode, "hash");
  const identityHmacKey = readTrimmed(env, "CLS_IDENTITY_HMAC_KEY");
  if (identityMode === "hash" && !identityHmacKey) {
    warnings.push(
      "CLS_IDENTITY_MODE=hash requires CLS_IDENTITY_HMAC_KEY; falling back to static identity",
    );
  }

  const rawSampleRate = readTrimmed(env, "CLS_TRACE_SAMPLE_RATE");
  const sampleRate = parseRate(rawSampleRate);
  noteFallback(warnings, "CLS_TRACE_SAMPLE_RATE", rawSampleRate, sampleRate, 1);

  const config: ClsObservabilityConfig = {
    endpoint: resolved.endpoint,
    tracesUrl: resolved.url,
    topicId: readTrimmed(env, "CLS_TRACE_TOPIC_ID") as string,
    authorization: `Basic ${Buffer.from(`${secretId}:${secretKey}`, "utf8").toString("base64")}`,
    serviceName: readTrimmed(env, "CLS_SERVICE_NAME") ?? "openclaw-gateway",
    serviceVersion: readTrimmed(env, "CLS_SERVICE_VERSION"),
    serviceInstanceId:
      readTrimmed(env, "CLS_SERVICE_INSTANCE_ID") ??
      readTrimmed(env, "HOSTNAME") ??
      randomBytes(8).toString("hex"),
    hostName: readTrimmed(env, "CLS_HOST_NAME") ?? hostname(),
    environment: readTrimmed(env, "CLS_DEPLOYMENT_ENVIRONMENT"),
    sampleRate,
    contentMode,
    systemPromptMode,
    inputMessagesMode,
    // 1.1M chars: tool outputs are routinely tens of KB and the conversation
    // they join accumulates over turns; a KB-scale default would truncate
    // ordinary outputs, not just pathological ones.
    contentMaxChars: parsePositiveInt(readTrimmed(env, "CLS_CONTENT_MAX_CHARS"), 1_100_000),
    captureErrorMessages: readTrimmed(env, "CLS_CAPTURE_ERROR_MESSAGES") === "true",
    identityMode: identityMode === "hash" && !identityHmacKey ? "static" : identityMode,
    identityHmacKey,
    staticUserId: readTrimmed(env, "CLS_IDENTITY_STATIC_ID"),
    staticUserName: readTrimmed(env, "CLS_IDENTITY_STATIC_NAME"),
    exportTimeoutMs: parsePositiveInt(readTrimmed(env, "CLS_EXPORT_TIMEOUT_MS"), 10_000),
    scheduledDelayMs: parsePositiveInt(readTrimmed(env, "CLS_EXPORT_DELAY_MS"), 5_000),
    maxQueueSize: parsePositiveInt(readTrimmed(env, "CLS_EXPORT_QUEUE_SIZE"), 2048),
    maxExportBatchSize: parsePositiveInt(readTrimmed(env, "CLS_EXPORT_BATCH_SIZE"), 256),
    ...optionalPositiveInt(env, warnings, "CLS_ATTEMPT_QUIESCENCE_MS", "attemptQuiescenceMs"),
    ...optionalPositiveInt(env, warnings, "CLS_STATE_MAX_ACTIVE_RUNS", "stateMaxActiveRuns"),
    ...optionalPositiveInt(env, warnings, "CLS_STATE_MAX_CURSOR_SESSIONS", "stateMaxCursorSessions"),
    ...optionalPositiveInt(env, warnings, "CLS_STATE_MAX_STEPS_PER_RUN", "stateMaxStepsPerRun"),
    ...optionalPositiveInt(env, warnings, "CLS_STATE_MAX_MODELS_PER_RUN", "stateMaxModelsPerRun"),
    ...optionalPositiveInt(env, warnings, "CLS_STATE_MAX_TOOLS_PER_RUN", "stateMaxToolsPerRun"),
    ...optionalPositiveInt(env, warnings, "CLS_STATE_RUN_IDLE_MS", "stateRunIdleMs"),
  };

  scrubSecrets(env);
  return { status: "ready", config, warnings };
}

/** Reads an optional positive-integer env var into a config field. */
function optionalPositiveInt(
  env: NodeJS.ProcessEnv,
  warnings: string[],
  key: string,
  field: string,
): Record<string, number> {
  const raw = readTrimmed(env, key);
  if (raw === undefined) {
    return {};
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    warnings.push(`${key}="${raw}" is not a positive integer; using the built-in default`);
    return {};
  }
  return { [field]: Math.floor(value) };
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
