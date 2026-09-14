// Owns the private tracer provider used to export CLS Agent Trace spans.
import type { Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanExporter,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type { ClsObservabilityConfig } from "../config.js";
import { createClsCompatibleExporter } from "./cls-compatible-exporter.js";

export type TracerHandle = {
  tracer: Tracer;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

/** Builds the exact Resource attributes used by the production provider. */
export function buildResourceAttributes(
  config: ClsObservabilityConfig,
): Record<string, string> {
  const attrs: Record<string, string> = {
    "service.name": config.serviceName,
    "service.instance.id": config.serviceInstanceId,
    "host.name": config.hostName,
    "openclaw.plugin.id": "cls-agent-observability",
  };
  if (config.serviceVersion) {
    attrs["service.version"] = config.serviceVersion;
  }
  if (config.environment) {
    attrs["deployment.environment.name"] = config.environment;
  }
  return attrs;
}

/**
 * Creates an isolated tracer provider.
 *
 * The provider is never registered globally so the official `diagnostics-otel`
 * plugin keeps owning the global OpenTelemetry state.
 */
export function createTracerProvider(
  config: ClsObservabilityConfig,
  exporterOverride?: SpanExporter,
): TracerHandle {
  const exporter =
    exporterOverride ??
    new OTLPTraceExporter({
      url: config.tracesUrl,
      headers: {
        Authorization: config.authorization,
        topic_id: config.topicId,
      },
      timeoutMillis: config.exportTimeoutMs,
      concurrencyLimit: 4,
    });

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes(buildResourceAttributes(config)),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
    spanProcessors: [
      new BatchSpanProcessor(createClsCompatibleExporter(exporter), {
        maxQueueSize: config.maxQueueSize,
        maxExportBatchSize: config.maxExportBatchSize,
        scheduledDelayMillis: config.scheduledDelayMs,
        exportTimeoutMillis: config.exportTimeoutMs,
      }),
    ],
  });

  return {
    tracer: provider.getTracer("cls-agent-observability"),
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
