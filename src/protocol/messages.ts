// CLS Agent message wire format.
import { createHash } from "node:crypto";

export type ClsTextPart = {
  type: "text";
  content: string;
};

export type ClsToolCallPart = {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string;
};

export type ClsToolResponsePart = {
  type: "tool_call_response";
  id: string;
  result: string;
};

export type ClsMessagePart = ClsTextPart | ClsToolCallPart | ClsToolResponsePart;

export type ClsMessage = {
  role: "system" | "user" | "assistant" | "tool";
  parts: ClsMessagePart[];
};

export function textMessage(role: "system" | "user" | "assistant", content: string): ClsMessage {
  return { role, parts: [{ type: "text", content }] };
}

export function toolCallMessage(
  id: string,
  name: string,
  argumentsText: string,
): ClsMessage {
  return {
    role: "assistant",
    parts: [{ type: "tool_call", id, name, arguments: argumentsText }],
  };
}

export function toolResponseMessage(id: string, result: string): ClsMessage {
  return {
    role: "tool",
    parts: [{ type: "tool_call_response", id, result }],
  };
}

export function encodeMessages(messages: readonly ClsMessage[]): string {
  return JSON.stringify(messages);
}

/**
 * Per-message hash memo keyed by object identity.
 *
 * A run's conversation array is stable within a turn: the prefix messages are
 * the same objects on every model call, and only the tail grows. Fingerprinting
 * per message and memoizing by reference means each message is serialized once
 * per process instead of once per call — the per-call cost drops from three
 * whole-array serializations to the handful of new tail messages. A WeakMap is
 * used so entries die with the conversation that owns them.
 */
const messageHashMemo = new WeakMap<ClsMessage, string>();

function singleMessageHash(message: ClsMessage): string {
  let hash = messageHashMemo.get(message);
  if (!hash) {
    hash = createHash("sha256").update(JSON.stringify(message), "utf8").digest("hex");
    messageHashMemo.set(message, hash);
  }
  return hash;
}

/**
 * Content fingerprint of a message array.
 *
 * The chain construction (hash of ordered per-message hashes) gives the same
 * equality semantics as hashing the whole array while letting unchanged
 * prefixes reuse their memoized per-message hashes. The digest is truncated to
 * 32 hex chars, matching the field budget of the CLS hash attribute.
 */
export function messagesHash(messages: readonly ClsMessage[]): string {
  const chain = createHash("sha256");
  for (const message of messages) {
    chain.update(singleMessageHash(message), "utf8");
  }
  return chain.digest("hex").slice(0, 32);
}
