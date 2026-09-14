import assert from "node:assert/strict";
import test from "node:test";
import {
  MessageCursor,
  buildTurnMessages,
  canonicalToolCallId,
  normalizeHistoryMessage,
  roundMessages,
} from "../src/domain/conversation.js";
import { textMessage } from "../src/protocol/messages.js";

test("normalizes a plain user history entry", () => {
  assert.deepEqual(normalizeHistoryMessage({ role: "user", content: "你好" }), {
    role: "user",
    parts: [{ type: "text", content: "你好" }],
  });
});

test("normalizes an assistant tool call history entry", () => {
  assert.deepEqual(
    normalizeHistoryMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "exec",
          arguments: { command: "pwd" },
          partialArgs: '{"command": "pwd"}',
        },
      ],
    }),
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "call1", name: "exec", arguments: '{"command":"pwd"}' }],
    },
  );
});

test("normalizes a tool result history entry to the tool role", () => {
  assert.deepEqual(
    normalizeHistoryMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "ok" }],
    }),
    {
      role: "tool",
      parts: [{ type: "tool_call_response", id: "call1", result: "ok" }],
    },
  );
});

test("drops history entries with no renderable content", () => {
  assert.equal(normalizeHistoryMessage({ role: "assistant", content: [] }), undefined);
  assert.equal(normalizeHistoryMessage(null), undefined);
});

test("builds the full model input as system, history, then current user", () => {
  const messages = buildTurnMessages({
    systemPrompt: "SYS",
    prompt: "现在呢",
    history: [
      { role: "user", content: "之前" },
      { role: "assistant", content: [{ type: "text", text: "好的" }] },
    ],
    includeSystemPrompt: true,
  });
  assert.deepEqual(
    messages.map((message: { role: string }) => message.role),
    ["system", "user", "assistant", "user"],
  );
  assert.equal(messages[3]?.parts[0]?.type === "text" && messages[3].parts[0].content, "现在呢");
});

test("omits the system prompt when it is not opted in", () => {
  const messages = buildTurnMessages({
    systemPrompt: "SYS",
    prompt: "hi",
    history: [],
    includeSystemPrompt: false,
  });
  assert.deepEqual(
    messages.map((message: { role: string }) => message.role),
    ["user"],
  );
});

test("cursor reports full input first and deltas afterwards", () => {
  const cursor = new MessageCursor();
  const first = [textMessage("user", "a"), textMessage("assistant", "b")];
  assert.deepEqual(cursor.next("session-a", first), {
    mode: "full",
    start: 0,
    reason: "first_report",
  });
  const second = [...first, textMessage("user", "c")];
  assert.deepEqual(cursor.next("session-a", second), { mode: "delta", start: 2 });
});

test("cursor falls back to full input when the conversation shrinks", () => {
  const cursor = new MessageCursor();
  cursor.next("session-a", [textMessage("user", "a"), textMessage("assistant", "b")]);
  assert.deepEqual(cursor.next("session-a", [textMessage("user", "c")]), {
    mode: "full",
    start: 0,
    reason: "conversation_shrank",
  });
});

test("cursor falls back to full input when the reported prefix changed", () => {
  const cursor = new MessageCursor();
  cursor.next("session-a", [textMessage("user", "a"), textMessage("assistant", "b")]);
  // Compaction can rewrite earlier turns while keeping the count growing; a
  // delta against a prefix the backend never saw would be unreadable.
  const rewritten = [
    textMessage("user", "rewritten"),
    textMessage("assistant", "b"),
    textMessage("user", "c"),
  ];
  assert.deepEqual(cursor.next("session-a", rewritten), {
    mode: "full",
    start: 0,
    reason: "prefix_changed",
  });
});

test("cursor keeps sessions independent", () => {
  const cursor = new MessageCursor();
  cursor.next("session-a", [textMessage("user", "a")]);
  assert.deepEqual(cursor.next("session-b", [textMessage("user", "b")]), {
    mode: "full",
    start: 0,
    reason: "first_report",
  });
});

test("cursor evicts the oldest session once the cap is reached", () => {
  const cursor = new MessageCursor(2);
  cursor.next("s1", [textMessage("user", "a")]);
  cursor.next("s2", [textMessage("user", "b")]);
  cursor.next("s3", [textMessage("user", "c")]);
  assert.equal(cursor.size, 2);
  // s1 was evicted, so it must be reported in full again rather than as a
  // delta against state the process no longer holds.
  assert.deepEqual(cursor.next("s1", [textMessage("user", "a"), textMessage("user", "d")]), {
    mode: "full",
    start: 0,
    reason: "first_report",
  });
});

test("canonical tool call ids mirror the host's strict provider sanitization", () => {
  assert.equal(canonicalToolCallId("call_00_AmnhUMx6REOKD94MyWCH8073"), "call00AmnhUMx6REOKD94MyWCH8073");
  assert.equal(canonicalToolCallId("call00AmnhUMx6"), "call00AmnhUMx6");
  assert.equal(canonicalToolCallId("toolu-01.a:b"), "toolu01ab");
  assert.equal(canonicalToolCallId(""), "");
});

test("intra-turn tool responses match how the host replays them next turn", () => {
  const toolResultEnvelope = JSON.stringify({
    content: [{ type: "text", text: "cat: missing: No such file" }],
    details: { status: "completed", exitCode: 1 },
  });

  // What the current turn observed through the tool hooks: the provider's own
  // id, which still contains separators.
  const live = roundMessages([
    {
      toolCallId: "call_00_Abc123",
      toolName: "exec",
      argumentsText: '{"command":"cat missing"}',
      resultText: toolResultEnvelope,
    },
  ]);

  // What the same exchange looks like in the next turn's history payload: the
  // host has sanitized the id for provider replay.
  const replayed = buildTurnMessages({
    prompt: "再来一次",
    includeSystemPrompt: false,
    history: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call00Abc123",
            name: "exec",
            arguments: { command: "cat missing" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call00Abc123",
        toolName: "exec",
        content: [{ type: "text", text: "cat: missing: No such file" }],
      },
    ],
  }).slice(0, 2);

  // Divergence here would make every later turn fall back to a full report.
  assert.deepEqual(live, replayed);
});
