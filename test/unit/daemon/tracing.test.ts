import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Context, Effect, Option, Tracer } from "effect";
import { expect } from "vitest";

import {
	makeDaemonTracingLive,
	makeTracingLive,
} from "../../../src/lib/domain/daemon/Layers/tracing.js";
import { makeCompositeTracer } from "../../../src/lib/domain/daemon/Services/local-trace-artifact.js";

const readTraceRecords = (path: string): Array<Record<string, unknown>> =>
	readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);

const waitForTraceRecord = (
	path: string,
	predicate: (record: Record<string, unknown>) => boolean,
) =>
	Effect.tryPromise({
		try: async () => {
			for (let attempt = 0; attempt < 80; attempt++) {
				if (existsSync(path)) {
					const record = readTraceRecords(path).find(predicate);
					if (record !== undefined) return record;
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`Timed out waiting for matching trace record in ${path}`);
		},
		catch: (cause) => cause,
	});

const makeRecordingTracer = (
	idPrefix: string,
	onContext?: (span: Tracer.AnySpan | undefined) => void,
): Tracer.Tracer =>
	Tracer.make({
		span(name, parent, context, links, startTime, kind) {
			const attributes = new Map<string, unknown>();
			let spanLinks = links;
			let status: Tracer.SpanStatus = { _tag: "Started", startTime };
			const span = {
				_tag: "Span" as const,
				name,
				spanId: `${idPrefix}-span`,
				traceId: `${idPrefix}-trace`,
				parent,
				context,
				get status() {
					return status;
				},
				attributes,
				get links() {
					return spanLinks;
				},
				sampled: true,
				kind,
				end(endTime, exit) {
					status = { _tag: "Ended", startTime, endTime, exit };
				},
				attribute(key, value) {
					attributes.set(key, value);
				},
				event() {},
				addLinks(newLinks) {
					spanLinks = [...spanLinks, ...newLinks];
				},
			} satisfies Tracer.Span;
			return span;
		},
		context(f, fiber) {
			onContext?.(fiber.currentSpan);
			return f();
		},
	});

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

	it.scoped("makeDaemonTracingLive writes local file spans by default", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-daemon-tracing-"));
		const path = join(dir, "logs", "server.trace.ndjson");
		return Effect.gen(function* () {
			try {
				yield* Effect.withSpan("daemon.local.trace")(Effect.void);
				const record = yield* waitForTraceRecord(
					path,
					(candidate) => candidate["name"] === "daemon.local.trace",
				);
				expect(record).toMatchObject({
					type: "effect-span",
					name: "daemon.local.trace",
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(
				makeDaemonTracingLive({
					enabled: true,
					filePath: path,
					maxBytes: 1024 * 1024,
					maxFiles: 2,
					batchWindowMs: 10,
				}),
			),
		);
	});

	it.scoped(
		"makeDaemonTracingLive fans out spans to local file tracing and OTel processors",
		() => {
			const exporter = new InMemorySpanExporter();
			const processor = new SimpleSpanProcessor(exporter);
			const dir = mkdtempSync(join(tmpdir(), "conduit-daemon-tracing-"));
			const path = join(dir, "logs", "server.trace.ndjson");

			return Effect.gen(function* () {
				try {
					yield* Effect.withSpan("daemon.local.and.otel")(Effect.void);
					const record = yield* waitForTraceRecord(
						path,
						(candidate) => candidate["name"] === "daemon.local.and.otel",
					);
					processor.forceFlush();

					expect(record).toMatchObject({
						type: "effect-span",
						name: "daemon.local.and.otel",
					});
					expect(
						exporter
							.getFinishedSpans()
							.some((span) => span.name === "daemon.local.and.otel"),
					).toBe(true);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}).pipe(
				Effect.provide(
					makeDaemonTracingLive({
						enabled: true,
						filePath: path,
						maxBytes: 1024 * 1024,
						maxFiles: 2,
						batchWindowMs: 10,
						spanProcessors: [processor],
					}),
				),
			);
		},
	);

	it("passes the upstream span to composite tracer context", () => {
		let upstreamContextSpan: Tracer.AnySpan | undefined;
		const tracer = makeCompositeTracer(
			makeRecordingTracer("local"),
			makeRecordingTracer("upstream", (span) => {
				upstreamContextSpan = span;
			}),
		);

		const compositeSpan = tracer.span(
			"composite",
			Option.none(),
			Context.empty(),
			[],
			0n,
			"internal",
		);
		tracer.context(() => undefined, {
			currentSpan: compositeSpan,
		} as Parameters<Tracer.Tracer["context"]>[1]);

		expect(upstreamContextSpan?.spanId).toBe("upstream-span");
		expect(upstreamContextSpan?.traceId).toBe("upstream-trace");
	});

	it.scoped(
		"makeDaemonTracingLive does not create a local file when disabled",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-daemon-tracing-"));
			const path = join(dir, "server.trace.ndjson");
			return Effect.gen(function* () {
				try {
					yield* Effect.withSpan("daemon.local.disabled")(Effect.void);
					expect(existsSync(path)).toBe(false);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}).pipe(
				Effect.provide(
					makeDaemonTracingLive({
						enabled: false,
						filePath: path,
						maxBytes: 1024 * 1024,
						maxFiles: 2,
						batchWindowMs: 10,
					}),
				),
			);
		},
	);
});
