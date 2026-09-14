import assert from "node:assert/strict";
import test from "node:test";
import {
  decideRoundForModel,
  deriveRoundFinishReason,
  type RoundFacts,
} from "../src/domain/rounds.js";

const round = (overrides: Partial<RoundFacts> = {}): RoundFacts => ({
  modelCalls: 1,
  successfulModelCalls: 1,
  failedModelCalls: 0,
  toolCalls: 0,
  ...overrides,
});

test("first model starts round one", () => {
  assert.deepEqual(decideRoundForModel(undefined), { action: "start", ambiguous: false });
});

test("model after tools starts the next round", () => {
  assert.deepEqual(decideRoundForModel(round({ toolCalls: 2 })), {
    action: "start",
    ambiguous: false,
  });
});

test("model after failed attempts stays in the same round", () => {
  assert.deepEqual(
    decideRoundForModel(
      round({ modelCalls: 2, successfulModelCalls: 0, failedModelCalls: 2, toolCalls: 0 }),
    ),
    { action: "reuse", ambiguous: false },
  );
});

test("successful model without tools followed by another model starts ambiguous round", () => {
  assert.deepEqual(decideRoundForModel(round()), { action: "start", ambiguous: true });
});

test("round finish reason reflects tool, error, and final stop", () => {
  assert.equal(deriveRoundFinishReason(round({ toolCalls: 1 })), "tool_calls");
  assert.equal(
    deriveRoundFinishReason(round({ successfulModelCalls: 0, failedModelCalls: 1 })),
    "error",
  );
  assert.equal(deriveRoundFinishReason(round()), "stop");
});
