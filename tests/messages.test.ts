import assert from "node:assert/strict";
import test from "node:test";
import { encodeMessages, messagesHash, textMessage } from "../src/protocol/messages.js";

test("encodes CLS role plus parts message structure", () => {
  assert.equal(
    encodeMessages([textMessage("user", "你好")]),
    '[{"role":"user","parts":[{"type":"text","content":"你好"}]}]',
  );
});

test("message hash is stable and 32 lowercase hex chars", () => {
  const messages = [textMessage("assistant", "完成")];
  assert.equal(messagesHash(messages), messagesHash(messages));
  assert.match(messagesHash(messages), /^[0-9a-f]{32}$/);
});

test("message encoder preserves separate assistant messages", () => {
  const encoded = encodeMessages([
    textMessage("assistant", "第一段"),
    textMessage("assistant", "第二段"),
  ]);
  const parsed = JSON.parse(encoded) as unknown[];
  assert.equal(parsed.length, 2);
});

test("encodes tool call and tool response parts for chat round boundaries", async () => {
  const { toolCallMessage, toolResponseMessage } = await import("../src/protocol/messages.js");
  assert.deepEqual(toolCallMessage("call-1", "exec", '{"command":"pwd"}'), {
    role: "assistant",
    parts: [{ type: "tool_call", id: "call-1", name: "exec", arguments: '{"command":"pwd"}' }],
  });
  assert.deepEqual(toolResponseMessage("call-1", '{"ok":true}'), {
    role: "tool",
    parts: [{ type: "tool_call_response", id: "call-1", result: '{"ok":true}' }],
  });
});
