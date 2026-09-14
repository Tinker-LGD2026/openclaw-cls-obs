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

export function messagesHash(messages: readonly ClsMessage[]): string {
  return createHash("sha256").update(encodeMessages(messages), "utf8").digest("hex").slice(0, 32);
}
