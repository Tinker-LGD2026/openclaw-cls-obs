// Starts a persistent local OpenClaw gateway with the CLS observability plugin,
// for manual full-chain trials through the web control UI.
//
// Usage:
//   node probe/run-local.cjs                 # export to real CLS (needs creds)
//   node probe/run-local.cjs --print-only    # only write config, print the URL
//
// State lives in /tmp/oc-local so repeated runs keep the same sessions.
// Stop with Ctrl-C; the gateway is the foreground process.

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OPENCLAW = process.env.E2E_OPENCLAW_BIN
  ? path.resolve(process.env.E2E_OPENCLAW_BIN)
  : path.join(ROOT, ".cache", "openclaw-v2026.6.5", "openclaw.mjs");
const PLUGIN_DIST = path.join(ROOT, "extensions", "cls-agent-observability", "dist", "index.js");
const PROBE = path.join(__dirname, "trace-probe.cjs");

const WORK = "/tmp/oc-local";
const STATE_DIR = path.join(WORK, "state");
const CONFIG_PATH = path.join(WORK, "openclaw.json");
const CAPTURE_OUT = path.join(WORK, "captures", "local.jsonl");
const GATEWAY_PORT = Number(process.env.LOCAL_PORT || 18935);

// The token is generated once and persisted in the work dir so the URL stays
// stable across restarts.
const TOKEN_PATH = path.join(WORK, "gateway-token");

function readOrCreateToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    fs.mkdirSync(WORK, { recursive: true });
    const token = `local-${crypto.randomBytes(12).toString("hex")}`;
    fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
    return token;
  }
}

async function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...(env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const secretId = process.env.CLS_SECRET_ID;
  const secretKey = process.env.CLS_SECRET_KEY;
  const topicId = process.env.CLS_TRACE_TOPIC_ID;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const region = process.env.CLS_REGION || "ap-shanghai";
  if (!secretId || !secretKey || !topicId || !deepseekKey) {
    console.error(
      "needs DEEPSEEK_API_KEY, CLS_SECRET_ID, CLS_SECRET_KEY, CLS_TRACE_TOPIC_ID (source 信息.md first)",
    );
    process.exit(2);
  }

  const token = readOrCreateToken();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CAPTURE_OUT), { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "{}\n");
  }

  const patch = path.join(WORK, "patch.json5");
  fs.writeFileSync(
    patch,
    JSON.stringify(
      {
        gateway: { mode: "local", auth: { token } },
        agents: { defaults: { model: "deepseek/deepseek-chat" } },
        models: { providers: { deepseek: { apiKey: deepseekKey } } },
        plugins: {
          load: { paths: [PROBE, PLUGIN_DIST] },
          allow: ["trace-probe", "cls-agent-observability"],
          entries: {
            "trace-probe": { enabled: true, hooks: { allowConversationAccess: true } },
            "cls-agent-observability": {
              enabled: true,
              hooks: { allowConversationAccess: true },
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_CONFIG_PATH: CONFIG_PATH,
    PROBE_OUT: CAPTURE_OUT,
    DEEPSEEK_API_KEY: deepseekKey,
    CLS_ENDPOINT: `https://${region}.cls.tencentcs.com`,
    CLS_TRACE_TOPIC_ID: topicId,
    CLS_SECRET_ID: secretId,
    CLS_SECRET_KEY: secretKey,
    CLS_CONTENT_MODE: process.env.CLS_CONTENT_MODE || "truncate",
    CLS_IDENTITY_MODE: "static",
    CLS_IDENTITY_STATIC_ID: process.env.CLS_IDENTITY_STATIC_ID || "local-trial",
    CLS_SERVICE_NAME: "openclaw-gateway",
    CLS_DEPLOYMENT_ENVIRONMENT: "local",
    CLS_EXPORT_DELAY_MS: "800",
  };

  const patched = await run("node", [OPENCLAW, "config", "patch", "--file", patch], env);
  if (patched.code !== 0) {
    console.error(`config patch failed: ${patched.stderr.trim() || patched.stdout.trim()}`);
    process.exit(1);
  }

  const url = `http://127.0.0.1:${GATEWAY_PORT}/?token=${token}`;
  console.log(`\nOpenClaw 本地实例`);
  console.log(`  Web 入口:   ${url}`);
  console.log(`  state:      ${STATE_DIR}`);
  console.log(`  capture:    ${CAPTURE_OUT}`);
  console.log(`  导出目标:   CLS ${region} topic=${topicId.slice(0, 8)}… contentMode=${env.CLS_CONTENT_MODE}`);
  console.log(`  停止:       Ctrl-C\n`);

  if (process.argv.includes("--print-only")) {
    return;
  }

  const gateway = spawn("node", [OPENCLAW, "gateway", "run", "--port", String(GATEWAY_PORT)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logStream = fs.createWriteStream(path.join(WORK, "gateway.log"), { flags: "a" });
  gateway.stdout.pipe(logStream);
  gateway.stderr.pipe(logStream);
  // Also mirror to the console so plugin warnings (config fallbacks, export
  // errors) are visible during the trial.
  gateway.stderr.on("data", (d) => process.stderr.write(d));
  gateway.stdout.on("data", (d) => {
    const text = d.toString();
    if (/cls observability|trace export|error/i.test(text)) {
      process.stdout.write(text);
    }
  });
  gateway.on("close", (code) => {
    console.log(`gateway exited with code ${code}`);
    process.exit(code ?? 0);
  });
  console.log("gateway starting…(日志同时写入 /tmp/oc-local/gateway.log)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
