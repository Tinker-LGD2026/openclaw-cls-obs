// Builds CLS content attributes from captured prompt, output, and tool payloads.
import { createHash } from "node:crypto";
import type { ClsObservabilityConfig } from "../config.js";
import type { Attributes, TurnInputContent, TurnOutputContent } from "../domain/types.js";
import {
  type ClsMessage,
  type ClsMessagePart,
  encodeMessages,
  messagesHash,
  textMessage,
} from "../protocol/messages.js";
import {
  DEFAULT_CONTENT_LIMITS,
  type ContentLimits,
  prepareText,
  stringifyPayload,
} from "./redact.js";

/** Stable fingerprint used to detect content changes without storing the text. */
function sha256Prefix(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/**
 * Records what was redacted or dropped.
 *
 * Content capture is lossy by design, so every span that carries content also
 * carries why it is incomplete; otherwise a truncated prompt is indistinguishable
 * from a genuinely short one during incident review.
 */
function annotate(
  attrs: Attributes,
  prefix: string,
  outcome: { redactedLabels: string[]; truncated: boolean; originalChars: number },
): void {
  if (outcome.redactedLabels.length > 0) {
    attrs[`${prefix}.redacted`] = true;
    attrs[`${prefix}.redacted_types`] = outcome.redactedLabels.sort();
  }
  if (outcome.truncated) {
    attrs[`${prefix}.truncated`] = true;
    attrs[`${prefix}.original_chars`] = outcome.originalChars;
  }
}

export type RenderedMessages = {
  messages: ClsMessage[];
  redactedLabels: string[];
  truncated: boolean;
  originalChars: number;
};

/**
 * Applies redaction and truncation to every text-bearing part of a message list.
 *
 * Messages carry user text, tool arguments, and tool output, all of which can
 * contain credentials, so the policy is applied per part rather than to the
 * encoded JSON; truncating encoded JSON would also produce a value CLS can no
 * longer parse.
 */
export function renderMessages(
  config: ClsObservabilityConfig,
  messages: readonly ClsMessage[],
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): RenderedMessages {
  const effectiveLimits: ContentLimits = {
    ...limits,
    maxFieldChars: config.contentMaxChars ?? limits.maxFieldChars,
  };
  const labels = new Set<string>();
  let truncated = false;
  let originalChars = 0;

  const apply = (text: string): string => {
    const outcome = prepareText(text, config.contentMode, effectiveLimits);
    if (!outcome) {
      return "";
    }
    for (const label of outcome.redactedLabels) {
      labels.add(label);
    }
    truncated = truncated || outcome.truncated;
    originalChars += outcome.originalChars;
    return outcome.text;
  };

  const rendered: ClsMessage[] = [];
  for (const message of messages) {
    const parts: ClsMessagePart[] = [];
    for (const part of message.parts) {
      if (part.type === "text") {
        parts.push({ type: "text", content: apply(part.content) });
        continue;
      }
      if (part.type === "tool_call") {
        parts.push({ ...part, arguments: apply(part.arguments) });
        continue;
      }
      parts.push({ ...part, result: apply(part.result) });
    }
    if (parts.length > 0) {
      rendered.push({ role: message.role, parts });
    }
  }

  return { messages: rendered, redactedLabels: [...labels].sort(), truncated, originalChars };
}

/** Maps a turn's prompt into `gen_ai.input.messages`. */
export function buildInputContentAttributes(
  config: ClsObservabilityConfig,
  input: TurnInputContent,
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): Attributes {
  const effectiveLimits: ContentLimits = {
    ...limits,
    maxFieldChars: config.contentMaxChars ?? limits.maxFieldChars,
  };

  const attrs: Attributes = {};
  if (typeof input.historyMessageCount === "number") {
    attrs["openclaw.input.history_message_count"] = input.historyMessageCount;
  }
  if (typeof input.imagesCount === "number") {
    attrs["openclaw.input.images_count"] = input.imagesCount;
  }
  if (typeof input.toolCount === "number") {
    attrs["openclaw.input.tool_count"] = input.toolCount;
  }

  // The system prompt fingerprint is not conversation content, so it is emitted
  // even when content capture is off: it is what makes a silent prompt change
  // detectable during an incident.
  if (input.systemPrompt) {
    attrs["openclaw.input.system.sha256"] = sha256Prefix(input.systemPrompt);
    attrs["openclaw.input.system.chars"] = input.systemPrompt.length;
  }

  if (config.contentMode === "off") {
    return attrs;
  }

  const promptOutcome = input.prompt
    ? prepareText(input.prompt, config.contentMode, effectiveLimits)
    : undefined;
  if (promptOutcome) {
    const messages = [textMessage("user", promptOutcome.text)];
    attrs["gen_ai.input.messages"] = encodeMessages(messages);
    attrs["gen_ai.input.messages.hash"] = messagesHash(messages);
    annotate(attrs, "openclaw.input.prompt", promptOutcome);
    // The entry span represents the turn itself, so it carries this turn's
    // question only. The full model context lives on the chat spans.
    attrs["openclaw.input.scope"] = "current_turn_only";
    attrs["openclaw.input.system.mode"] = config.systemPromptMode;
  }
  return attrs;
}

/** Maps a turn's assistant output into `gen_ai.output.messages`. */
export function buildOutputContentAttributes(
  config: ClsObservabilityConfig,
  output: TurnOutputContent,
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): Attributes {
  const effectiveLimits: ContentLimits = {
    ...limits,
    maxFieldChars: config.contentMaxChars ?? limits.maxFieldChars,
  };
  const attrs: Attributes = {};
  const texts = output.assistantTexts ?? [];
  if (texts.length > 0) {
    attrs["openclaw.output.message_count"] = texts.length;
  }
  if (config.contentMode === "off" || texts.length === 0) {
    return attrs;
  }

  // `llm_output.assistantTexts` is a turn-level accumulation. Entry and the
  // final Chat represent the final answer, so intermediate pre-tool narration
  // must not be misattributed to the last model call.
  const kept = texts.slice(-1);
  if (texts.length > 1) {
    attrs["openclaw.output.intermediate_message_count"] = texts.length - 1;
  }

  const messages = [] as ReturnType<typeof textMessage>[];
  const labels = new Set<string>();
  let truncated = false;
  let originalChars = 0;
  for (const text of kept) {
    const outcome = prepareText(text, config.contentMode, effectiveLimits);
    if (!outcome) {
      continue;
    }
    messages.push(textMessage("assistant", outcome.text));
    for (const label of outcome.redactedLabels) {
      labels.add(label);
    }
    truncated = truncated || outcome.truncated;
 originalChars += outcome.originalChars;
  }
  if (messages.length > 0) {
    attrs["gen_ai.output.messages"] = encodeMessages(messages);
    annotate(attrs, "openclaw.output", {
   redactedLabels: [...labels],
      truncated,
  originalChars,
    });
  }
  return attrs;
}

/** Maps tool call arguments into `gen_ai.tool.call.arguments`. */
export function buildToolArgumentAttributes(
  config: ClsObservabilityConfig,
  rawArguments: string | undefined,
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): Attributes {
  const attrs: Attributes = {};
  if (config.contentMode === "off" || !rawArguments) {
    return attrs;
  }
  const outcome = prepareText(rawArguments, config.contentMode, {
    ...limits,
    maxFieldChars: config.contentMaxChars ?? limits.maxFieldChars,
  });
  if (!outcome) {
    return attrs;
  }
  attrs["gen_ai.tool.call.arguments"] = outcome.text;
  annotate(attrs, "openclaw.tool.arguments", outcome);
  return attrs;
}

/** Maps a tool result into `gen_ai.tool.call.result`. */
export function buildToolResultAttributes(
  config: ClsObservabilityConfig,
  rawResult: string | undefined,
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): Attributes {
  const attrs: Attributes = {};
  if (config.contentMode === "off" || !rawResult) {
    return attrs;
  }
  const outcome = prepareText(rawResult, config.contentMode, {
    ...limits,
    maxFieldChars: config.contentMaxChars ?? limits.maxFieldChars,
  });
  if (!outcome) {
    return attrs;
  }
  attrs["gen_ai.tool.call.result"] = outcome.text;
  annotate(attrs, "openclaw.tool.result", outcome);
  return attrs;
}

/**
 * Serializes a hook payload for later redaction and truncation.
 *
 * The captured text feeds the in-memory conversation whose prefix fingerprint
 * powers delta reporting, so it must stay byte-identical to what the host
 * later replays in history. Clamping to the display limit here would bake one
 * truncation form into the conversation while history carries another, and the
 * delta chain would break on every long tool payload. Truncation therefore
 * happens only at render time; capture keeps the payload whole except for a
 * generous per-string safety ceiling against pathological outputs.
 */
export function serializeForCapture(
  config: ClsObservabilityConfig,
  value: unknown,
  _limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): string | undefined {
  if (config.contentMode === "off") {
    return undefined;
  }
  const text = stringifyPayload(value, CAPTURE_SAFETY_CHARS_PER_STRING);
  return text.length > 0 ? text : undefined;
}

/**
 * Bounds in-memory retention of a single captured string.
 *
 * Must stay comfortably above the display field limit (CLS_CONTENT_MAX_CHARS,
 * default 1.1M chars): if capture clamped below it, an oversized payload would
 * enter the conversation in one truncation form while the host's history
 * replay carries another, and the delta chain would reset on exactly the
 * payloads the limit exists for. 4M chars ≈ the upper end of a 1M-token
 * context window, which is what the conversation mirrors anyway.
 */
export const CAPTURE_SAFETY_CHARS_PER_STRING = 4_000_000;
