// The complete `gen_ai.*` attribute vocabulary defined by the CLS Trace Span
// spec (v5, 2026-08-26).
//
// `gen_ai.*` is the protocol namespace: it belongs to the spec, not to this
// plugin. Inventing a key there collides with whatever the spec later assigns
// to that name, and a consumer cannot tell a real protocol field from a local
// one. Anything this plugin needs that the spec does not define goes under
// `openclaw.*` instead.
//
// Keys are listed in the order of the spec's section 4 field dictionary so the
// two can be diffed by hand.

export const SPEC_GEN_AI_ATTRIBUTES: ReadonlySet<string> = new Set([
  // 4.2.1 common identity
  "gen_ai.span.kind",
  "gen_ai.operation.name",
  "gen_ai.system",
  "gen_ai.provider.name",

  // 4.2.2 id context
  "gen_ai.session.id",
  "gen_ai.turn.id",
  "gen_ai.step.id",
  "gen_ai.user.id",
  "gen_ai.user.name",

  // 4.2.3 model request / response
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.response.id",
  "gen_ai.response.finish_reasons",
  "gen_ai.response.time_to_first_token_ms",

  // 4.2.4 messages
  "gen_ai.input.messages",
  "gen_ai.input.messages_delta",
  "gen_ai.input.messages.hash",
  "gen_ai.output.messages",

  // 4.2.5 token usage
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.total_tokens",
  "gen_ai.usage.reasoning_output_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens",

  // 4.2.6 cost
  "gen_ai.usage.input_cost",
  "gen_ai.usage.output_cost",
  "gen_ai.usage.cache_read.input_cost",
  "gen_ai.usage.cache_creation.input_cost",
  "gen_ai.usage.total_cost",

  // 4.2.7 tool
  "gen_ai.tool.name",
  "gen_ai.tool.type",
  "gen_ai.tool.call.id",
  "gen_ai.tool.call.exec.id",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.tool.call.duration_ms",
  "gen_ai.tool.call.image.count",
  "gen_ai.tool.call.image.paths",
  "gen_ai.tool.call.image.duration",
  "gen_ai.tool.error.type",
  "gen_ai.tool.error.message",

  // 4.2.8 agent
  "gen_ai.agent.type",
  "gen_ai.agent.id",
  "gen_ai.agent.name",
  "gen_ai.agent.scope",
  "gen_ai.subagent.parent_tool_call.id",
  "gen_ai.agent.message_count",
  "gen_ai.agent.tool_call_count",

  // 4.2.9 react (step)
  "gen_ai.react.round",
  "gen_ai.react.finish_reason",
  "gen_ai.react.thought",
  "gen_ai.react.observation",

  // 4.2.10 entry
  "gen_ai.entry.type",
  "gen_ai.entry.platform",
  "gen_ai.entry.channel_id",

  // 3.4 chat
  "gen_ai.chat.duration_ms",

  // 4.2.11 chain
  "gen_ai.chain.name",
  "gen_ai.chain.input",
  "gen_ai.chain.output",
  "gen_ai.chain.metadata",

  // 4.2.12 retriever
  "gen_ai.retrieval.query_text",
  "gen_ai.retrieval.documents.count",
  "gen_ai.retrieval.documents",
  "gen_ai.retrieval.duration_ms",

  // 4.2.13 rerank
  "gen_ai.rerank.query_text",
  "gen_ai.rerank.input_documents.count",
  "gen_ai.rerank.output_documents.count",
  "gen_ai.request.top_k",
  "gen_ai.rerank.input_documents",
  "gen_ai.rerank.output_documents",
  "gen_ai.rerank.duration_ms",

  // 4.8 other GenAI extensions
  "gen_ai.request.id",
  "gen_ai.skill.name",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",

  // v3 model request parameters
  "gen_ai.request.temperature",
  "gen_ai.request.top_p",
  "gen_ai.request.max_tokens",
  "gen_ai.request.frequency_penalty",
  "gen_ai.request.presence_penalty",
  "gen_ai.request.stop_sequences",
  "gen_ai.request.seed",
]);

/**
 * Resource-level attributes the spec defines in section 4.3.
 *
 * Deployment environment belongs here, not on the span.
 */
export const SPEC_RESOURCE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "service.name",
  "service.version",
  "service.instance.id",
  "host.name",
  "host.ip",
  "process.pid",
  "process.runtime.name",
  "process.runtime.version",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
  "deployment.environment.name",
  "cloud.provider",
  "cloud.region",
  "os.type",
  "os.version",
]);
