// One-command end-to-end verification against a real OpenClaw Gateway.
//
// Runs the full production path rather than a replay: a real Gateway process
// loads the plugin, a real model answers, real tools execute, and spans are
// exported over OTLP. Replay tests cannot cover this path — the registry /
// plugin-service interaction is where a 100% data-loss defect once hid.
//
// Usage:
//   node probe/run-e2e.cjs [--local | --cls] [--keep]
//
//   --local  export to a local OTLP sink (default, no CLS credentials needed)
//   --cls    export to the real CLS topic (requires credentials)
//   --keep   leave the Gateway running after the run
//
// Credentials are read from environment variables only and are never logged.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// Host under test: the vendored 2026.6.5 checkout by default;
// E2E_OPENCLAW_BIN points at another version for the compatibility matrix.
const OPENCLAW = process.env.E2E_OPENCLAW_BIN
  ? path.resolve(process.env.E2E_OPENCLAW_BIN)
  : path.join(ROOT, ".cache", "openclaw-v2026.6.5", "openclaw.mjs");
// The plugin under test: tsc output by default; set E2E_PLUGIN_PATH to the
// dist-bundle directory to prove the shipped artifact (not the source) works.
const PLUGIN_DIST = process.env.E2E_PLUGIN_PATH
  ? path.resolve(process.env.E2E_PLUGIN_PATH)
  : path.join(ROOT, "dist", "index.js");
const PROBE = path.join(__dirname, "trace-probe", "index.cjs");

const WORK = "/tmp/oc-e2e";
const STATE_DIR = path.join(WORK, "state");
const CONFIG_PATH = path.join(WORK, "openclaw.json");
const CAPTURE_OUT = path.join(WORK, "captures", "e2e.jsonl");
const SINK_OUT = path.join(WORK, "sink-spans.jsonl");
const GATEWAY_LOG = path.join(WORK, "gateway.log");

const GATEWAY_PORT = 18931;
const SINK_PORT = 4431;
const GATEWAY_TOKEN = "e2e-local-token-do-not-reuse";

const MODE = process.argv.includes("--cls") ? "cls" : "local";
const KEEP = process.argv.includes("--keep");

/** Scenarios chosen to cover each span kind, the error path, and session reuse. */
const SCENARIOS = [
  { id: "single", session: "single", text: "只回答一个词：你好" },
  { id: "tool", session: "tool", text: "用 bash 执行 echo e2e-ok，然后简短确认" },
  { id: "parallel", session: "parallel", text: "依次用 bash 执行 pwd 和 whoami，然后总结两个输出" },
  { id: "error", session: "error", text: "用 bash 执行 cat /no-such-file-e2e，如果失败告诉我错误" },
  // Reuses the tool session so the second turn must report an input delta
  // instead of the whole conversation again.
  { id: "followup", session: "tool", text: "刚才那条命令的输出是什么？只回答输出内容" },
  // Produces a tool output past the default 4000-char display limit, then a
  // follow-up turn in the same session: under truncate mode the delta chain
  // must survive oversized payloads (review 2026-09-13, D-5).
  {
    id: "longoutput",
    session: "long",
    text: "用 bash 执行 seq 1 2000,然后告诉我最后一行是几",
  },
  { id: "longfollowup", session: "long", text: "刚才命令一共输出了多少行？只回答数字" },
  {
    id: "subagent",
    session: "subagent",
    text:
      "请立即调用 sessions_spawn 工具派生一个子任务,task 参数写:只回答四个字『子任务完成』。" +
      "label 参数写 e2e-子任务。不要自己执行这个任务,必须用 sessions_spawn 派生。" +
      "调用成功后只需告诉我已经派生。",
    // The spawn is non-blocking: the child run and its announce back into this
    // session happen after the parent turn returns.
    waitAfterMs: 75_000,
  },
];

function log(message) {
  console.log(`[e2e] ${message}`);
}

function fail(message) {
  console.error(`[e2e] ${message}`);
  process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal OTLP sink that counts spans so local runs need no credentials. */
function startSink() {
  fs.mkdirSync(path.dirname(SINK_OUT), { recursive: true });
  fs.writeFileSync(SINK_OUT, "");
  let requests = 0;
  let bytes = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests += 1;
      bytes += body.length;
      fs.appendFileSync(
        SINK_OUT,
        `${JSON.stringify({ at: Date.now(), bytes: body.length, topic: req.headers.topic_id || null, hasAuth: Boolean(req.headers.authorization) })}\n`,
      );
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end(Buffer.alloc(0));
    });
  });

  return new Promise((resolve) => {
    server.listen(SINK_PORT, () => {
      log(`local OTLP sink on http://127.0.0.1:${SINK_PORT}`);
      resolve({
        stop: () => new Promise((done) => server.close(() => done())),
        stats: () => ({ requests, bytes }),
      });
    });
  });
}

function run(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Writes the plugin registration, model provider, and gateway settings. */
async function prepareConfig(env, deepseekKey) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CAPTURE_OUT), { recursive: true });
  fs.writeFileSync(CAPTURE_OUT, "");

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "{}\n");
  }

  const patch = path.join(WORK, "patch.json5");
  fs.writeFileSync(
    patch,
    JSON.stringify(
      {
        gateway: { mode: "local", auth: { token: GATEWAY_TOKEN } },
        // A real model is required: the point of this script is to exercise the
        // production path, so the default placeholder model must be replaced.
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

  const result = await run("node", [OPENCLAW, "config", "patch", "--file", patch], { env });
  if (result.code !== 0) {
    throw new Error(`config patch failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  log("config prepared");
}

function startGateway(env) {
  fs.writeFileSync(GATEWAY_LOG, "");
  const child = spawn("node", [OPENCLAW, "gateway", "run", "--port", String(GATEWAY_PORT)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stream = fs.createWriteStream(GATEWAY_LOG, { flags: "a" });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  return child;
}

/** Waits until the plugin reports that the exporter is live. */
async function waitForExporter(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = fs.existsSync(GATEWAY_LOG) ? fs.readFileSync(GATEWAY_LOG, "utf8") : "";
    if (text.includes("CLS agent trace export enabled")) {
      return true;
    }
    if (/CLS configuration invalid/.test(text)) {
      const line = text.split("\n").find((l) => l.includes("CLS configuration invalid"));
      throw new Error(line ? line.trim() : "CLS configuration invalid");
    }
    await sleep(1000);
  }
  return false;
}

function summarizeCaptures() {
  if (!fs.existsSync(CAPTURE_OUT)) {
    return { lines: 0, hooks: [] };
  }
  const lines = fs
    .readFileSync(CAPTURE_OUT, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const hooks = new Set();
  for (const line of lines) {
    try {
      hooks.add(JSON.parse(line).hook);
    } catch {
      // Ignore malformed probe lines; they do not affect the assertion.
    }
  }
  return { lines: lines.length, hooks: [...hooks].sort() };
}

async function main() {
  if (!fs.existsSync(PLUGIN_DIST)) {
    fail(`plugin build missing: ${PLUGIN_DIST}\n      run: npm run build`);
    return;
  }

  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepseekKey) {
    fail("DEEPSEEK_API_KEY must be set in the environment");
    return;
  }

  const clsEnv = {};
  let sink;
  if (MODE === "cls") {
    const secretId = process.env.CLS_SECRET_ID;
    const secretKey = process.env.CLS_SECRET_KEY;
    const topicId = process.env.CLS_TRACE_TOPIC_ID;
    const region = process.env.CLS_REGION || "ap-shanghai";
    if (!secretId || !secretKey || !topicId) {
      fail("CLS mode needs CLS_SECRET_ID, CLS_SECRET_KEY and CLS_TRACE_TOPIC_ID");
      return;
    }
    Object.assign(clsEnv, {
      CLS_ENDPOINT: `https://${region}.cls.tencentcs.com`,
      CLS_TRACE_TOPIC_ID: topicId,
      CLS_SECRET_ID: secretId,
      CLS_SECRET_KEY: secretKey,
    });
    log(`export target: CLS ${region} (topic ${topicId.slice(0, 8)}…)`);
  } else {
    sink = await startSink();
    Object.assign(clsEnv, {
      CLS_ENDPOINT: `http://127.0.0.1:${SINK_PORT}`,
      CLS_ENDPOINT_DEV_ALLOWLIST: "127.0.0.1",
      CLS_TRACE_TOPIC_ID: "e2e-local",
      CLS_SECRET_ID: "e2e-local",
      CLS_SECRET_KEY: "e2e-local",
    });
    log("export target: local OTLP sink");
  }

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_CONFIG_PATH: CONFIG_PATH,
    PROBE_OUT: CAPTURE_OUT,
    DEEPSEEK_API_KEY: deepseekKey,
    ...clsEnv,
    CLS_CONTENT_MODE: process.env.CLS_CONTENT_MODE || "truncate",
    CLS_IDENTITY_MODE: "static",
    CLS_IDENTITY_STATIC_ID: "e2e-probe",
    CLS_SERVICE_NAME: "openclaw-gateway",
    CLS_DEPLOYMENT_ENVIRONMENT: "e2e",
    CLS_EXPORT_DELAY_MS: "800",
  };

  await prepareConfig(env, deepseekKey);

  log("starting gateway…");
  const gateway = startGateway(env);
  let gatewayExited = false;
  gateway.on("close", () => {
    gatewayExited = true;
  });

  const cleanup = async () => {
    if (!KEEP && !gatewayExited) {
      gateway.kill("SIGTERM");
      await sleep(3000);
      if (!gatewayExited) {
        gateway.kill("SIGKILL");
      }
    }
    if (sink) {
      await sink.stop();
    }
  };

  try {
    const ready = await waitForExporter(60_000);
    if (!ready) {
      throw new Error(`exporter did not start; see ${GATEWAY_LOG}`);
    }
    log("exporter live");

    const agentEnv = {
      ...env,
      OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${GATEWAY_PORT}`,
      OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    };

    let ok = 0;
    for (const scenario of SCENARIOS) {
      const result = await run(
        "node",
        [
          OPENCLAW,
          "agent",
          "--session-key",
          `agent:main:e2e:${scenario.session}`,
          "--message",
          scenario.text,
          "--timeout",
          "180",
        ],
        { env: agentEnv },
      );
      const reply = result.stdout
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("[plugins]"))
        .pop();
      if (result.code === 0 && reply) {
        ok += 1;
        log(`scenario ${scenario.id}: ok — ${reply.trim().slice(0, 60)}`);
      } else {
        log(`scenario ${scenario.id}: FAILED — ${(result.stderr || result.stdout).trim().slice(0, 120)}`);
      }
      if (scenario.waitAfterMs) {
        log(`scenario ${scenario.id}: waiting ${scenario.waitAfterMs / 1000}s for async work…`);
        await sleep(scenario.waitAfterMs);
      }
    }

    log("waiting for quiescence window and batch export…");
    await sleep(18_000);

    const gatewayText = fs.readFileSync(GATEWAY_LOG, "utf8");
    const flushErrors = gatewayText
      .split("\n")
      .filter((l) => /flush failed|export failed|dropped \d+ event/.test(l));

    const captures = summarizeCaptures();

    console.log("\n================ 结果 ================");
    console.log(`场景成功        ${ok}/${SCENARIOS.length}`);
    console.log(`Hook 抓取       ${captures.lines} 次 (${captures.hooks.length} 种)`);
    if (sink) {
      const stats = sink.stats();
      console.log(`OTLP 请求       ${stats.requests} 次, ${stats.bytes} 字节`);
    }
    console.log(`导出错误        ${flushErrors.length}`);
    for (const line of flushErrors.slice(0, 3)) {
      console.log(`  ${line.trim()}`);
    }
    console.log(`抓取数据        ${CAPTURE_OUT}`);
    console.log(`Gateway 日志    ${GATEWAY_LOG}`);

    let failed = false;
    if (ok !== SCENARIOS.length) {
      failed = true;
    }
    if (captures.lines === 0) {
      console.log("\n没有抓到任何 Hook —— 插件未被加载或未注册 Hook");
      failed = true;
    }
    if (flushErrors.length > 0) {
      failed = true;
    }
    if (sink && sink.stats().requests === 0) {
      console.log("\n没有收到 OTLP 请求 —— 导出链路未打通");
      failed = true;
    }

    if (MODE === "cls") {
      console.log("\n下一步：查询 CLS 确认落库");
      console.log(
        `  CLS_SECRET_ID=… CLS_SECRET_KEY=… node probe/query-cls.cjs ${process.env.CLS_REGION || "ap-shanghai"} <topicId> 10`,
      );
    }

    if (failed) {
      fail("端到端验证未通过");
    } else {
      console.log("\n端到端验证通过");
    }
  } catch (error) {
    fail(error.message);
  } finally {
    await cleanup();
    if (KEEP && !gatewayExited) {
      log(`gateway 仍在运行 (port ${GATEWAY_PORT})，结束后请手动停止`);
    }
  }
}

main().catch((error) => {
  fail(error.message);
});
