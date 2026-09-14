// Reconstructs the model's conversation from OpenClaw hook payloads.
//
// `llm_input` is turn-scoped and carries the structured prior conversation,
// while tool hooks carry the messages produced inside the current turn. Together
// they reproduce what the model actually received on each call, which is what
// the CLS message fields are meant to describe.
import {
  type ClsMessage,
  type ClsMessagePart,
  messagesHash,
  textMessage,
  toolCallMessage,
  toolResponseMessage,
} from "../protocol/messages.js";

/**
 * Canonicalizes a tool call id.
 *
 * OpenClaw sanitizes tool call ids to `[A-Za-z0-9]` before replaying history to
 * a provider, so the same call appears as `call_00_Abc` while it runs and as
 * `call00Abc` in every later turn. Reporting both forms would break the link
 * between a tool span and its message parts and would make each turn look like
 * a rewritten conversation. The sanitized form is the one that survives, so it
 * is used as the single identifier; the raw provider id is kept alongside the
 * tool span when the two differ.
 */
export function canonicalToolCallId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "");
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Serializes tool arguments, preferring the structured form over the raw text. */
function stringifyArguments(part: UnknownRecord): string {
  const structured = part.arguments;
  if (typeof structured === "string") {
    return structured;
  }
  if (structured !== undefined) {
    try {
      return JSON.stringify(structured);
    } catch {
      // Fall through to the partial text captured by the host.
    }
  }
  return asText(part.partialArgs) ?? "{}";
}

function contentParts(content: unknown): ClsMessagePart[] {
  const direct = asText(content);
  if (direct) {
    return [{ type: "text", content: direct }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: ClsMessagePart[] = [];
  for (const entry of content) {
    const part = asRecord(entry);
    if (!part) {
      const raw = asText(entry);
      if (raw) {
        parts.push({ type: "text", content: raw });
      }
      continue;
    }
    const type = asText(part.type);
    if (type === "toolCall" || type === "tool_call") {
      parts.push({
        type: "tool_call",
        id: canonicalToolCallId(asText(part.id) ?? ""),
        name: asText(part.name) ?? "",
        arguments: stringifyArguments(part),
      });
      continue;
    }
    const text = asText(part.text) ?? asText(part.content) ?? asText(part.thinking);
    if (text) {
      parts.push({ type: "text", content: text });
    }
  }
  return parts;
}

/** Maps one OpenClaw history entry onto a CLS message. */
export function normalizeHistoryMessage(raw: unknown): ClsMessage | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const role = asText(record.role);
  if (role === "toolResult" || role === "tool") {
    const parts = contentParts(record.content);
    const result = parts
      .map((part) => (part.type === "text" ? part.content : ""))
      .filter((text) => text.length > 0)
      .join("\n");
    const id = canonicalToolCallId(asText(record.toolCallId) ?? asText(record.id) ?? "");
    return result.length > 0 || id.length > 0 ? toolResponseMessage(id, result) : undefined;
  }
  const parts = contentParts(record.content);
  if (parts.length === 0) {
    return undefined;
  }
  if (role === "system" || role === "developer") {
    return { role: "system", parts };
  }
  if (role === "user") {
    return { role: "user", parts };
  }
  return { role: "assistant", parts };
}

export type TurnMessageInput = {
  systemPrompt?: string;
  prompt?: string;
  history?: readonly unknown[];
  includeSystemPrompt: boolean;
};

/** Builds the model input for the start of a turn. */
export function buildTurnMessages(input: TurnMessageInput): ClsMessage[] {
  const messages: ClsMessage[] = [];
  if (input.includeSystemPrompt && input.systemPrompt) {
    messages.push(textMessage("system", input.systemPrompt));
  }
  for (const entry of input.history ?? []) {
    const message = normalizeHistoryMessage(entry);
    if (message) {
      messages.push(message);
    }
  }
  if (input.prompt) {
    messages.push(textMessage("user", input.prompt));
  }
  return messages;
}

/**
 * Extracts the text a tool returned to the model.
 *
 * Tool hooks expose the full result envelope, but the host replays only its
 * text content in the next turn's history. Storing the envelope here would make
 * the same exchange look different across turns and force every later turn back
 * to a full report.
 */
export function toolResultText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const record = asRecord(parsed);
  const content = record?.content ?? parsed;
  const parts = contentParts(content);
  const text = parts
    .map((part) => (part.type === "text" ? part.content : ""))
    .filter((entry) => entry.length > 0)
    .join("\n");
  return text.length > 0 ? text : raw;
}

/** Rebuilds the messages a completed tool round added to the conversation. */
export function roundMessages(
  calls: readonly { toolCallId: string; toolName: string; argumentsText?: string; resultText?: string }[],
): ClsMessage[] {
  const messages: ClsMessage[] = [];
  for (const call of calls) {
    messages.push(
      toolCallMessage(
        canonicalToolCallId(call.toolCallId),
        call.toolName,
        call.argumentsText ?? "{}",
      ),
    );
  }
  for (const call of calls) {
    if (call.resultText !== undefined) {
      messages.push(
        toolResponseMessage(canonicalToolCallId(call.toolCallId), toolResultText(call.resultText)),
      );
    }
  }
  return messages;
}

export type CursorFallbackReason = "first_report" | "conversation_shrank" | "prefix_changed";

export type CursorDecision = {
  mode: "full" | "delta";
  start: number;
  /** Present only when a delta was possible in principle but unsafe. */
  reason?: CursorFallbackReason;
};

/**
 * Tracks how much of each session's conversation has already been reported.
 *
 * Re-sending the whole conversation on every model call makes storage grow with
 * the square of the turn count; reporting only new messages keeps it linear.
 * A delta is only safe when the already-reported prefix is unchanged, so the
 * prefix fingerprint is verified before one is produced. Compaction, session
 * rotation, or any rewrite of earlier turns therefore degrades to a full
 * report instead of emitting an increment against messages the backend never
 * received.
 */
export class MessageCursor {
  private readonly reported = new Map<string, { count: number; prefixHash: string }>();

  constructor(private readonly maxSessions = 2048) {}

  next(sessionId: string, messages: readonly ClsMessage[]): CursorDecision {
    const previous = this.reported.get(sessionId);
    const record = (count: number): void => {
      this.reported.delete(sessionId);
      this.reported.set(sessionId, {
        count,
        prefixHash: messagesHash(messages.slice(0, count)),
      });
      // Map iteration is insertion-ordered, so the first key is the least
      // recently reported session.
      while (this.reported.size > this.maxSessions) {
        const oldest = this.reported.keys().next();
        if (oldest.done) {
          break;
        }
        this.reported.delete(oldest.value);
      }
    };

    if (previous === undefined) {
      record(messages.length);
      return { mode: "full", start: 0, reason: "first_report" };
    }
    if (previous.count > messages.length) {
      record(messages.length);
      return { mode: "full", start: 0, reason: "conversation_shrank" };
    }
    if (messagesHash(messages.slice(0, previous.count)) !== previous.prefixHash) {
      record(messages.length);
      return { mode: "full", start: 0, reason: "prefix_changed" };
    }
    const start = previous.count;
    record(messages.length);
    return { mode: "delta", start };
  }

  get size(): number {
    return this.reported.size;
  }

  forget(sessionId: string): void {
    this.reported.delete(sessionId);
  }
}
