import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, LogLevel } from "effect";
import { expect, vi } from "vitest";
import { makePinoLoggerLive } from "../../../src/lib/domain/daemon/Layers/pino-logger-layer.js";
import {
	compactTraceAttributes,
	MAX_TRACE_ARRAY_LENGTH,
	MAX_TRACE_DEPTH,
	MAX_TRACE_EVENTS,
	MAX_TRACE_OBJECT_KEYS,
	MAX_TRACE_STRING_LENGTH,
	makeLocalTraceArtifactLive,
	makeTraceSink,
	summarizePayloadShape,
	type TraceRecord,
} from "../../../src/lib/domain/daemon/Services/local-trace-artifact.js";

const makeTempDir = () => mkdtempSync(join(tmpdir(), "conduit-trace-test-"));

const readRecords = (path: string): Array<Record<string, unknown>> =>
	readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

const waitForRecord = (
	path: string,
	predicate: (record: Record<string, unknown>) => boolean,
) =>
	Effect.tryPromise({
		try: async () => {
			for (let attempt = 0; attempt < 80; attempt++) {
				if (existsSync(path)) {
					const record = readRecords(path).find(predicate);
					if (record !== undefined) return record;
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`Timed out waiting for matching trace record in ${path}`);
		},
		catch: (cause) => cause,
	});

describe("local trace artifact normalization", () => {
	it("compacts trace attributes without dumping provider-owned payloads", () => {
		const cyclic: Record<string, unknown> = { keep: "yes" };
		cyclic["self"] = cyclic;
		const long = "x".repeat(MAX_TRACE_STRING_LENGTH + 20);
		const attrs = compactTraceAttributes({
			keep: "value",
			drop: undefined,
			count: 42n,
			when: new Date("2026-05-17T00:00:00.000Z"),
			error: new TypeError("bad input"),
			long,
			array: Array.from({ length: MAX_TRACE_ARRAY_LENGTH + 2 }, (_, index) => ({
				index,
			})),
			object: Object.fromEntries(
				Array.from({ length: MAX_TRACE_OBJECT_KEYS + 2 }, (_, index) => [
					`k${index}`,
					index,
				]),
			),
			cyclic,
			nested: { a: { b: { c: { d: { e: "too deep" } } } } },
			payload: { id: "provider-owned", nested: { secret: "do not dump" } },
			toolInput: { command: "rm", args: ["-rf", "/tmp/nope"] },
		});

		expect(attrs["drop"]).toBeUndefined();
		expect(attrs["count"]).toBe("42");
		expect(attrs["when"]).toBe("2026-05-17T00:00:00.000Z");
		expect(attrs["error"]).toEqual({
			name: "TypeError",
			message: "[string:length=9]",
		});
		expect(String(attrs["long"])).toContain("truncated");
		expect(attrs["cyclic"]).toEqual({ keep: "yes", self: "[Circular]" });
		expect(JSON.stringify(attrs["nested"])).toContain(
			`MaxDepth:${MAX_TRACE_DEPTH}`,
		);
		expect(JSON.stringify(attrs["array"])).toContain("truncated");
		expect(JSON.stringify(attrs["object"])).toContain("truncated");
		expect(attrs["payload"]).toMatchObject({
			payloadShape: expect.objectContaining({
				type: "object",
				keys: ["id", "nested"],
			}),
		});
		expect(attrs["toolInput"]).toMatchObject({
			payloadShape: expect.objectContaining({
				type: "object",
				keys: ["command", "args"],
			}),
		});
	});

	it("shape-summarizes all values under provider-looking keys", () => {
		const providerPayloadKeys = [
			"event",
			"response",
			"sdkMessage",
			"content",
			"textDelta",
			"structuredOutput",
			"toolUseResult",
			"toolResultContent",
			"apiResponse",
			"requestBody",
			"responseBody",
			"body",
			"data",
			"input",
			"output",
		] as const;
		const attrs = compactTraceAttributes({
			provider: "claude",
			source: "provider-runtime",
			operation: "stream",
			method: "POST",
			sessionId: "session-1",
			turnId: "turn-1",
			requestId: "request-1",
			messageType: "assistant",
			schemaName: "ProviderEvent",
			issueCount: 1,
			firstIssue: { path: ["body"], code: "invalid_type" },
			...Object.fromEntries(
				providerPayloadKeys.map((key, index) => [
					key,
					index % 3 === 0
						? { secret: `leaked-object-${key}`, nested: { token: "abc" } }
						: index % 3 === 1
							? [{ secret: `leaked-array-${key}` }]
							: `leaked-scalar-${key}`,
				]),
			),
		});
		const encoded = JSON.stringify(attrs);

		expect(attrs["provider"]).toBe("claude");
		expect(attrs["source"]).toBe("provider-runtime");
		expect(attrs["firstIssue"]).toEqual({
			path: ["body"],
			code: "invalid_type",
		});
		for (const key of providerPayloadKeys) {
			expect(attrs[key]).toMatchObject({
				payloadShape: expect.objectContaining({
					type: expect.stringMatching(/object|array|string/),
				}),
			});
		}
		expect(encoded).not.toContain("leaked-object");
		expect(encoded).not.toContain("leaked-array");
		expect(encoded).not.toContain("leaked-scalar");
		expect(encoded).not.toContain("abc");
	});

	it("does not trust caller-provided payloadShape wrappers or raw Error messages", () => {
		const attrs = compactTraceAttributes({
			payload: { payloadShape: "secret raw content" },
			response: { payloadShape: { body: "nested secret raw content" } },
			error: new Error("provider response SECRET should not persist"),
		});
		const encoded = JSON.stringify(attrs);

		expect(attrs["payload"]).toMatchObject({
			payloadShape: expect.objectContaining({
				type: "object",
				keys: ["payloadShape"],
			}),
		});
		expect(attrs["response"]).toMatchObject({
			payloadShape: expect.objectContaining({
				type: "object",
				keys: ["payloadShape"],
			}),
		});
		expect(attrs["error"]).toEqual({
			name: "Error",
			message: "[string:length=43]",
		});
		expect(encoded).not.toContain("secret raw content");
		expect(encoded).not.toContain("nested secret raw content");
		expect(encoded).not.toContain("SECRET");
	});

	it("summarizes payload shapes without retaining values", () => {
		expect(
			summarizePayloadShape({
				raw: "value",
				items: [{ id: 1 }, { id: 2 }],
			}),
		).toMatchObject({
			type: "object",
			keys: ["raw", "items"],
		});
		expect(summarizePayloadShape(["a", "b"])).toMatchObject({
			type: "array",
			length: 2,
			itemShapes: [{ type: "string" }, { type: "string" }],
		});
	});

	it("summarizes payload shapes with cycle and depth caps", () => {
		const cyclic: Record<string, unknown> = { id: "provider-owned" };
		cyclic["self"] = cyclic;

		expect(summarizePayloadShape(cyclic)).toMatchObject({
			type: "object",
			keys: ["id", "self"],
		});
		expect(
			JSON.stringify(
				summarizePayloadShape([
					{
						nested: {
							deeper: {
								deepest: {
									value: "not retained",
								},
							},
						},
					},
				]),
			),
		).toContain(`MaxDepth:${MAX_TRACE_DEPTH}`);
	});
});

describe("local trace artifact sink", () => {
	const makeTraceRecord = (name: string): TraceRecord => ({
		type: "effect-span",
		schemaVersion: 1,
		service: "conduit-daemon",
		name,
		traceId: `trace-${name}`,
		spanId: `span-${name}`,
		startTimeNanos: "1",
		endTimeNanos: "2",
		durationMs: 0.000001,
		attributes: {},
		events: [],
		links: [],
		exit: { _tag: "Success" },
	});

	it.effect(
		"writes buffered NDJSON records and creates the logs directory",
		() =>
			Effect.gen(function* () {
				const dir = makeTempDir();
				const path = join(dir, "logs", "server.trace.ndjson");
				try {
					const sink = yield* makeTraceSink({
						filePath: path,
						maxBytes: 1024 * 1024,
						maxFiles: 3,
						bufferSize: 2,
					});

					yield* sink.write({
						type: "effect-span",
						schemaVersion: 1,
						service: "conduit-daemon",
						name: "test.span",
						traceId: "trace",
						spanId: "span",
						startTimeNanos: "1",
						endTimeNanos: "3",
						durationMs: 0.000002,
						attributes: { ok: true },
						events: [],
						links: [],
						exit: { _tag: "Success" },
					});
					expect(existsSync(path)).toBe(false);

					yield* sink.flush();
					const lines = readFileSync(path, "utf8").trim().split("\n");
					expect(lines).toHaveLength(1);
					expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
						type: "effect-span",
						name: "test.span",
						attributes: { ok: true },
					});
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}),
	);

	it.effect("rotates bounded NDJSON files without failing later writes", () =>
		Effect.gen(function* () {
			const dir = makeTempDir();
			const path = join(dir, "server.trace.ndjson");
			try {
				const sink = yield* makeTraceSink({
					filePath: path,
					maxBytes: 220,
					maxFiles: 2,
					bufferSize: 1,
				});

				for (let index = 0; index < 8; index++) {
					yield* sink.write({
						type: "effect-span",
						schemaVersion: 1,
						service: "conduit-daemon",
						name: `span.${index}`,
						traceId: `trace-${index}`,
						spanId: `span-${index}`,
						startTimeNanos: "1",
						endTimeNanos: "2",
						durationMs: 0.000001,
						attributes: { message: "x".repeat(50) },
						events: [],
						links: [],
						exit: { _tag: "Success" },
					});
				}
				yield* sink.flush();

				const files = readdirSync(dir).filter((file) =>
					file.startsWith("server.trace.ndjson"),
				);
				expect(files.sort()).toEqual([
					"server.trace.ndjson",
					"server.trace.ndjson.1",
					"server.trace.ndjson.2",
				]);
				for (const file of files) {
					expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(220);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}),
	);

	it.effect("ignores write failures and can persist a later record", () =>
		Effect.gen(function* () {
			const dir = makeTempDir();
			const path = join(dir, "server.trace.ndjson");
			try {
				mkdirSync(path);
				const sink = yield* makeTraceSink({
					filePath: path,
					maxBytes: 1024 * 1024,
					maxFiles: 1,
					bufferSize: 1,
				});

				yield* sink.write(makeTraceRecord("first.failure"));
				yield* sink.flush();

				rmSync(path, { recursive: true, force: true });
				yield* sink.write(makeTraceRecord("second.persisted"));
				yield* sink.flush();

				expect(readRecords(path)).toEqual([
					expect.objectContaining({
						type: "effect-span",
						name: "second.persisted",
					}),
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}),
	);

	it.effect(
		"falls back oversized records to a bounded line and caps events before serialization",
		() =>
			Effect.gen(function* () {
				const dir = makeTempDir();
				const path = join(dir, "server.trace.ndjson");
				try {
					const sink = yield* makeTraceSink({
						filePath: path,
						maxBytes: 520,
						maxFiles: 1,
						bufferSize: 1,
					});

					yield* sink.write({
						type: "effect-span",
						schemaVersion: 1,
						service: "conduit-daemon",
						name: `oversized-record-name-${"x".repeat(1000)}`,
						traceId: "trace",
						spanId: "span",
						startTimeNanos: "1",
						endTimeNanos: "2",
						durationMs: 0.000001,
						attributes: {
							payload: {
								secret: "must not survive fallback",
								nested: "x".repeat(5000),
							},
						},
						events: Array.from(
							{ length: MAX_TRACE_EVENTS + 50 },
							(_, index) => ({
								name: `event.${index}`,
								timeNanos: String(index),
								attributes: { index, payload: { secret: `event-${index}` } },
							}),
						),
						links: Array.from({ length: 20 }, (_, index) => ({
							spanId: `linked-${index}`,
							traceId: "trace",
							attributes: { payload: { secret: `link-${index}` } },
						})),
						exit: { _tag: "Failure", cause: "y".repeat(5000) },
					});
					yield* sink.flush();

					const body = readFileSync(path, "utf8");
					expect(Buffer.byteLength(body)).toBeLessThanOrEqual(520);
					expect(body).not.toContain("must not survive fallback");
					expect(body).not.toContain("event-149");
					const [record] = readRecords(path);
					expect(record).toMatchObject({
						type: "effect-span",
						name: expect.stringContaining("oversized-record-name"),
						truncated: true,
					});
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}),
	);
});

describe("local trace artifact Effect tracer", () => {
	it.scoped(
		"writes completed Effect spans to the local NDJSON artifact",
		() => {
			const dir = makeTempDir();
			const path = join(dir, "logs", "server.trace.ndjson");
			return Effect.gen(function* () {
				try {
					yield* Effect.succeed("done").pipe(
						Effect.withSpan("trace.test", {
							attributes: {
								requestId: "r1",
								payload: { secret: "not persisted" },
							},
						}),
					);
					const record = yield* waitForRecord(
						path,
						(candidate) => candidate["name"] === "trace.test",
					);
					expect(record).toMatchObject({
						type: "effect-span",
						schemaVersion: 1,
						service: "conduit-daemon",
						name: "trace.test",
						attributes: {
							requestId: "r1",
							payload: {
								payloadShape: {
									type: "object",
									keys: ["secret"],
								},
							},
						},
						exit: { _tag: "Success" },
					});
					expect(record["traceId"]).toEqual(expect.any(String));
					expect(record["spanId"]).toEqual(expect.any(String));
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}).pipe(
				Effect.provide(
					makeLocalTraceArtifactLive({
						filePath: path,
						maxBytes: 1024 * 1024,
						maxFiles: 2,
						bufferSize: 1,
					}),
				),
			);
		},
	);

	it("flushes a just-ended span when the layer scope closes immediately", async () => {
		const dir = makeTempDir();
		const path = join(dir, "server.trace.ndjson");
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.succeed("done").pipe(
						Effect.withSpan("scope.close.flush"),
						Effect.provide(
							makeLocalTraceArtifactLive({
								filePath: path,
								maxBytes: 1024 * 1024,
								maxFiles: 2,
								bufferSize: 50,
							}),
						),
					),
				),
			);

			const records = readRecords(path);
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "effect-span",
						name: "scope.close.flush",
					}),
				]),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.scoped(
		"keeps Pino logging active while Logger.tracerLogger records span events",
		() => {
			const root = {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				child: vi.fn(),
			};
			const child = {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				child: vi.fn(),
			};
			root.child.mockReturnValue(child);
			const dir = makeTempDir();
			const path = join(dir, "server.trace.ndjson");

			return Effect.gen(function* () {
				try {
					yield* Effect.logInfo("inside span").pipe(
						Logger.withMinimumLogLevel(LogLevel.Info),
						Effect.withSpan("span.with.log"),
					);
					const record = yield* waitForRecord(
						path,
						(candidate) => candidate["name"] === "span.with.log",
					);
					expect(root.info).toHaveBeenCalledWith("inside span");
					expect(record["name"]).toBe("span.with.log");
					expect(record["events"]).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								name: "inside span",
								attributes: expect.objectContaining({
									"effect.logLevel": "INFO",
								}),
							}),
						]),
					);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeLocalTraceArtifactLive({
							filePath: path,
							maxBytes: 1024 * 1024,
							maxFiles: 2,
							bufferSize: 1,
						}),
						// biome-ignore lint/suspicious/noExplicitAny: mock shape satisfies the subset of PinoLogger used by the bridge
						makePinoLoggerLive(root as any),
					),
				),
			);
		},
	);

	it.scoped("records parentSpanId and sanitized links", () => {
		const dir = makeTempDir();
		const path = join(dir, "server.trace.ndjson");
		return Effect.gen(function* () {
			try {
				yield* Effect.gen(function* () {
					const parent = yield* Effect.currentSpan;
					yield* Effect.withSpan("child.linked", {
						links: [
							{
								_tag: "SpanLink" as const,
								span: parent,
								attributes: {
									relationship: "parent",
									payload: { secret: "link payload must not be dumped" },
								},
							},
						],
					})(Effect.void);
				}).pipe(Effect.withSpan("parent.span"));
				const parentRecord = yield* waitForRecord(
					path,
					(record) => record["name"] === "parent.span",
				);
				const childRecord = yield* waitForRecord(
					path,
					(record) => record["name"] === "child.linked",
				);

				expect(childRecord["parentSpanId"]).toBe(parentRecord["spanId"]);
				expect(JSON.stringify(childRecord)).not.toContain(
					"link payload must not be dumped",
				);
				expect(childRecord["links"]).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							spanId: parentRecord["spanId"],
							traceId: parentRecord["traceId"],
							attributes: expect.objectContaining({
								relationship: "parent",
								payload: expect.objectContaining({
									payloadShape: expect.objectContaining({
										type: "object",
										keys: ["secret"],
									}),
								}),
							}),
						}),
					]),
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(
				makeLocalTraceArtifactLive({
					filePath: path,
					maxBytes: 1024 * 1024,
					maxFiles: 2,
					bufferSize: 1,
				}),
			),
		);
	});

	it.scoped("records provider-payload-safe Failure exits", () => {
		const dir = makeTempDir();
		const path = join(dir, "server.trace.ndjson");
		return Effect.gen(function* () {
			try {
				yield* Effect.fail({
					_tag: "ProviderFailure",
					message: "provider failed",
					payload: {
						secret: "failure payload must not be dumped",
					},
				}).pipe(Effect.withSpan("failure.payload"), Effect.exit);
				const record = yield* waitForRecord(
					path,
					(candidate) => candidate["name"] === "failure.payload",
				);

				expect(record["exit"]).toMatchObject({ _tag: "Failure" });
				expect(JSON.stringify(record)).toContain("ProviderFailure");
				expect(JSON.stringify(record)).toContain("payloadShape");
				expect(JSON.stringify(record)).not.toContain(
					"failure payload must not be dumped",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(
				makeLocalTraceArtifactLive({
					filePath: path,
					maxBytes: 1024 * 1024,
					maxFiles: 2,
					bufferSize: 1,
				}),
			),
		);
	});

	it.scoped("records Interrupted exits", () => {
		const dir = makeTempDir();
		const path = join(dir, "server.trace.ndjson");
		return Effect.gen(function* () {
			try {
				yield* Effect.interrupt.pipe(
					Effect.withSpan("interrupted.span"),
					Effect.exit,
				);
				const record = yield* waitForRecord(
					path,
					(candidate) => candidate["name"] === "interrupted.span",
				);

				expect(record["exit"]).toMatchObject({ _tag: "Interrupted" });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(
				makeLocalTraceArtifactLive({
					filePath: path,
					maxBytes: 1024 * 1024,
					maxFiles: 2,
					bufferSize: 1,
				}),
			),
		);
	});
});
