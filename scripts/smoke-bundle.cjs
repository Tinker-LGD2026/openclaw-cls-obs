// Smoke-tests the bundled artifact through a real gateway + local OTLP sink.
// Fails unless the bundle loads, the scenarios complete, and the exported
// spans include per-call usage on chat spans.
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const bundle = path.join(ROOT, "dist-bundle");

const child = spawn("node", [path.join(ROOT, "scripts", "run-e2e.cjs"), "--local"], {
  env: { ...process.env, E2E_PLUGIN_PATH: bundle, CLS_CONTENT_MODE: "truncate" },
  stdio: "inherit",
});
child.on("close", (code) => process.exit(code ?? 1));
