import assert from "node:assert/strict";
import test from "node:test";
import { SpanKind } from "@opentelemetry/api";
import { CLS_SPAN_CONTRACTS, otelKindFor } from "../src/protocol/contracts.js";

test("five CLS span kinds have exact operations", () => {
  assert.equal(CLS_SPAN_CONTRACTS.entry.operation, "enter_application");
  assert.equal(CLS_SPAN_CONTRACTS.agent.operation, "invoke_agent");
  assert.equal(CLS_SPAN_CONTRACTS.step.operation, "react");
  assert.equal(CLS_SPAN_CONTRACTS.chat.operation, "chat");
  assert.equal(CLS_SPAN_CONTRACTS.tool.operation, "execute_tool");
});

test("span names follow the CLS convention", () => {
  assert.match("invoke_agent main", CLS_SPAN_CONTRACTS.agent.namePattern);
  assert.match("react round_2", CLS_SPAN_CONTRACTS.step.namePattern);
  assert.doesNotMatch("react turn_2", CLS_SPAN_CONTRACTS.step.namePattern);
  assert.match("chat deepseek-chat", CLS_SPAN_CONTRACTS.chat.namePattern);
  assert.match("execute_tool exec", CLS_SPAN_CONTRACTS.tool.namePattern);
});

test("OTel kinds follow entry/internal/client roles", () => {
  assert.equal(otelKindFor("entry"), SpanKind.SERVER);
  assert.equal(otelKindFor("agent"), SpanKind.INTERNAL);
  assert.equal(otelKindFor("step"), SpanKind.INTERNAL);
  assert.equal(otelKindFor("chat"), SpanKind.CLIENT);
  assert.equal(otelKindFor("tool"), SpanKind.CLIENT);
  assert.equal(otelKindFor("extension"), SpanKind.INTERNAL);
});
