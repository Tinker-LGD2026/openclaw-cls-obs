// Single source of truth for CLS Agent span semantics.
import { SpanKind } from "@opentelemetry/api";
import type { ClsSpanKind, SpanNodeKind } from "../domain/types.js";

export type ClsSpanContract = {
  operation: string;
  namePattern: RegExp;
  otelKind: SpanKind;
  allowedParent?: ClsSpanKind;
};

export const CLS_SPAN_CONTRACTS: Record<ClsSpanKind, ClsSpanContract> = {
  entry: {
    operation: "enter_application",
    namePattern: /^enter_application$/,
    otelKind: SpanKind.SERVER,
  },
  agent: {
    operation: "invoke_agent",
    namePattern: /^invoke_agent .+$/,
    otelKind: SpanKind.INTERNAL,
    allowedParent: "entry",
  },
  step: {
    operation: "react",
    namePattern: /^react round_[1-9]\d*$/,
    otelKind: SpanKind.INTERNAL,
    allowedParent: "agent",
  },
  chat: {
    operation: "chat",
    namePattern: /^chat .+$/,
    otelKind: SpanKind.CLIENT,
    allowedParent: "step",
  },
  tool: {
    operation: "execute_tool",
    namePattern: /^execute_tool .+$/,
    otelKind: SpanKind.CLIENT,
    allowedParent: "step",
  },
};

export function otelKindFor(kind: SpanNodeKind): SpanKind {
  return kind === "extension" ? SpanKind.INTERNAL : CLS_SPAN_CONTRACTS[kind].otelKind;
}
