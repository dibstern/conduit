import {
	appendFile as appendFileFs,
	mkdir,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
	Cause,
	Effect,
	Exit,
	Layer,
	Option,
	type Runtime,
	Tracer,
} from "effect";

export const MAX_TRACE_STRING_LENGTH = 4096;
export const MAX_TRACE_DEPTH = 4;
export const MAX_TRACE_ARRAY_LENGTH = 25;
export const MAX_TRACE_OBJECT_KEYS = 25;
export const MAX_TRACE_EVENTS = 100;

const DEFAULT_BUFFER_SIZE = 50;
const INTERNAL_PAYLOAD_SHAPE = Symbol("conduit.internalPayloadShape");
const PROVIDER_PAYLOAD_KEYS = new Set([
	"apiresponse",
	"body",
	"content",
	"data",
	"event",
	"input",
	"message",
	"output",
	"raw",
	"payload",
	"requestbody",
	"response",
	"responsebody",
	"sdkmessage",
	"structuredoutput",
	"textdelta",
	"toolinput",
	"toolresultcontent",
	"toolresult",
	"tooluseresult",
]);

export type TraceAttributeValue =
	| null
	| boolean
	| number
	| string
	| readonly TraceAttributeValue[]
	| { readonly [key: string]: TraceAttributeValue };

export interface TraceRecordEvent {
	readonly name: string;
	readonly timeNanos: string;
	readonly attributes?: Record<string, TraceAttributeValue>;
}

export type TraceRecordExit =
	| { readonly _tag: "Success" }
	| { readonly _tag: "Failure"; readonly cause: string }
	| { readonly _tag: "Interrupted"; readonly cause?: string };

export interface TraceRecord {
	readonly type: "effect-span";
	readonly schemaVersion: 1;
	readonly service: "conduit-daemon";
	readonly name: string;
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly startTimeNanos: string;
	readonly endTimeNanos: string;
	readonly durationMs: number;
	readonly attributes: Record<string, TraceAttributeValue>;
	readonly events: readonly TraceRecordEvent[];
	readonly links: readonly TraceAttributeValue[];
	readonly exit: TraceRecordExit;
}

export interface TraceSinkOptions {
	readonly filePath: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
	readonly bufferSize?: number | undefined;
	readonly batchWindowMs?: number | undefined;
}

export interface TraceSink {
	readonly write: (record: TraceRecord) => Effect.Effect<void>;
	readonly writeSync: (record: TraceRecord) => void;
	readonly flush: () => Effect.Effect<void>;
	readonly close: () => Effect.Effect<void>;
}

export interface LocalFileTracerOptions extends TraceSinkOptions {
	readonly sink?: TraceSink | undefined;
}

type PayloadShapeWrapper = {
	readonly payloadShape: TraceAttributeValue;
	readonly [INTERNAL_PAYLOAD_SHAPE]?: true;
};

const makePayloadShapeWrapper = (
	payloadShape: TraceAttributeValue,
): PayloadShapeWrapper =>
	Object.defineProperty({ payloadShape }, INTERNAL_PAYLOAD_SHAPE, {
		value: true,
		enumerable: false,
	}) as PayloadShapeWrapper;

const isInternalPayloadShapeWrapper = (
	value: unknown,
): value is PayloadShapeWrapper =>
	typeof value === "object" &&
	value !== null &&
	(value as PayloadShapeWrapper)[INTERNAL_PAYLOAD_SHAPE] === true;

export const summarizePayloadShape = (value: unknown): TraceAttributeValue => {
	const seen = new WeakSet<object>();
	const summarize = (input: unknown, depth: number): TraceAttributeValue => {
		if (input === null) return { type: "null" };
		const inputType = typeof input;
		if (inputType !== "object") return { type: inputType };
		const objectInput = input as object;
		if (seen.has(objectInput)) return { type: "object", circular: true };
		if (depth >= MAX_TRACE_DEPTH) {
			return { type: "object", truncated: `[MaxDepth:${MAX_TRACE_DEPTH}]` };
		}

		seen.add(objectInput);
		if (Array.isArray(input)) {
			const itemShapes = input
				.slice(0, MAX_TRACE_ARRAY_LENGTH)
				.map((item) => summarize(item, depth + 1));
			if (input.length > MAX_TRACE_ARRAY_LENGTH) {
				itemShapes.push({
					type: "array",
					truncated: input.length - MAX_TRACE_ARRAY_LENGTH,
				});
			}
			seen.delete(objectInput);
			return {
				type: "array",
				length: input.length,
				itemShapes,
			};
		}

		const keys = Object.keys(input as Record<string, unknown>).slice(
			0,
			MAX_TRACE_OBJECT_KEYS,
		);
		const properties: Record<string, TraceAttributeValue> = {};
		for (const key of keys) {
			properties[key] = summarize(
				(input as Record<string, unknown>)[key],
				depth + 1,
			);
		}
		seen.delete(objectInput);
		return {
			type: "object",
			keys,
			...(Object.keys(properties).length > 0 && { properties }),
		};
	};
	return summarize(value, 0);
};

export const compactTraceAttributes = (
	attributes: Record<string, unknown>,
	options?: {
		readonly maxDepth?: number | undefined;
		readonly maxStringLength?: number | undefined;
		readonly maxArrayLength?: number | undefined;
		readonly maxObjectKeys?: number | undefined;
	},
): Record<string, TraceAttributeValue> => {
	const limits = {
		maxDepth: options?.maxDepth ?? MAX_TRACE_DEPTH,
		maxStringLength: options?.maxStringLength ?? MAX_TRACE_STRING_LENGTH,
		maxArrayLength: options?.maxArrayLength ?? MAX_TRACE_ARRAY_LENGTH,
		maxObjectKeys: options?.maxObjectKeys ?? MAX_TRACE_OBJECT_KEYS,
	};
	const seen = new WeakSet<object>();

	const compact = (
		value: unknown,
		depth: number,
		key?: string,
	): TraceAttributeValue | undefined => {
		if (value === undefined) return undefined;
		if (key !== undefined && isLikelyProviderPayloadKey(key)) {
			if (isInternalPayloadShapeWrapper(value)) return value;
			return makePayloadShapeWrapper(summarizePayloadShape(value));
		}
		if (value === null) return null;
		if (typeof value === "string") {
			if (value.length <= limits.maxStringLength) return value;
			return `${value.slice(0, limits.maxStringLength)}...[truncated:${value.length - limits.maxStringLength}]`;
		}
		if (typeof value === "number" || typeof value === "boolean") return value;
		if (typeof value === "bigint") return value.toString();
		if (value instanceof Date) return value.toISOString();
		if (value instanceof Error) {
			return {
				name: value.name,
				message: summarizeDiagnosticString(value.message),
			};
		}
		if (typeof value !== "object") return String(value);
		if (seen.has(value)) return "[Circular]";
		if (depth >= limits.maxDepth) return `[MaxDepth:${limits.maxDepth}]`;

		seen.add(value);
		if (Array.isArray(value)) {
			const items = value
				.slice(0, limits.maxArrayLength)
				.map((item) => compact(item, depth + 1))
				.filter((item): item is TraceAttributeValue => item !== undefined);
			if (value.length > limits.maxArrayLength) {
				items.push(`[truncated:${value.length - limits.maxArrayLength}]`);
			}
			seen.delete(value);
			return items;
		}

		const output: Record<string, TraceAttributeValue> = {};
		const entries = Object.entries(value as Record<string, unknown>);
		for (const [entryKey, entryValue] of entries.slice(
			0,
			limits.maxObjectKeys,
		)) {
			const compacted = compact(entryValue, depth + 1, entryKey);
			if (compacted !== undefined) output[entryKey] = compacted;
		}
		if (entries.length > limits.maxObjectKeys) {
			output["truncated"] = entries.length - limits.maxObjectKeys;
		}
		seen.delete(value);
		return output;
	};

	const output: Record<string, TraceAttributeValue> = {};
	for (const [key, value] of Object.entries(attributes)) {
		const compacted = compact(value, 0, key);
		if (compacted !== undefined) output[key] = compacted;
	}
	return output;
};

const truncateString = (value: string, maxLength: number): string => {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength))}...[truncated:${value.length - Math.max(0, maxLength)}]`;
};

const jsonLine = (record: Record<string, unknown>): string =>
	`${JSON.stringify(record)}\n`;

const isLikelyProviderPayloadKey = (key: string): boolean =>
	PROVIDER_PAYLOAD_KEYS.has(key.toLowerCase());

const summarizeDiagnosticString = (value: string): string =>
	value.length === 0 ? "" : `[string:length=${value.length}]`;

const safeJsonLine = (record: TraceRecord, maxBytes: number): string => {
	const compacted: TraceRecord = {
		...record,
		attributes: compactTraceAttributes(record.attributes),
		events: record.events.slice(0, MAX_TRACE_EVENTS).map((event) => ({
			...event,
			...(event.attributes !== undefined && {
				attributes: compactTraceAttributes(event.attributes),
			}),
		})),
	};
	let line = jsonLine(compacted as unknown as Record<string, unknown>);
	if (Buffer.byteLength(line) <= maxBytes) return line;

	const summarized: TraceRecord = {
		...compacted,
		name: truncateString(compacted.name, 120),
		attributes: {
			truncated: true,
			payloadShape: summarizePayloadShape(compacted.attributes),
		},
		events: [],
		links: [],
		exit:
			compacted.exit._tag === "Success"
				? compacted.exit
				: { _tag: compacted.exit._tag, cause: "[truncated]" },
	};
	line = jsonLine(summarized as unknown as Record<string, unknown>);
	if (Buffer.byteLength(line) <= maxBytes) return line;

	const minimum = {
		type: "effect-span",
		schemaVersion: 1,
		service: "conduit-daemon",
		name: truncateString(record.name, 80),
		traceId: record.traceId,
		spanId: record.spanId,
		truncated: true,
	};
	line = jsonLine(minimum);
	if (Buffer.byteLength(line) <= maxBytes) return line;

	return jsonLine({
		type: "effect-span",
		schemaVersion: 1,
		truncated: true,
	});
};

const rotateFilesNow = async (
	filePath: string,
	maxBytes: number,
	maxFiles: number,
	incomingBytes = 0,
) => {
	const current = await stat(filePath).catch(() => null);
	if (current === null || current.size + incomingBytes <= maxBytes) return;
	if (maxFiles <= 0) {
		await unlink(filePath).catch(() => undefined);
		return;
	}
	await unlink(`${filePath}.${maxFiles}`).catch(() => undefined);
	for (let index = maxFiles - 1; index >= 1; index--) {
		await rename(`${filePath}.${index}`, `${filePath}.${index + 1}`).catch(
			() => undefined,
		);
	}
	await rename(filePath, `${filePath}.1`).catch(() => undefined);
};

export const makeTraceSink = (
	options: TraceSinkOptions,
): Effect.Effect<TraceSink, never, never> =>
	Effect.gen(function* () {
		const buffer: string[] = [];
		let closed = false;
		let flushTimer: NodeJS.Timeout | undefined;
		let flushInProgress: Promise<void> | undefined;
		let flushAgainRequested = false;
		const bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_BUFFER_SIZE);
		const maxBytes = Math.max(1, options.maxBytes);
		const maxFiles = Math.max(0, options.maxFiles);
		const batchWindowMs = Math.max(0, options.batchWindowMs ?? 0);

		const clearFlushTimer = () => {
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushTimer = undefined;
			}
		};

		const drainOnce = async () => {
			const lines = buffer.splice(0, buffer.length);
			if (lines.length === 0) return;
			await mkdir(dirname(options.filePath), { recursive: true }).catch(
				() => undefined,
			);
			for (const line of lines) {
				await rotateFilesNow(
					options.filePath,
					maxBytes,
					maxFiles,
					Buffer.byteLength(line),
				).catch(() => undefined);
				await appendFileFs(options.filePath, line, "utf8").catch(
					() => undefined,
				);
			}
		};

		const runFlush = (): Promise<void> => {
			if (flushInProgress !== undefined) {
				flushAgainRequested = true;
				return flushInProgress;
			}
			clearFlushTimer();
			flushInProgress = (async () => {
				try {
					do {
						flushAgainRequested = false;
						await drainOnce();
					} while (flushAgainRequested || buffer.length > 0);
				} finally {
					flushInProgress = undefined;
				}
			})();
			return flushInProgress;
		};

		const flush = () =>
			Effect.tryPromise({
				try: runFlush,
				catch: () => undefined,
			}).pipe(Effect.withTracerEnabled(false), Effect.ignore);

		const flushAccepted = () =>
			Effect.tryPromise({
				try: async () => {
					await runFlush();
					while (buffer.length > 0 || flushInProgress !== undefined) {
						await runFlush();
					}
				},
				catch: () => undefined,
			}).pipe(Effect.withTracerEnabled(false), Effect.ignore);

		const scheduleFlush = () => {
			if (batchWindowMs === 0 || flushTimer !== undefined) return;
			flushTimer = setTimeout(() => {
				flushTimer = undefined;
				void runFlush();
			}, batchWindowMs);
			flushTimer.unref?.();
		};

		const enqueue = (record: TraceRecord) => {
			if (closed) return;
			buffer.push(safeJsonLine(record, maxBytes));
			if (buffer.length >= bufferSize) {
				void runFlush();
			} else {
				scheduleFlush();
			}
		};

		const sink: TraceSink = {
			write: (record) =>
				Effect.gen(function* () {
					if (closed) return;
					buffer.push(safeJsonLine(record, maxBytes));
					if (buffer.length >= bufferSize) {
						yield* flush();
					} else {
						scheduleFlush();
					}
				}).pipe(Effect.withTracerEnabled(false), Effect.ignore),
			writeSync: enqueue,
			flush,
			close: () =>
				Effect.gen(function* () {
					closed = true;
					clearFlushTimer();
					yield* flushAccepted();
				}).pipe(Effect.withTracerEnabled(false), Effect.ignore),
		};

		return sink;
	});

interface MutableTraceSpan extends Tracer.Span {
	readonly _events: TraceRecordEvent[];
	_status: Tracer.SpanStatus;
	readonly _attributes: Map<string, unknown>;
	_links: ReadonlyArray<Tracer.SpanLink>;
}

const makeSpanId = (): string =>
	Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
		.toString(16)
		.padStart(16, "0")
		.slice(0, 16);

const parentTraceId = (
	parent: Option.Option<Tracer.AnySpan>,
): string | undefined =>
	Option.isSome(parent) ? parent.value.traceId : undefined;

const parentSpanId = (
	parent: Option.Option<Tracer.AnySpan>,
): string | undefined =>
	Option.isSome(parent) ? parent.value.spanId : undefined;

const exitToTraceRecordExit = (
	exit: Exit.Exit<unknown, unknown>,
): TraceRecordExit => {
	if (Exit.isSuccess(exit)) return { _tag: "Success" };
	const causeSummary = Option.match(Exit.causeOption(exit), {
		onNone: () => "",
		onSome: (value) =>
			JSON.stringify(
				compactTraceAttributes({
					failures: Cause.failures(value),
					defects: Cause.defects(value),
					interrupted: Cause.isInterrupted(value),
				}),
			),
	});
	const bounded = compactTraceAttributes({ cause: causeSummary })[
		"cause"
	] as string;
	if (Exit.isInterrupted(exit)) {
		return { _tag: "Interrupted", cause: bounded };
	}
	return { _tag: "Failure", cause: bounded };
};

interface CompositeTraceSpan extends Tracer.Span {
	readonly localSpan: Tracer.Span;
	readonly upstreamSpan: Tracer.Span;
}

const isCompositeSpan = (span: Tracer.AnySpan): span is CompositeTraceSpan =>
	span._tag === "Span" && "localSpan" in span && "upstreamSpan" in span;

const mapParentSpan = (
	parent: Option.Option<Tracer.AnySpan>,
	selector: (span: CompositeTraceSpan) => Tracer.Span,
): Option.Option<Tracer.AnySpan> =>
	Option.map(parent, (span) => (isCompositeSpan(span) ? selector(span) : span));

const mapLinks = (
	links: ReadonlyArray<Tracer.SpanLink>,
	selector: (span: CompositeTraceSpan) => Tracer.Span,
): ReadonlyArray<Tracer.SpanLink> =>
	links.map((link) => ({
		...link,
		span: isCompositeSpan(link.span) ? selector(link.span) : link.span,
	}));

export const makeCompositeTracer = (
	localTracer: Tracer.Tracer,
	upstreamTracer: Tracer.Tracer,
): Tracer.Tracer =>
	Tracer.make({
		span(name, parent, context, links, startTime, kind, options) {
			const localSpan = localTracer.span(
				name,
				mapParentSpan(parent, (span) => span.localSpan),
				context,
				mapLinks(links, (span) => span.localSpan),
				startTime,
				kind,
				options,
			);
			const upstreamSpan = upstreamTracer.span(
				name,
				mapParentSpan(parent, (span) => span.upstreamSpan),
				context,
				mapLinks(links, (span) => span.upstreamSpan),
				startTime,
				kind,
				options,
			);
			return {
				_tag: "Span" as const,
				name,
				spanId: localSpan.spanId,
				traceId: localSpan.traceId,
				parent,
				context,
				get status() {
					return localSpan.status;
				},
				get attributes() {
					return localSpan.attributes;
				},
				get links() {
					return localSpan.links;
				},
				sampled: localSpan.sampled || upstreamSpan.sampled,
				kind,
				localSpan,
				upstreamSpan,
				end(endTime, exit) {
					localSpan.end(endTime, exit);
					upstreamSpan.end(endTime, exit);
				},
				attribute(key, value) {
					localSpan.attribute(key, value);
					upstreamSpan.attribute(key, value);
				},
				event(eventName, eventTime, eventAttributes) {
					localSpan.event(eventName, eventTime, eventAttributes);
					upstreamSpan.event(eventName, eventTime, eventAttributes);
				},
				addLinks(newLinks) {
					localSpan.addLinks(mapLinks(newLinks, (span) => span.localSpan));
					upstreamSpan.addLinks(
						mapLinks(newLinks, (span) => span.upstreamSpan),
					);
				},
			} satisfies CompositeTraceSpan;
		},
		context(f, fiber) {
			const currentSpan = fiber.currentSpan;
			const upstreamFiber =
				currentSpan !== undefined && isCompositeSpan(currentSpan)
					? ({
							...fiber,
							currentSpan: currentSpan.upstreamSpan,
						} as typeof fiber)
					: fiber;
			return upstreamTracer.context(
				() => localTracer.context(f, fiber),
				upstreamFiber,
			);
		},
	});

export const spanToTraceRecord = (span: Tracer.Span): TraceRecord => {
	const status = span.status;
	const endTime = status._tag === "Ended" ? status.endTime : status.startTime;
	const startTime = status.startTime;
	const durationNs = endTime - startTime;
	const parentId = parentSpanId(span.parent);
	return {
		type: "effect-span",
		schemaVersion: 1,
		service: "conduit-daemon",
		name: span.name,
		traceId: span.traceId,
		spanId: span.spanId,
		...(parentId !== undefined && { parentSpanId: parentId }),
		startTimeNanos: startTime.toString(),
		endTimeNanos: endTime.toString(),
		durationMs: Number(durationNs) / 1_000_000,
		attributes: compactTraceAttributes(Object.fromEntries(span.attributes)),
		events: (span as Partial<MutableTraceSpan>)._events ?? [],
		links: span.links.map((link) => ({
			traceId: link.span.traceId,
			spanId: link.span.spanId,
			attributes: compactTraceAttributes(link.attributes),
		})),
		exit:
			status._tag === "Ended"
				? exitToTraceRecordExit(status.exit)
				: { _tag: "Interrupted" },
	};
};

export const makeLocalFileTracer = (
	options: LocalFileTracerOptions,
	_runtime?: Runtime.Runtime<never>,
): Tracer.Tracer => {
	const sink = options.sink;
	return Tracer.make({
		span(name, parent, context, links, startTime, kind) {
			const attributes = new Map<string, unknown>();
			let status: Tracer.SpanStatus = { _tag: "Started", startTime };
			let spanLinks = links;
			const span = {
				_tag: "Span" as const,
				name,
				spanId: makeSpanId(),
				traceId: parentTraceId(parent) ?? makeSpanId() + makeSpanId(),
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
				_events: [] as TraceRecordEvent[],
				get _status() {
					return status;
				},
				set _status(value: Tracer.SpanStatus) {
					status = value;
				},
				_attributes: attributes,
				get _links() {
					return spanLinks;
				},
				set _links(value: ReadonlyArray<Tracer.SpanLink>) {
					spanLinks = value;
				},
				end(endTime, exit) {
					if (status._tag === "Ended") return;
					status = { _tag: "Ended", startTime, endTime, exit };
					if (sink !== undefined) {
						sink.writeSync(spanToTraceRecord(span));
					}
				},
				attribute(key, value) {
					attributes.set(key, value);
				},
				event(eventName, eventTime, eventAttributes) {
					span._events.push({
						name: eventName,
						timeNanos: eventTime.toString(),
						...(eventAttributes !== undefined && {
							attributes: compactTraceAttributes(eventAttributes),
						}),
					});
				},
				addLinks(newLinks) {
					spanLinks = [...spanLinks, ...newLinks];
				},
			} satisfies MutableTraceSpan;
			return span;
		},
		context(f, _fiber) {
			return f();
		},
	});
};

export const makeLocalTraceArtifactLive = (
	options: TraceSinkOptions,
): Layer.Layer<never> =>
	Layer.unwrapScoped(
		Effect.gen(function* () {
			const sink = yield* makeTraceSink(options);
			const runtime = yield* Effect.runtime<never>();
			yield* Effect.addFinalizer(sink.close);
			return Layer.setTracer(
				makeLocalFileTracer({ ...options, sink }, runtime),
			);
		}),
	);
