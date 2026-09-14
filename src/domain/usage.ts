// Normalizes OpenClaw's disjoint usage buckets into CLS GenAI semantics.
import type { AssistantUsage, Attributes, TokenUsage } from "./types.js";

export type NormalizedUsage = {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheCreation: number;
  cacheMiss: number;
  hostTotal?: number;
  totalMismatch: boolean;
};

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * OpenClaw reports uncached input, cache reads, and cache writes as disjoint
 * buckets. CLS follows OTel GenAI semantics where input_tokens is the whole
 * prompt and the cache fields are subsets of that input.
 */
export function normalizeUsage(raw: TokenUsage): NormalizedUsage {
  const cacheRead = nonNegative(raw.cacheRead);
  const cacheCreation = nonNegative(raw.cacheWrite);
  const cacheMiss = nonNegative(raw.input);
  const input = cacheMiss + cacheRead + cacheCreation;
  const output = nonNegative(raw.output);
  const total = input + output;
  const hostTotal =
    typeof raw.total === "number" && Number.isFinite(raw.total) && raw.total >= 0
      ? Math.floor(raw.total)
      : undefined;
  return {
    input,
    output,
    total,
    cacheRead,
    cacheCreation,
    cacheMiss,
    ...(hostTotal !== undefined ? { hostTotal } : {}),
    totalMismatch: hostTotal !== undefined && hostTotal !== total,
  };
}

export function usageAttributes(usage: NormalizedUsage): Attributes {
  const attrs: Attributes = {
    "gen_ai.usage.input_tokens": usage.input,
    "gen_ai.usage.output_tokens": usage.output,
    "gen_ai.usage.total_tokens": usage.total,
    "gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": usage.cacheCreation,
    // The spec's token dictionary has no cache-miss bucket. The value is still
    // worth keeping — it is the only way to see the uncached remainder — but it
    // is derived, so it stays in the vendor namespace.
    "openclaw.usage.cache_miss.input_tokens": usage.cacheMiss,
  };
  if (usage.hostTotal !== undefined) {
    attrs["openclaw.usage.host_total_tokens"] = usage.hostTotal;
  }
  if (usage.totalMismatch) {
    attrs["openclaw.usage.total_mismatch"] = true;
  }
  return attrs;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Attributes for one completed model call.
 *
 * The usage comes from the call's own assistant message, so unlike the
 * turn-level aggregate it is exact. Cost is computed by the host from its
 * price table — an estimate, not a provider invoice — and marked as such.
 */
export function callUsageAttributes(raw: AssistantUsage): Attributes {
  const attrs: Attributes = {
    ...usageAttributes(normalizeUsage(raw)),
    "openclaw.usage.scope": "call",
  };
  const reasoning = finiteOrUndefined(raw.reasoningTokens);
  if (reasoning !== undefined) {
    attrs["gen_ai.usage.reasoning_output_tokens"] = reasoning;
  }
  const cost = raw.cost;
  if (cost) {
    const total = finiteOrUndefined(cost.total);
    if (total !== undefined) {
      attrs["gen_ai.usage.total_cost"] = total;
      attrs["openclaw.usage.cost_source"] = "price_table_estimate";
    }
    const input = finiteOrUndefined(cost.input);
    if (input !== undefined) {
      attrs["gen_ai.usage.input_cost"] = input;
    }
    const output = finiteOrUndefined(cost.output);
    if (output !== undefined) {
      attrs["gen_ai.usage.output_cost"] = output;
    }
    const cacheRead = finiteOrUndefined(cost.cacheRead);
    if (cacheRead !== undefined) {
      attrs["gen_ai.usage.cache_read.input_cost"] = cacheRead;
    }
    const cacheWrite = finiteOrUndefined(cost.cacheWrite);
    if (cacheWrite !== undefined) {
      attrs["gen_ai.usage.cache_creation.input_cost"] = cacheWrite;
    }
  }
  return attrs;
}
