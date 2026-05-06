import { describe, it } from "@effect/vitest";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Effect } from "effect";
import { expect } from "vitest";

import { makeTracingLive } from "../../../src/lib/effect/tracing.js";

describe("Tracing Layer", () => {
	it.scoped("provides NodeSdk and captures spans via InMemoryExporter", () => {
		const exporter = new InMemorySpanExporter();
		const processor = new SimpleSpanProcessor(exporter);

		return Effect.gen(function* () {
			yield* Effect.withSpan("test.span")(Effect.void);

			// SimpleSpanProcessor exports synchronously on span end, so the
			// span should already be in the exporter.
			processor.forceFlush();
			const finished = exporter.getFinishedSpans();
			expect(finished.length).toBeGreaterThanOrEqual(1);
			expect(finished.some((s) => s.name === "test.span")).toBe(true);
		}).pipe(
			Effect.provide(
				makeTracingLive({
					enabled: true,
					spanProcessors: [processor],
				}),
			),
		);
	});

	it.scoped("captures spans with a shared exporter reference", () => {
		const exporter = new InMemorySpanExporter();
		const processor = new SimpleSpanProcessor(exporter);

		return Effect.gen(function* () {
			yield* Effect.withSpan("hello.world")(Effect.void);
			yield* Effect.withSpan("another.span")(Effect.void);

			processor.forceFlush();
			const finished = exporter.getFinishedSpans();
			expect(finished.length).toBeGreaterThanOrEqual(2);

			const names = finished.map((s) => s.name);
			expect(names).toContain("hello.world");
			expect(names).toContain("another.span");
		}).pipe(
			Effect.provide(
				makeTracingLive({
					enabled: true,
					spanProcessors: [processor],
				}),
			),
		);
	});

	it.scoped("is a no-op when disabled", () =>
		Effect.gen(function* () {
			// When disabled, Effect.withSpan should still work (it's always
			// safe) — it just won't export to any backend.
			yield* Effect.withSpan("should.not.crash")(Effect.void);
		}).pipe(Effect.provide(makeTracingLive({ enabled: false }))),
	);

	it.scoped("is a no-op when enabled but no exporters configured", () =>
		Effect.gen(function* () {
			yield* Effect.withSpan("no.exporters")(Effect.void);
		}).pipe(
			Effect.provide(
				makeTracingLive({
					enabled: true,
					// No consoleExporter, no otlpEndpoint, no spanProcessors
				}),
			),
		),
	);
});
