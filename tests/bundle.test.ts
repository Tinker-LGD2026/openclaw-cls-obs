import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Tests run from dist/tests; the plugin root is two levels up.
const bundle = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist-bundle",
  "index.mjs",
);

test("bundle artifact exists and registers a plugin", async () => {
  assert.ok(existsSync(bundle), "run `npm run bundle` first");
  const mod = await import(bundle);
  const plugin = (mod as { default?: { id?: string; register?: unknown } }).default ?? mod;
  assert.equal((plugin as { id?: string }).id, "cls-agent-observability");
  assert.equal(typeof (plugin as { register?: unknown }).register, "function");
});
