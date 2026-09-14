import assert from "node:assert/strict";
import test from "node:test";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { validateSpans } from "../src/verify/validator.js";

type SpanSpec = {
  name: string;
  kind: "entry" | "agent" | "step" | "chat" | "tool";
  otelKind: SpanKind;
  attrs: Record<string, string | number | boolean | string[]>;
  parent?: string;
};

function spansFrom(specs: SpanSpec[]): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "svc", "host.name": "host" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("validator-test");
  const live = new Map<string, ReturnType<typeof tracer.startSpan>>();
  for (const spec of specs) {
    const parent = spec.parent ? live.get(spec.parent) : undefined;
    const context = parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
    const span = tracer.startSpan(
      spec.name,
      {
        kind: spec.otelKind,
        attributes: {
          "gen_ai.span.kind": spec.kind,
          "gen_ai.operation.name":
            spec.kind === "entry"
              ? "enter_application"
              : spec.kind === "agent"
                ? "invoke_agent"
                : spec.kind === "step"
                  ? "react"
                  : spec.kind === "chat"
                    ? "chat"
                    : "execute_tool",
          "gen_ai.agent.type": "openclaw",
          "gen_ai.session.id": "s",
          "gen_ai.turn.id": "s:t1",
          "gen_ai.user.id": "u",
          "gen_ai.user.name": "u",
          ...spec.attrs,
        },
      },
      context,
    );
    live.set(spec.name, span);
  }
  for (const spec of [...specs].reverse()) {
    live.get(spec.name)?.setStatus({ code: SpanStatusCode.OK });
    live.get(spec.name)?.end();
  }
  return exporter.getFinishedSpans();
}

const baseTrace = (): SpanSpec[] => [
  {
    name: "enter_application",
    kind: "entry",
    otelKind: SpanKind.SERVER,
    attrs: { "gen_ai.entry.type": "cli" },
  },
  {
    name: "invoke_agent main",
    kind: "agent",
    otelKind: SpanKind.INTERNAL,
    parent: "enter_application",
    attrs: {
      "gen_ai.agent.name": "main",
      "gen_ai.agent.message_count": 1,
      "gen_ai.agent.tool_call_count": 0,
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 2,
      "gen_ai.usage.total_tokens": 12,
      "gen_ai.usage.cache_read.input_tokens": 0,
      "gen_ai.usage.cache_creation.input_tokens": 0,
      "openclaw.usage.cache_miss.input_tokens": 10,
    },
  },
  {
    name: "react round_1",
    kind: "step",
    otelKind: SpanKind.INTERNAL,
    parent: "invoke_agent main",
    attrs: {
      "gen_ai.step.id": "s:t1:s1",
      "gen_ai.react.round": 1,
      "gen_ai.react.finish_reason": "stop",
    },
  },
  {
    name: "chat m",
    kind: "chat",
    otelKind: SpanKind.CLIENT,
    parent: "react round_1",
    attrs: {
      "gen_ai.agent.id": "main",
      "gen_ai.step.id": "s:t1:s1",
      "gen_ai.react.round": 1,
      "gen_ai.provider.name": "p",
      "gen_ai.request.model": "m",
      "gen_ai.response.model": "m",
      "gen_ai.chat.duration_ms": 10,
    },
  },
];

test("valid minimal trace passes semantic validation", () => {
  assert.deepEqual(validateSpans(spansFrom(baseTrace())), []);
});

test("step parented to entry is rejected", () => {
  const specs = baseTrace();
  (specs[2] as SpanSpec).parent = "enter_application";
  const issues = validateSpans(spansFrom(specs));
  assert.ok(issues.some((issue) => issue.problem.includes("step parent must be agent")));
});

test("legacy role plus content messages are rejected", () => {
  const specs = baseTrace();
  (specs[0] as SpanSpec).attrs["gen_ai.input.messages"] = JSON.stringify([
    { role: "user", content: "bad" },
  ]);
  const issues = validateSpans(spansFrom(specs));
  assert.ok(issues.some((issue) => issue.problem.includes("need role and parts[]")));
});

test("invalid token arithmetic is rejected", () => {
  const specs = baseTrace();
  (specs[1] as SpanSpec).attrs["gen_ai.usage.total_tokens"] = 999;
  const issues = validateSpans(spansFrom(specs));
  assert.ok(issues.some((issue) => issue.problem.includes("total_tokens must equal")));
});
