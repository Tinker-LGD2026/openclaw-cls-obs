// Redacts and truncates captured content before it is attached to spans.
import type { ContentMode } from "../config.js";

export type ContentLimits = {
  maxFieldChars: number;
  maxMessages: number;
};

export const DEFAULT_CONTENT_LIMITS: ContentLimits = {
  maxFieldChars: 4_000,
  maxMessages: 40,
};

/**
 * Patterns for secrets that must never reach CLS.
 *
 * Content capture is opt-in, but prompts routinely contain credentials pasted by
 * users or injected by tools, so redaction runs unconditionally whenever capture
 * is enabled rather than being a separate toggle operators could forget.
 *
 * Order matters: structurally specific patterns run first. `user:pass@host`
 * contains an email-shaped substring, so URL credentials must be redacted before
 * the generic email rule can mislabel them and destroy the URL shape.
 */
const REDACTIONS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    label: "PRIVATE_KEY",
  },
  {
    // Credentials embedded in URLs, e.g. https://user:pass@host
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,
    label: "URL_CREDENTIALS",
  },
  {
    pattern:
    /\b(authorization|api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd|bearer)\b\s*[:=]\s*("[^"]{4,}"|'[^']{4,}'|[^\s,;)}\]]{4,})/gi,
    label: "CREDENTIAL_ASSIGNMENT",
  },
  { pattern: /\b(sk|pk)-[A-Za-z0-9_-]{16,}\b/g, label: "API_KEY" },
  { pattern: /\bAKID[A-Za-z0-9]{12,}\b/g, label: "TENCENT_SECRET_ID" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_ACCESS_KEY" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, label: "GITHUB_TOKEN" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "SLACK_TOKEN" },
  { pattern: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: "JWT" },
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    label: "EMAIL",
  },
];

export type RedactionOutcome = {
  text: string;
  redactedLabels: string[];
  truncated: boolean;
  originalChars: number;
};

/** Replaces known secret shapes with stable placeholders. */
export function redact(input: string): { text: string; labels: string[] } {
  let text = input;
  const labels = new Set<string>();
  for (const { pattern, label } of REDACTIONS) {
    // Patterns are module-level with /g, so lastIndex must be reset per use.
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match) => {
      labels.add(label);
      if (label === "CREDENTIAL_ASSIGNMENT" || label === "URL_CREDENTIALS") {
   const separatorMatch = /[:=]/.exec(match);
        if (label === "URL_CREDENTIALS") {
          const scheme = match.slice(0, match.indexOf("://") + 3);
     return `${scheme}[REDACTED:${label}]@`;
        }
        if (separatorMatch) {
          const head = match.slice(0, separatorMatch.index + 1);
          return `${head} [REDACTED:${label}]`;
        }
      }
    return `[REDACTED:${label}]`;
    });
  }
  return { text, labels: [...labels] };
}

/** Redacts, then truncates from the middle so both ends stay readable. */
export function prepareText(
  input: string,
  mode: ContentMode,
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): RedactionOutcome | undefined {
  if (mode === "off" || input.length === 0) {
    return undefined;
  }
  const { text, labels } = redact(input);
  const limit = mode === "full" ? Number.MAX_SAFE_INTEGER : limits.maxFieldChars;
  if (text.length <= limit) {
    return { text, redactedLabels: labels, truncated: false, originalChars: input.length };
  }
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const clipped = `${text.slice(0, head)}\n…[TRUNCATED ${text.length - limit} chars]…\n${text.slice(
    text.length - tail,
  )}`;
  return { text: clipped, redactedLabels: labels, truncated: true, originalChars: input.length };
}

/** Serializes arbitrary tool payloads without letting one huge value dominate. */
export function stringifyPayload(value: unknown, maxChars: number): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      value,
  (_key, entry) => {
        if (typeof entry === "object" && entry !== null) {
          if (seen.has(entry)) {
            return "[Circular]";
 }
          seen.add(entry);
        }
        if (typeof entry === "string" && entry.length > maxChars) {
          return `${entry.slice(0, maxChars)}…[+${entry.length - maxChars}]`;
        }
        if (typeof entry === "bigint") {
    return entry.toString();
      }
     return entry;
      },
      0,
    );
    return json ?? "";
  } catch {
    return "[UNSERIALIZABLE]";
  }
}
