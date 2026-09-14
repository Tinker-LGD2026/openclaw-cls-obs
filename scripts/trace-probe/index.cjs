// Probe plugin: records every observation hook payload for offline analysis.
const fs = require("node:fs");
const path = require("node:path");

const OUT = process.env.PROBE_OUT || "/tmp/openclaw-probe.jsonl";

function safeClone(value, depth = 0) {
  // History messages nest content parts several levels deep; a shallow cap made
  // earlier captures show "[deep]" and hid the structure that must be mapped.
  if (depth > 8) {
    return "[deep]";
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && value.length > 400
      ? `${value.slice(0, 400)}…(${value.length})`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) => safeClone(entry, depth + 1));
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "function") {
      out[key] = "[fn]";
      continue;
    }
    try {
      out[key] = safeClone(entry, depth + 1);
    } catch {
      out[key] = "[unserializable]";
    }
  }
  return out;
}

function record(hookName, event, ctx) {
  const line = JSON.stringify({
    at: Date.now(),
    hook: hookName,
    // The whole point of the probe: learn whether ctx.trace is populated and
    // how runId/sessionKey/callId relate across hooks in a real run.
    ctxTrace: ctx && ctx.trace ? ctx.trace : null,
    ctxKeys: ctx ? Object.keys(ctx) : [],
    eventKeys: event ? Object.keys(event) : [],
    ctx: safeClone(ctx),
    event: safeClone(event),
  });
  try {
    fs.appendFileSync(OUT, `${line}\n`);
  } catch {
    // Probe must never break the run.
  }
}

const HOOKS = [
  "before_agent_run",
  "before_agent_start",
  "before_prompt_build",
  "message_received",
  "model_call_started",
  "before_message_write",
  "model_call_ended",
  "llm_input",
  "llm_output",
  "before_tool_call",
  "after_tool_call",
  "agent_end",
  "before_agent_finalize",
  "session_start",
  "session_end",
  "before_compaction",
  "after_compaction",
  "subagent_spawned",
  "subagent_ended",
  "gateway_start",
  "gateway_stop",
];

// Register can run more than once per gateway process (bootstrap + runtime
// registries). Truncating here wiped everything captured before the second
// registration; the run scripts own file lifecycle instead.
let marked = false;

module.exports = {
  id: "trace-probe",
  name: "Trace Probe",
  register(api) {
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      if (!fs.existsSync(OUT)) {
        fs.writeFileSync(OUT, "");
      }
      if (!marked) {
        marked = true;
        fs.appendFileSync(OUT, `${JSON.stringify({ at: Date.now(), hook: "probe_register" })}\n`);
      }
    } catch {
      // ignore
    }
    for (const hookName of HOOKS) {
      api.on(hookName, (event, ctx) => {
        record(hookName, event, ctx);
        return undefined;
      });
    }
  },
};
