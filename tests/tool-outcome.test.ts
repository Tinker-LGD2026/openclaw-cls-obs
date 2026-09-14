import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolOutcome } from "../src/domain/tool-outcome.js";

test("hook error takes precedence", () => {
  assert.deepEqual(classifyToolOutcome("read", undefined, "permission denied"), {
    status: "error",
    errorType: "tool_error",
  });
});

test("exec non-zero exit is an execution error", () => {
  assert.deepEqual(
    classifyToolOutcome("exec", { status: "completed", exitCode: 1 }, undefined),
    { status: "error", errorType: "execution_error" },
  );
});

test("exec zero exit and ordinary tool results are successful", () => {
  assert.deepEqual(classifyToolOutcome("exec", { exitCode: 0 }, undefined), { status: "ok" });
  assert.deepEqual(classifyToolOutcome("read", undefined, undefined), { status: "ok" });
});

test("invalid exit code is ignored", () => {
  assert.deepEqual(classifyToolOutcome("exec", { exitCode: Number.NaN }, undefined), {
    status: "ok",
  });
});
