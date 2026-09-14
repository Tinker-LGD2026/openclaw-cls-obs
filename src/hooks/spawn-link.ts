// Shared extraction of subagent linkage from a sessions_spawn tool result.
// Used by the live hook path (register.ts) and the capture replay path
// (verify/load-capture.ts) so both see identical observation events.

type AnyRecord = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Reads the spawn linkage out of a sessions_spawn result envelope. The result
 * is `{content: [{type:"text", text:"<json>"}]}` whose text carries
 * `{status, childSessionKey, runId}`. Only the two linkage keys are read; the
 * task text and notes are content and stay behind the capture mode.
 */
export function extractSpawnLink(
  resultRecord: AnyRecord | undefined,
): { childSessionKey: string; childRunId?: string } | undefined {
  const content = resultRecord?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const item of content) {
    const text =
      typeof item === "object" && item !== null ? str((item as AnyRecord).text) : undefined;
    if (!text) {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }
      const childSessionKey = str((parsed as AnyRecord).childSessionKey);
      if (!childSessionKey) {
        continue;
      }
      const childRunId = str((parsed as AnyRecord).runId);
      return childRunId ? { childSessionKey, childRunId } : { childSessionKey };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Finds the linkage keys in a serialized result string, whichever layer it
 * holds: the raw inner JSON (tests and old captures) or the serialized
 * envelope produced by `stringifyPayload` in production.
 */
export function parseSpawnLinkText(
  resultText: string,
): { childSessionKey: string; childRunId?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const direct = str((parsed as AnyRecord).childSessionKey);
  if (direct) {
    const childRunId = str((parsed as AnyRecord).runId);
    return childRunId
      ? { childSessionKey: direct, childRunId }
      : { childSessionKey: direct };
  }
  return extractSpawnLink(parsed as AnyRecord);
}
