import assert from "node:assert/strict";
import test from "node:test";
import type { ClsObservabilityConfig } from "../src/config.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import {
  buildCommonAttributes,
  parseAnnounceRunId,
  resolveUserIdentity,
} from "../src/mapping/attributes.js";

const config = {
  identityMode: "static",
  staticUserId: "operator-1",
} as ClsObservabilityConfig;

test("static user id is also a safe display-name fallback", () => {
  assert.deepEqual(resolveUserIdentity(config, { runId: "r" }), {
    userId: "operator-1",
    userName: "operator-1",
  });
});

test("common attributes do not place agent id on every span", () => {
  const attrs = buildCommonAttributes({
    config,
    identity: { runId: "r", agentId: "main" },
    session: { clsSessionId: "s", lineageDegraded: false },
    turnId: "s:t1",
  });
  assert.equal(attrs["gen_ai.agent.id"], undefined);
  assert.equal(attrs["openclaw.agent.id"], "main");
});

// The spec builds session -> turn -> step as a prefix chain so the three ids
// can be related by prefix matching alone. A turn id that does not start with
// the session id breaks every such query.
test("turn id extends the session id so the naming chain holds", () => {
  const attrs = buildCommonAttributes({
    config,
    identity: { runId: "run-uuid", agentId: "main" },
    session: { clsSessionId: "sk-1234abcd", lineageDegraded: false },
    turnId: "sk-1234abcd:t3",
  });
  assert.equal(attrs["gen_ai.session.id"], "sk-1234abcd");
  assert.equal(attrs["gen_ai.turn.id"], "sk-1234abcd:t3");
  assert.match(String(attrs["gen_ai.turn.id"]), /^sk-1234abcd:t\d+$/);
  // The run id stays available as the collision-proof key.
  assert.equal(attrs["openclaw.run.id"], "run-uuid");
});

test("announce run ids parse into child session key and child run id", () => {
  assert.deepEqual(
    parseAnnounceRunId(
      "announce:v1:agent:main:subagent:7f22755d-5911-478a-b793-3ea772ce055b:742ec151-759f-41f2-9999-1b1ce8968ccf",
    ),
    {
      childSessionKey: "agent:main:subagent:7f22755d-5911-478a-b793-3ea772ce055b",
      childRunId: "742ec151-759f-41f2-9999-1b1ce8968ccf",
    },
  );
  // Ordinary run ids and unknown announce versions are left alone.
  assert.equal(parseAnnounceRunId("2a79a1a5-13cc-46f7-aa67-c4d81235c84a"), undefined);
  assert.equal(parseAnnounceRunId("announce:v2:whatever:x"), undefined);
  assert.equal(parseAnnounceRunId("announce:v1:only-session-key"), undefined);
});

test("session registry numbers turns from one and increments per session", () => {
  const registry = new SessionRegistry({ identityMode: "raw" } as ClsObservabilityConfig);
  assert.equal(registry.allocateTurnId("sk-a", 1_000), "sk-a:t1");
  assert.equal(registry.allocateTurnId("sk-a", 2_000), "sk-a:t2");
  assert.equal(registry.allocateTurnId("sk-b", 3_000), "sk-b:t1");
  assert.equal(registry.allocateTurnId("sk-a", 4_000), "sk-a:t3");
});

test("turn counters are dropped once a session goes idle", () => {
  const registry = new SessionRegistry({ identityMode: "raw" } as ClsObservabilityConfig);
  assert.equal(registry.allocateTurnId("sk-a", 1_000), "sk-a:t1");
  registry.prune(10_000, 5_000);
  // Still within the retention window, so numbering continues.
  assert.equal(registry.allocateTurnId("sk-a", 6_000), "sk-a:t2");
  registry.prune(10_000, 100_000);
  assert.equal(registry.allocateTurnId("sk-a", 101_000), "sk-a:t1");
});
