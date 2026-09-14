// Benchmark: per-model-call cost of the conversation fingerprint pipeline.
//
// Simulates a long agent session: each call appends an assistant tool_call and
// a tool response, then pays the production cost pattern — the cursor hashes
// the prefix and the full array, and the chat span hashes the full array for
// gen_ai.input.messages.hash (3 full passes per call).
//
// Baseline (old implementation): whole-array JSON.stringify + sha256 per pass.
// Current implementation: imported from dist (per-message memoized chain).
//
//   node scripts/bench-cursor.mjs [calls] [avgMsgKb]
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

const calls = Number(process.argv[2] ?? 300);
const avgKb = Number(process.argv[3] ?? 8);

const { messagesHash } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "dist", "src", "protocol", "messages.js"))
);

function oldMessagesHash(messages) {
  return createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex").slice(0, 32);
}

function makeConversation() {
  const messages = [{ role: "system", parts: [{ type: "text", content: "x".repeat(40_000) }] }];
  let bytes = 40_000;
  return { messages, bytes };
}

function appendRound(conv) {
  const args = `{"command":"${"find . -name ".repeat(200)}"}`;
  const result = "line of tool output\n".repeat(avgKb * 50);
  conv.messages.push(
    { role: "assistant", parts: [{ type: "tool_call", id: `call${conv.messages.length}`, name: "exec", arguments: args }] },
    { role: "tool", parts: [{ type: "text", content: result }] },
  );
  conv.bytes += args.length + result.length;
}

function runBench(label, hashFn) {
  const conv = makeConversation();
  let previous = 0;
  const started = process.hrtime.bigint();
  const tail = { at: Math.floor(calls * 0.8), ns: 0n, calls: 0 };
  for (let i = 0; i < calls; i++) {
    if (i === tail.at) {
      tail.mark = process.hrtime.bigint();
    }
    if (i >= tail.at) tail.calls += 1;
    appendRound(conv);
    // Production pattern: prefix verify + full record + full attribute hash.
    hashFn(conv.messages.slice(0, previous));
    hashFn(conv.messages);
    hashFn(conv.messages);
    previous = conv.messages.length;
  }
  const totalNs = process.hrtime.bigint() - started;
  const tailNs = process.hrtime.bigint() - tail.mark;
  const mb = (conv.bytes / 1e6).toFixed(1);
  console.log(
    `${label}: total ${Number(totalNs) / 1e6 | 0}ms, ` +
      `tail ${tail.calls} calls avg ${(Number(tailNs) / 1e6 / tail.calls).toFixed(1)}ms/call ` +
      `(${conv.messages.length} messages, ${mb}MB)`,
  );
}

runBench("baseline(whole-array x3)", oldMessagesHash);
runBench("current (memoized chain)", messagesHash);
