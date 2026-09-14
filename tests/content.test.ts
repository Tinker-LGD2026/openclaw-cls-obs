import assert from "node:assert/strict";
import test from "node:test";
import type { ClsObservabilityConfig } from "../src/config.js";
import { buildOutputContentAttributes } from "../src/content/attributes.js";

const config = {
  contentMode: "full",
  contentMaxChars: 4_000,
} as ClsObservabilityConfig;

test("turn output uses only the final assistant text", () => {
  const attrs = buildOutputContentAttributes(config, {
    assistantTexts: ["准备调用工具", "最终答案"],
  });
  const messages = JSON.parse(String(attrs["gen_ai.output.messages"])) as Array<{
    role: string;
    parts: Array<{ type: string; content: string }>;
  }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.parts[0]?.content, "最终答案");
  assert.equal(attrs["openclaw.output.message_count"], 2);
});
