// Applies span commands from the domain layer onto real OpenTelemetry spans.
import {
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import type { SpanCommand, SpanStatus } from "../domain/types.js";
import { otelKindFor } from "../protocol/contracts.js";

type LiveSpan = {
  span: Span;
  context: Context;
  ended: boolean;
};

/**
 * Materializes domain span commands.
 *
 * Spans are only ended when the domain layer says so, and an ended span is never
 * mutated again, because OpenTelemetry silently drops post-`end` mutations.
 */
export class SpanEmitter {
  private readonly live = new Map<string, LiveSpan>();
  private droppedCommands = 0;

  constructor(private readonly tracer: Tracer) {}

  get stats(): { liveSpans: number; droppedCommands: number } {
    return { liveSpans: this.live.size, droppedCommands: this.droppedCommands };
  }

  applyAll(commands: readonly SpanCommand[]): void {
    for (const command of commands) {
      this.apply(command);
    }
  }

  apply(command: SpanCommand): void {
    switch (command.op) {
      case "start": {
        if (this.live.has(command.nodeId)) {
          this.droppedCommands += 1;
          return;
        }
        const parent = command.parentNodeId ? this.live.get(command.parentNodeId) : undefined;
        const parentContext = parent && !parent.ended ? parent.context : ROOT_CONTEXT;
        const span = this.tracer.startSpan(
          command.name,
          {
            kind: otelKindFor(command.kind),
            startTime: command.startTimeMs,
            attributes: command.attributes,
          },
          parentContext,
        );
        this.live.set(command.nodeId, {
          span,
          context: trace.setSpan(parentContext, span),
          ended: false,
        });
        return;
      }

      case "update": {
        const entry = this.live.get(command.nodeId);
        if (!entry || entry.ended) {
          this.droppedCommands += 1;
          return;
        }
        entry.span.setAttributes(command.attributes);
        return;
      }

      case "finalize": {
        const entry = this.live.get(command.nodeId);
        if (!entry || entry.ended) {
          this.droppedCommands += 1;
          return;
        }
        entry.span.setStatus({
          code: toStatusCode(command.status),
          ...(command.statusMessage ? { message: command.statusMessage } : {}),
        });
        entry.span.end(command.endTimeMs);
        entry.ended = true;
        this.live.delete(command.nodeId);
        return;
      }

      default:
        return;
    }
  }
}

function toStatusCode(status: SpanStatus): SpanStatusCode {
  switch (status) {
    case "ok":
      return SpanStatusCode.OK;
    case "error":
      return SpanStatusCode.ERROR;
    default:
      return SpanStatusCode.UNSET;
  }
}
