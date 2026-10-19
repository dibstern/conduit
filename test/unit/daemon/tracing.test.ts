import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Context, Effect, Exit, Option, Tracer } from "effect";
import { expect, vi } from "vitest";

import {
	makeDaemonTracingLive,
	makeTracingLive,
} from "../../../src/lib/domain/daemon/Layers/tracing.js";
import {
	makeCompositeTracer,
	makeLocalFileTracer,
	type TraceRecord,
} from "../../../src/lib/domain/daemon/Services/local-trace-artifact.js";

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
		try: () =>
			vi.waitFor(
				() => {
					if (existsSync(path)) {
						const record = readTraceRecords(path).find(predicate);
						if (record !== undefined) return record;
					}
					throw new Error(
						`Timed out waiting for matching trace record in ${path}`,
					);
				},
				{ timeout: 1_000 },
			),
		catch: (cause) => cause,
	});

const makeRecordingTracer = (
	idPrefix: string,
	onContext?: (span: Tracer.AnySpan | undefined) => void,
): Tracer.Tracer =>
	Tracer.make({
		span({ name, parent, annotations, links, startTime, kind }) {
			const attributes = new Map<string, unknown>();
			let spanLinks: ReadonlyArray<Tracer.SpanLink> = links;
			let status: Tracer.SpanStatus = { _tag: "Started", startTime };
			const span = {
				_tag: "Span" as const,
				name,
				spanId: `${idPrefix}-span`,
				traceId: `${idPrefix}-trace`,
				parent,
				annotations,
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
		context(primitive, fiber) {
			onContext?.(fiber.cache.span);
			return primitive["~effect/Effect/evaluate"](fiber);
		},
	});

describe("Tracing Layer", () => {
	it.effect("provides NodeSdk and captures spans via InMemoryExporter", () => {
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
				{ local: true },
			),
		);
	});

	it.effect("captures spans with a shared exporter reference", () => {
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
				{ local: true },
			),
		);
	});

	it.effect("is a no-op when disabled", () =>
		Effect.gen(function* () {
			// When disabled, Effect.withSpan should still work (it's always
			// safe) — it just won't export to any backend.
			yield* Effect.withSpan("should.not.crash")(Effect.void);
		}).pipe(
			Effect.provide(makeTracingLive({ enabled: false }), { local: true }),
		),
	);

	it.effect("is a no-op when enabled but no exporters configured", () =>
		Effect.gen(function* () {
			yield* Effect.withSpan("no.exporters")(Effect.void);
		}).pipe(
			Effect.provide(
				makeTracingLive({
					enabled: true,
					// No consoleExporter, no otlpEndpoint, no spanProcessors
				}),
				{ local: true },
			),
		),
	);

	it.effect(
		"makeDaemonTracingLive writes local spans with the floor disabled",
		() => {
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
						minMs: 0,
					}),
					{ local: true },
				),
			);
		},
	);

	it.effect(
		"makeDaemonTracingLive fans out spans to local file tracing and OTel processors",
		() => {
			const exporter = new InMemorySpanExporter();
			const processor = new SimpleSpanProcessor(exporter);
			const dir = mkdtempSync(join(tmpdir(), "conduit-daemon-tracing-"));
			const path = join(dir, "logs", "server.trace.ndjson");

			return Effect.gen(function* () {
				try {
					yield* Effect.withSpan("daemon.local.and.otel", {
						attributes: { sessionId: "debug-session" },
					})(Effect.void);
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
						sessionId: "debug-session",
						spanProcessors: [processor],
					}),
					{ local: true },
				),
			);
		},
	);

	it.each([
		{ minMs: undefined, retainedMs: [5, 8] },
		{ minMs: 5, retainedMs: [5, 8] },
		{ minMs: 0, retainedMs: [0, 4.999999, 5, 8] },
	])("filters successful local spans at $minMs ms and keeps errors and the debugged session", ({
		minMs,
		retainedMs,
	}) => {
		const records: TraceRecord[] = [];
		const local = makeLocalFileTracer({
			filePath: "unused",
			maxBytes: 1024,
			maxFiles: 0,
			...(minMs !== undefined && { minMs }),
			sessionId: "debug-session",
			sink: {
				write: () => Effect.void,
				writeSync: (record) => {
					if (record.type === "effect-span") records.push(record);
				},
				flush: () => Effect.void,
				close: () => Effect.void,
			},
		});
		const upstream = makeRecordingTracer("upstream");
		const upstreamSpans = vi.spyOn(upstream, "span");
		const tracer = makeCompositeTracer(local, upstream);
		for (const name of ["sql.execute", "instance.getAll", "other"]) {
			for (const durationNs of [0n, 4_999_999n, 5_000_000n, 8_000_000n]) {
				tracer
					.span({
						name,
						parent: Option.none(),
						annotations: Context.empty(),
						links: [],
						startTime: 0n,
						kind: "client",
						root: false,
						sampled: true,
					})
					.end(durationNs, Exit.void);
			}
			expect(
				records
					.filter((record) => record.name === name)
					.map((record) => record.durationMs),
			).toEqual(retainedMs);
		}
		for (const exit of [
			Exit.fail("failed"),
			Exit.die("defect"),
			Exit.interrupt(),
		]) {
			for (const name of ["sql.execute", "other"]) {
				tracer
					.span({
						name,
						parent: Option.none(),
						annotations: Context.empty(),
						links: [],
						startTime: 0n,
						kind: "internal",
						root: false,
						sampled: true,
					})
					.end(0n, exit);
				expect(records.at(-1)).toMatchObject({ name, durationMs: 0 });
				expect(records.at(-1)?.exit._tag).not.toBe("Success");
			}
		}
		expect(upstreamSpans.mock.results).toHaveLength(18);
		for (const result of upstreamSpans.mock.results) {
			expect(result.value.status._tag).toBe("Ended");
		}

		const external = Tracer.externalSpan({
			spanId: "external",
			traceId: "trace",
		});
		const parent = tracer.span({
			name: "debug.parent",
			parent: Option.some(external),
			annotations: Context.empty(),
			links: [],
			startTime: 0n,
			kind: "internal",
			root: false,
			sampled: true,
		});
		// Pass a composite parent directly to the local tracer, and annotate it
		// after creating the grandchild so lookup must use live attributes.
		const child = local.span({
			name: "debug.child",
			parent: Option.some(parent),
			annotations: Context.empty(),
			links: [],
			startTime: 0n,
			kind: "internal",
			root: false,
			sampled: true,
		});
		const grandchild = local.span({
			name: "debug.grandchild",
			parent: Option.some(child),
			annotations: Context.empty(),
			links: [],
			startTime: 0n,
			kind: "internal",
			root: false,
			sampled: true,
		});
		parent.attribute("sessionId", "debug-session");
		grandchild.end(0n, Exit.void);
		child.end(0n, Exit.void);
		parent.end(0n, Exit.void);
		expect(records.slice(-3).map((record) => record.name)).toEqual([
			"debug.grandchild",
			"debug.child",
			"debug.parent",
		]);
		const beforeExternal = records.length;
		local
			.span({
				name: "external.child",
				parent: Option.some(external),
				annotations: Context.empty(),
				links: [],
				startTime: 0n,
				kind: "internal",
				root: false,
				sampled: true,
			})
			.end(0n, Exit.void);
		expect(records).toHaveLength(beforeExternal + (minMs === 0 ? 1 : 0));
	});

	it.effect("passes the upstream span to composite tracer context", () =>
		Effect.gen(function* () {
			let upstreamContextSpan: Tracer.AnySpan | undefined;
			const tracer = makeCompositeTracer(
				makeRecordingTracer("local"),
				makeRecordingTracer("upstream", (span) => {
					upstreamContextSpan = span;
				}),
			);

			const compositeSpan = tracer.span({
				name: "composite",
				parent: Option.none(),
				annotations: Context.empty(),
				links: [],
				startTime: 0n,
				kind: "internal",
				root: false,
				sampled: true,
			});
			yield* Effect.withFiber((fiber) =>
				Effect.sync(() => {
					if (tracer.context === undefined)
						throw new Error("Expected tracer context");
					tracer.context(
						{
							"~effect/Effect/evaluate": () => undefined,
						},
						{
							...fiber,
							cache: { ...fiber.cache, span: compositeSpan },
						},
					);
				}),
			);

			expect(upstreamContextSpan?.spanId).toBe("upstream-span");
			expect(upstreamContextSpan?.traceId).toBe("upstream-trace");
		}),
	);

	it.effect(
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
					{ local: true },
				),
			);
		},
	);
});
