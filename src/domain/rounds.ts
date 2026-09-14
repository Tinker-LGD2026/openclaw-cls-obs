// Pure ReAct-round transition rules derived from model/tool event order.
export type RoundFacts = {
  modelCalls: number;
  successfulModelCalls: number;
  failedModelCalls: number;
  toolCalls: number;
};

export type RoundDecision = {
  action: "start" | "reuse";
  ambiguous: boolean;
};

/** Decides whether an arriving model call belongs to the current round. */
export function decideRoundForModel(current: RoundFacts | undefined): RoundDecision {
  if (!current || current.modelCalls === 0) {
    return { action: "start", ambiguous: false };
  }
  if (current.toolCalls > 0) {
    return { action: "start", ambiguous: false };
  }
  if (current.successfulModelCalls === 0 && current.failedModelCalls > 0) {
    // Provider retries/failover are alternate attempts at the same decision.
    return { action: "reuse", ambiguous: false };
  }
  // A second successful model call without an intervening tool is usually a
  // revision/finalization pass. It is a new semantic round, but the host does not
  // expose a reason, so downstream data must retain that uncertainty.
  return { action: "start", ambiguous: true };
}

export function deriveRoundFinishReason(
  facts: RoundFacts,
): "tool_calls" | "error" | "stop" {
  if (facts.toolCalls > 0) {
    return "tool_calls";
  }
  if (facts.modelCalls > 0 && facts.failedModelCalls === facts.modelCalls) {
    return "error";
  }
  return "stop";
}
