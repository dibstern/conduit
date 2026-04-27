// ─── OpenTelemetry Tracing Layer ────────────────────────────────────────────
// Configurable Layer that wires Effect.withSpan annotations to OpenTelemetry
// span exporters. Without this Layer, all Effect.withSpan calls are inert.
//
// Usage:
//   import { makeTracingLive } from "./tracing.js";
//   const TracingLive = makeTracingLive({
//     enabled: true,
//     consoleExporter: true,           // prints spans to stdout
//     otlpEndpoint: "http://localhost:4318/v1/traces",  // optional OTLP collector
//   });
//   // Merge into your program's Layer composition.

import { NodeSdk } from "@effect/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
	BatchSpanProcessor,
	ConsoleSpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Layer } from "effect";

// ─── Public configuration ───────────────────────────────────────────────────

export interface TracingConfig {
	/** Master switch — when false the returned Layer is a no-op. */
	readonly enabled: boolean;
	/** Print finished spans to stdout (useful for local dev). */
	readonly consoleExporter?: boolean | undefined;
	/** OTLP/HTTP endpoint, e.g. "http://localhost:4318/v1/traces". */
	readonly otlpEndpoint?: string | undefined;
	/** Optional span processors to inject (e.g. InMemorySpanExporter for tests). */
	readonly spanProcessors?: readonly SpanProcessor[] | undefined;
}

// ─── Layer factory ──────────────────────────────────────────────────────────

/**
 * Build a tracing Layer from the given config.
 *
 * When `enabled` is false the Layer is empty — zero overhead.
 * When `enabled` is true the Layer wires a NodeSdk with the configured
 * span processors so that every `Effect.withSpan` call emits real spans.
 */
export const makeTracingLive = (
	config: TracingConfig,
): Layer.Layer<never, never, never> => {
	if (!config.enabled) {
		return Layer.empty;
	}

	const processors: SpanProcessor[] = [];

	if (config.consoleExporter) {
		// SimpleSpanProcessor exports each span individually — fine for dev.
		processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
	}

	if (config.otlpEndpoint) {
		// BatchSpanProcessor batches before sending to the collector.
		processors.push(
			new BatchSpanProcessor(
				new OTLPTraceExporter({ url: config.otlpEndpoint }),
			),
		);
	}

	if (config.spanProcessors) {
		processors.push(...config.spanProcessors);
	}

	if (processors.length === 0) {
		// Enabled but no exporters configured — nothing useful to do.
		return Layer.empty;
	}

	// NodeSdk.layer registers the OTel TracerProvider globally and provides
	// the @effect/opentelemetry Resource tag. Effect's Tracer picks it up
	// via the global OTel API so Effect.withSpan calls emit real spans.
	const sdkLayer = NodeSdk.layer(() => ({
		spanProcessor: processors.length === 1 ? processors[0]! : processors,
		resource: {
			serviceName: "conduit",
			serviceVersion: "0.0.0",
		},
	}));

	// NodeSdk.layer provides Resource.Resource — we discard it from the output
	// type so callers get Layer<never, never, never> and can merge freely.
	return sdkLayer as unknown as Layer.Layer<never, never, never>;
};
