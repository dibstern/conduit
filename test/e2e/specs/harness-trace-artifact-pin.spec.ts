import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "../helpers/process-harness-fixture.js";

// Behaviour pin conduit-test-16c8.5: the local trace artifact honours its
// duration floor, its traced-session exemption and its failure exemption.
// The daemon runs with CONDUIT_TRACE_MIN_MS above the 5 ms default, so an
// ignored variable shows up as kept spans between the two, and with
// CONDUIT_TRACE_SESSION set to one of two active sessions.
//
// Failure modes and the assertion that catches each:
// - Tracing off, file path ignored, or no flush on graceful shutdown: the
//   trace file is missing or holds no effect-span records.
// - Floor ignored, or the session exemption leaks to other sessions or to
//   session-less work: a successful sub-floor span that neither carries the
//   traced sessionId nor descends from a span that does is in the file.
// - CONDUIT_TRACE_SESSION ignored: no successful sub-floor span carries or
//   descends from the traced session.
// - The exemption matches only spans that carry sessionId themselves: no
//   successful sub-floor span inherits the traced session from an ancestor.
// - Failures filtered by duration like successes: an RPC routed to an
//   unknown project fails with a typed "unavailable" error well under the
//   floor, yet no sub-floor Failure span outside the traced session is kept.
//   No other step of the scenario fails, so that span comes from this RPC.
// - The failing RPC succeeds or hangs: its observed error is not the
//   project-unavailable message; bounded timeouts turn hangs into failures.
// Ancestry is resolved inside the file, so a filtered intermediate span would
// surface as a floor violation rather than pass silently.

const traceMinMs = 100;
const artifactPath = join("test-results", "16c8-5-trace-artifact.json");

type TraceSpan = {
	readonly name: string;
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly durationMs: number;
	readonly attributes?: Record<string, unknown>;
	readonly exit?: { readonly _tag?: string };
};

const readSpans = (file: string): TraceSpan[] =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((record) => record["type"] === "effect-span")
				.map((record) => record as unknown as TraceSpan)
		: [];

const classify = (spans: readonly TraceSpan[], tracedSessionId: string) => {
	const byId = new Map(
		spans.map((span) => [`${span.traceId}:${span.spanId}`, span]),
	);
	const descendsFromTraced = (span: TraceSpan): boolean => {
		const seen = new Set<TraceSpan>();
		for (
			let current: TraceSpan | undefined = span;
			current !== undefined && !seen.has(current);
			current = byId.get(`${current.traceId}:${current.parentSpanId}`)
		) {
			seen.add(current);
			if (current.attributes?.["sessionId"] === tracedSessionId) return true;
		}
		return false;
	};
	return spans.map((span) => ({
		name: span.name,
		durationMs: span.durationMs,
		exit: span.exit?._tag ?? "Unknown",
		underFloor: span.durationMs < traceMinMs,
		tracedSession: descendsFromTraced(span),
		ownSessionId: span.attributes?.["sessionId"] === tracedSessionId,
	}));
};

type Classified = ReturnType<typeof classify>[number];

const summarize = (spans: readonly Classified[]) =>
	[...new Set(spans.map(({ name }) => name))].sort().map((name) => {
		const named = spans.filter((span) => span.name === name);
		const count = (predicate: (span: Classified) => boolean) =>
			named.filter(predicate).length;
		return {
			name,
			count: named.length,
			underFloor: count(({ underFloor }) => underFloor),
			tracedSession: count(({ tracedSession }) => tracedSession),
			succeeded: count(({ exit }) => exit === "Success"),
			failed: count(({ exit }) => exit === "Failure"),
			interrupted: count(({ exit }) => exit === "Interrupted"),
			minDurationMs: Math.min(...named.map(({ durationMs }) => durationMs)),
			maxDurationMs: Math.max(...named.map(({ durationMs }) => durationMs)),
		};
	});

test.describe.configure({ retries: 0 });
test.use({ harnessOptions: { logLevel: "warn" } });

test("trace artifact keeps traced, failed and slow spans and drops other short spans", async ({
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	const traceFile = join(harness.root, "trace-artifact-pin.trace.ndjson");
	const missingProjectSlug = `missing-${randomUUID()}`;
	let tracedSessionId: string | null = null;
	let otherSessionId: string | null = null;
	let tracedReply: string[] = [];
	let otherReply: string[] = [];
	let failure: { name: string; message: string } | null = null;
	let scenarioError: unknown;
	try {
		// CONDUIT_TRACE_SESSION needs an existing ID, so create both sessions,
		// then restart the same store with tracing configured.
		const setup = await harness.connect();
		tracedSessionId = await setup.createSession("Traced session");
		otherSessionId = await setup.createSession("Other session");
		await harness.terminate();
		await harness.restart({
			keepPort: true,
			skipBrowserProbe: true,
			serviceEnvironment: {
				CONDUIT_TRACE_ENABLED: "1",
				CONDUIT_TRACE_FILE: traceFile,
				CONDUIT_TRACE_MAX_BYTES: String(1_073_741_824),
				CONDUIT_TRACE_MIN_MS: String(traceMinMs),
				CONDUIT_TRACE_SESSION: tracedSessionId,
			},
		});
		const driver = await harness.connect();
		await expect
			.poll(() => harness.generations.at(-1)?.fakeSdkActive)
			.toBe(true);
		tracedReply = (await driver.send(tracedSessionId, "traced-turn")).chunks;
		otherReply = (await driver.send(otherSessionId, "other-turn")).chunks;
		await driver.history(otherSessionId);
		failure = await Effect.runPromise(
			driver.rpc
				.ListPtys({
					projectSlug: missingProjectSlug,
					originId: driver.originId,
				})
				.pipe(Effect.timeout("15 seconds")),
		).then(
			() => null,
			(error: unknown) => ({
				name: error instanceof Error ? error.name : typeof error,
				message: error instanceof Error ? error.message : String(error),
			}),
		);
	} catch (error) {
		scenarioError = error;
	}
	// Graceful shutdown flushes the NDJSON exporter before it is read.
	await harness.terminate();
	const fileExists = existsSync(traceFile);
	const spans =
		tracedSessionId === null
			? []
			: classify(readSpans(traceFile), tracedSessionId);
	const shortOutsideTraced = spans.filter(
		(span) => span.exit === "Success" && span.underFloor && !span.tracedSession,
	);
	const shortInsideTraced = spans.filter(
		(span) => span.exit === "Success" && span.underFloor && span.tracedSession,
	);
	const failed = spans.filter(({ exit }) => exit === "Failure");
	const unavailableMessage = `Project "${missingProjectSlug}" unavailable`;
	const report = {
		traceMinMs,
		fileExists,
		sessions: {
			traced: { replyChunks: tracedReply.length },
			other: { replyChunks: otherReply.length },
		},
		failingRpc: {
			method: "ListPtys",
			error: failure && {
				name: failure.name,
				projectUnavailable: failure.message.includes(unavailableMessage),
			},
			failedSpans: failed
				.map(({ name, durationMs, underFloor, tracedSession }) => ({
					name,
					durationMs,
					underFloor,
					tracedSession,
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
		},
		totals: {
			spans: spans.length,
			shortSuccessfulOutsideTracedSession: shortOutsideTraced.length,
			shortSuccessfulInsideTracedSession: shortInsideTraced.length,
			shortSuccessfulInheritingTracedSession: shortInsideTraced.filter(
				({ ownSessionId }) => !ownSessionId,
			).length,
			failed: failed.length,
		},
		spans: summarize(spans),
	};
	mkdirSync("test-results", { recursive: true });
	writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
	await testInfo.attach("16c8-5-trace-artifact", {
		path: artifactPath,
		contentType: "application/json",
	});
	if (scenarioError !== undefined) throw scenarioError;

	expect(fileExists, "The daemon must write the trace file").toBe(true);
	expect(spans.length, "The trace file must hold spans").toBeGreaterThan(0);
	expect(tracedReply.length, "The traced turn must reply").toBeGreaterThan(0);
	expect(otherReply.length, "The other turn must reply").toBeGreaterThan(0);
	expect(
		failure?.message ?? null,
		"The RPC must fail with its typed error",
	).toContain(unavailableMessage);
	expect
		.soft(
			[...new Set(shortOutsideTraced.map(({ name }) => name))],
			`Successful spans under ${traceMinMs} ms must descend from the traced session`,
		)
		.toEqual([]);
	expect
		.soft(
			shortInsideTraced.length,
			"Short successful spans of the traced session must be kept",
		)
		.toBeGreaterThan(0);
	expect
		.soft(
			shortInsideTraced.filter(({ ownSessionId }) => !ownSessionId).length,
			"Short successful child spans of a traced-session span must be kept",
		)
		.toBeGreaterThan(0);
	expect
		.soft(
			failed.filter(
				({ underFloor, tracedSession }) => underFloor && !tracedSession,
			).length,
			"A failed span under the floor and outside the traced session must be kept",
		)
		.toBeGreaterThan(0);
});
