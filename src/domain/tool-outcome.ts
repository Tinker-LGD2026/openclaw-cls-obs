// Classifies tool outcomes from host-authoritative structured fields.
export type ToolResultMeta = {
  status?: string;
  exitCode?: number;
};

export type ToolOutcome =
  | { status: "ok" }
  | { status: "error"; errorType: "tool_error" | "execution_error" };

export function classifyToolOutcome(
  toolName: string,
  resultMeta: ToolResultMeta | undefined,
  hookError: string | undefined,
): ToolOutcome {
  if (hookError) {
    return { status: "error", errorType: "tool_error" };
  }
  if (
    toolName === "exec" &&
    typeof resultMeta?.exitCode === "number" &&
    Number.isFinite(resultMeta.exitCode) &&
    resultMeta.exitCode !== 0
  ) {
    return { status: "error", errorType: "execution_error" };
  }
  return { status: "ok" };
}
