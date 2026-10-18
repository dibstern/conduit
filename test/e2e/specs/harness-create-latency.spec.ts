import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrowserContext, Page } from "@playwright/test";
import { Effect } from "effect";
import {
	HEAVY_SESSION_ID,
	seedSessionLoadFixture,
} from "../../fixtures/session-load.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failures distinguish sidebar latency, insufficient streaming load, shell
// replacement reads, missing slow-RPC logs, and trace filtering regressions.
// Successful spans below the floor must belong to the debugged session through
// their own sessionId or an ancestor in the file; errors are always retained.
const parameter = (name: string, fallback: number): number => {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error(`${name} must be a positive integer`);
	return value;
};

const parameters = {
	devices: parameter("CREATE_LATENCY_DEVICES", 4),
	creates: parameter("CREATE_LATENCY_CREATES", 50),
	arrivalTimeoutMs: parameter("CREATE_LATENCY_ARRIVAL_TIMEOUT_MS", 5_000),
	gapMs: 200,
	streams: 3,
	streamIntervalMs: 100,
	slowRpcMs: 1,
	traceMinMs: 5,
};
// Calibrated 2026-10-16: worst p90 of three runs (30.7 ms) x 1.5, rounded up to 25 ms.
const budgetMs = parameter("CREATE_LATENCY_P90_BUDGET_MS", 50);
const now = () => performance.timeOrigin + performance.now();

interface ArrivalObserver {
	readonly seen: Map<string, number>;
	readonly observer: MutationObserver;
	sessionId?: string;
	finish?: (at: number) => void;
}

declare global {
	interface Window {
		__createLatencyObservers?: Map<number, ArrivalObserver>;
	}
}

// The ID is returned by CreateSession, so collect new rows before submitting
// and select that ID afterwards. A fast arrival cannot race the RPC reply.
const armArrival = (page: Page, index: number) =>
	page.evaluate((index) => {
		const sidebar = document.querySelector("#sidebar-panel-sessions");
		if (!sidebar) throw new Error("Session sidebar is missing");
		const initial = new Set(
			Array.from(sidebar.querySelectorAll("[data-session-id]"), (row) =>
				row.getAttribute("data-session-id"),
			),
		);
		const seen = new Map<string, number>();
		const state: ArrivalObserver = {
			seen,
			observer: new MutationObserver(() => {
				for (const row of sidebar.querySelectorAll("[data-session-id]")) {
					const id = row.getAttribute("data-session-id");
					if (
						id &&
						!initial.has(id) &&
						!seen.has(id) &&
						row.getClientRects().length > 0
					) {
						const at = performance.timeOrigin + performance.now();
						seen.set(id, at);
						if (state.sessionId === id) state.finish?.(at);
					}
				}
			}),
		};
		(window.__createLatencyObservers ??= new Map()).set(index, state);
		state.observer.observe(sidebar, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-session-id", "class", "style"],
		});
	}, index);

const arrival = (
	page: Page,
	index: number,
	sessionId: string,
	submittedAt: number,
) =>
	page.evaluate(
		({ index, sessionId, deadline }) =>
			new Promise<number | null>((resolve) => {
				const states = window.__createLatencyObservers;
				const state = states?.get(index);
				if (!state) throw new Error("Arrival observer was not armed");
				const finish = (at: number | null) => {
					clearTimeout(timer);
					state.observer.disconnect();
					states?.delete(index);
					resolve(at);
				};
				const timer = setTimeout(
					() => finish(null),
					Math.max(0, deadline - (performance.timeOrigin + performance.now())),
				);
				state.sessionId = sessionId;
				state.finish = (at) => finish(at <= deadline ? at : null);
				const at = state.seen.get(sessionId);
				if (at !== undefined) state.finish(at);
			}),
		{ index, sessionId, deadline: submittedAt + parameters.arrivalTimeoutMs },
	);

const distribution = (values: readonly number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
		p90: sorted[Math.ceil(sorted.length * 0.9) - 1] ?? null,
		max: sorted.at(-1) ?? null,
	};
};

const records = (file: string): Record<string, unknown>[] =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.slice(0, -1)
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];

const traceSummary = (file: string, debuggedSessionId: string | null) => {
	const spans = records(file).filter(
		(record) => record["type"] === "effect-span",
	);
	const byId = new Map(
		spans.map((span) => [`${span["traceId"]}:${span["spanId"]}`, span]),
	);
	const belongsToDebuggedSession = (span: Record<string, unknown>): boolean => {
		if (debuggedSessionId === null) return false;
		let current: Record<string, unknown> | undefined = span;
		const seen = new Set<Record<string, unknown>>();
		while (current !== undefined && !seen.has(current)) {
			seen.add(current);
			const attributes = current["attributes"];
			if (
				typeof attributes === "object" &&
				attributes !== null &&
				"sessionId" in attributes &&
				attributes.sessionId === debuggedSessionId
			)
				return true;
			current = byId.get(`${current["traceId"]}:${current["parentSpanId"]}`);
		}
		return false;
	};
	const shortSuccesses = spans.filter((span) => {
		const exit = span["exit"];
		return (
			typeof exit === "object" &&
			exit !== null &&
			"_tag" in exit &&
			exit._tag === "Success" &&
			typeof span["durationMs"] === "number" &&
			span["durationMs"] < parameters.traceMinMs
		);
	});
	const debuggedShortSpans = shortSuccesses.filter(belongsToDebuggedSession);
	const sqlSpans = spans.filter((span) => span["name"] === "sqlite");
	return {
		spans: spans.length,
		debuggedSessionId,
		subFloorSpansForDebuggedSession: debuggedShortSpans.length,
		subFloorSpansForOtherSessions:
			shortSuccesses.length - debuggedShortSpans.length,
		createSessionSpans: spans.filter(
			(span) => span["name"] === "RpcServer.CreateSession",
		).length,
		sqlSpans: sqlSpans.length,
		shortSqlSpans: sqlSpans.filter(
			(span) => Number(span["durationMs"]) < parameters.traceMinMs,
		).length,
		minimumSqlMs:
			sqlSpans.length === 0
				? null
				: sqlSpans.reduce(
						(minimum, span) => Math.min(minimum, Number(span["durationMs"])),
						Number.POSITIVE_INFINITY,
					),
	};
};

interface Sample {
	readonly index: number;
	readonly submittedAt: number;
	sessionId: string | null;
	rpcMs: number | null;
	arrivals: { device: number; at: number | null; ms: number | null }[];
	slowestMs: number | null;
	arrivalError?: string;
}

interface Metrics {
	readonly flushedAt: number;
	readonly readModelReads: readonly {
		readonly at: number;
		readonly source: string;
		readonly kind: string;
	}[];
}

test.describe.configure({ retries: 0 });
test.use({ harnessOptions: { logLevel: "warn" } });

test("creates reach every sidebar under streaming write load", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(180_000 + parameters.creates * 2_000);
	const contexts: BrowserContext[] = [];
	const samples: Sample[] = [];
	const metricsFile = join(harness.root, "create-latency-metrics.json");
	const logFile = join(harness.root, "create-latency-daemon.log");
	const traceFile = join(harness.root, "create-latency.trace.ndjson");
	const expectedWriteRate =
		(parameters.streams * 1_000) / parameters.streamIntervalMs;
	let phaseStart: number | null = null;
	let phaseEnd: number | null = null;
	let backgroundTicks = 0;
	let achievedWriteRate = 0;
	let backgroundMeasured = false;
	const diagnosticErrors: string[] = [];
	const shellReads: Record<string, number> = {};
	let fixture: Awaited<ReturnType<typeof seedSessionLoadFixture>> | null = null;
	let stopped = false;
	let debuggedSessionId: string | null = null;
	try {
		// The fixture server can create the session before tracing is configured.
		// Seeding appends to its store, so the existing restart preserves this ID
		// and enables record-all before any streams or latency measurements start.
		const setupDriver = await harness.connect(
			undefined,
			undefined,
			undefined,
			false,
		);
		debuggedSessionId = await setupDriver.createSession("Latency stream 0");
		await harness.terminate();
		fixture = await seedSessionLoadFixture(harness.daemonStorePath(), {
			projectId: "process-test",
		});
		await harness.restart({
			keepPort: true,
			skipBrowserProbe: true,
			metricsFile,
			logFile,
			serviceEnvironment: {
				CONDUIT_SLOW_RPC_MS: String(parameters.slowRpcMs),
				CONDUIT_TRACE_ENABLED: "1",
				CONDUIT_TRACE_FILE: traceFile,
				CONDUIT_TRACE_MAX_BYTES: String(1_073_741_824),
				CONDUIT_TRACE_MIN_MS: String(parameters.traceMinMs),
				CONDUIT_TRACE_SESSION: debuggedSessionId,
			},
		});
		const driver = await harness.connect(
			undefined,
			undefined,
			undefined,
			false,
		);
		await expect
			.poll(() => harness.generations.at(-1)?.fakeSdkActive)
			.toBe(true);
		await driver.view(debuggedSessionId);
		await driver.history(debuggedSessionId);
		const streams: string[] = [];
		for (let index = 0; index < parameters.streams; index++) {
			const sessionId =
				index === 0
					? debuggedSessionId
					: await driver.createSession(`Latency stream ${index}`);
			await Effect.runPromise(
				driver.rpc["input.submit"]({
					sessionId,
					originId: driver.originId,
					inputId: randomUUID(),
					text: `load-stream-${index}`,
					delivery: "queue",
				}),
			);
			streams.push(sessionId);
		}
		const pages: Page[] = [];
		for (let device = 0; device < parameters.devices; device++) {
			const context = await browser.newContext({
				viewport: { width: 1440, height: 900 },
				isMobile: false,
			});
			contexts.push(context);
			const page = await context.newPage();
			pages.push(page);
			await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
			await expect(
				page.locator(`[data-session-id="${HEAVY_SESSION_ID}"]`).first(),
			).toBeVisible({ timeout: 30_000 });
		}
		const database = new DatabaseSync(harness.daemonStorePath(), {
			readOnly: true,
		});
		try {
			// Count tick tokens, so coalescing several SDK deltas into one event
			// cannot inflate or undercount the achieved background write rate.
			const tickQuery = database.prepare(`
				SELECT coalesce(sum((length(json_extract(data, '$.text')) -
					length(replace(json_extract(data, '$.text'), 'tick(', ''))) / 5), 0) AS n
				FROM events WHERE type = 'text.delta'
				AND session_id IN (${streams.map(() => "?").join(",")})
			`);
			const ticks = () => Number(tickQuery.get(...streams)?.["n"] ?? 0);
			await expect.poll(ticks).toBeGreaterThan(parameters.streams * 10);
			// Let connection snapshots settle before measuring replacement reads.
			await new Promise((resolve) => setTimeout(resolve, 500));
			const beforeTicks = ticks();
			phaseStart = now();
			try {
				const pending: Promise<void>[] = [];
				for (let index = 0; index < parameters.creates; index++) {
					await Promise.all(pages.map((page) => armArrival(page, index)));
					const sample: Sample = {
						index,
						submittedAt: now(),
						sessionId: null,
						rpcMs: null,
						arrivals: pages.map((_, device) => ({
							device,
							at: null,
							ms: null,
						})),
						slowestMs: null,
					};
					samples.push(sample);
					const reply = await Effect.runPromise(
						driver.rpc
							.CreateSession({
								projectSlug: "process-test",
								providerId: "claude",
								permissionMode: "ask",
								originId: driver.originId,
								title: `Create latency ${index}`,
								model: {
									providerId: "claude",
									modelId: "sonnet",
									variant: "",
									contextWindow: "200k",
								},
							})
							.pipe(Effect.timeout("15 seconds")),
					);
					sample.rpcMs = now() - sample.submittedAt;
					sample.sessionId = reply.sessionId;
					pending.push(
						Promise.all(
							pages.map((page) =>
								arrival(page, index, reply.sessionId, sample.submittedAt),
							),
						).then(
							(arrivals) => {
								sample.arrivals = arrivals.map((at, device) => ({
									device,
									at,
									ms: at === null ? null : at - sample.submittedAt,
								}));
								sample.slowestMs = arrivals.includes(null)
									? null
									: Math.max(
											...arrivals.map((at) => (at ?? 0) - sample.submittedAt),
										);
							},
							(error: unknown) => {
								sample.arrivalError = String(error);
							},
						),
					);
					if (index + 1 < parameters.creates)
						await new Promise((resolve) =>
							setTimeout(resolve, parameters.gapMs),
						);
				}
				await Promise.all(pending);
			} finally {
				phaseEnd = now();
				try {
					backgroundTicks = ticks() - beforeTicks;
					achievedWriteRate =
						(backgroundTicks * 1_000) / (phaseEnd - phaseStart);
					backgroundMeasured = true;
				} catch (error) {
					diagnosticErrors.push(
						`Background write measurement: ${String(error)}`,
					);
				}
			}
		} finally {
			database.close();
		}
		await expect
			.poll(
				() =>
					(JSON.parse(readFileSync(metricsFile, "utf8")) as Metrics).flushedAt,
			)
			.toBeGreaterThan(phaseEnd ?? 0);
		// Graceful shutdown flushes the NDJSON exporter before inspecting it.
		await harness.terminate();
		stopped = true;
		const slowRecords = records(logFile).filter(
			(record) => record["msg"] === "slow rpc",
		);
		const trace = traceSummary(traceFile, debuggedSessionId);
		expect.soft(fixture.sessions).toBeGreaterThanOrEqual(10_000);
		expect.soft(samples).toHaveLength(parameters.creates);
		expect
			.soft(
				samples.flatMap((sample) =>
					sample.arrivals.filter(({ at }) => at === null),
				),
				"Every device must render every created session before its arrival deadline",
			)
			.toEqual([]);
		expect
			.soft(
				distribution(
					samples.flatMap(({ slowestMs }) =>
						slowestMs === null ? [] : [slowestMs],
					),
				).p90,
				"Create-to-slowest-device p90 must stay within its calibrated budget",
			)
			.toBeLessThanOrEqual(budgetMs);
		expect
			.soft(
				achievedWriteRate,
				"Background streams must sustain at least 80% of their configured write rate",
			)
			.toBeGreaterThanOrEqual(expectedWriteRate * 0.8);
		expect
			.soft(
				slowRecords.length,
				"CONDUIT_SLOW_RPC_MS=1 must emit slow rpc records",
			)
			.toBeGreaterThan(0);
		expect
			.soft(trace.spans, "Local trace must contain completed spans")
			.toBeGreaterThan(0);
		expect
			.soft(
				slowRecords.reduce(
					(total, record) =>
						(record["method"] === "CreateSession" ||
							record["method"] === "SubscribeShell") &&
						typeof record["sqlCount"] === "number" &&
						record["sqlCount"] > 0
							? total + record["sqlCount"]
							: total,
					0,
				),
				"CreateSession and SubscribeShell slow records must prove SQL activity",
			)
			.toBeGreaterThan(0);
		expect
			.soft(
				trace.subFloorSpansForOtherSessions,
				"Successful spans below CONDUIT_TRACE_MIN_MS must belong to the debugged session or its descendants",
			)
			.toBe(0);
		expect
			.soft(
				trace.subFloorSpansForDebuggedSession,
				"CONDUIT_TRACE_SESSION must retain short successful spans for the debugged session",
			)
			.toBeGreaterThan(0);
		expect
			.soft(
				trace.createSessionSpans,
				"Local trace must retain a RpcServer.CreateSession span",
			)
			.toBeGreaterThan(0);
	} finally {
		const cleanupErrors: string[] = [];
		if (!stopped) {
			if (phaseEnd !== null) {
				try {
					await expect
						.poll(
							() =>
								(JSON.parse(readFileSync(metricsFile, "utf8")) as Metrics)
									.flushedAt,
							{ timeout: 2_000 },
						)
						.toBeGreaterThan(phaseEnd);
				} catch (error) {
					diagnosticErrors.push(`Metrics flush: ${String(error)}`);
				}
			}
			try {
				await harness.terminate();
			} catch (error) {
				cleanupErrors.push(String(error));
			}
		}
		let metricsFlushedAt: number | null = null;
		if (phaseStart !== null && phaseEnd !== null) {
			try {
				const metrics = JSON.parse(
					readFileSync(metricsFile, "utf8"),
				) as Metrics;
				metricsFlushedAt = metrics.flushedAt;
				for (const read of metrics.readModelReads) {
					if (
						read.source === "shell" &&
						read.at >= phaseStart &&
						read.at <= phaseEnd
					)
						shellReads[read.kind] = (shellReads[read.kind] ?? 0) + 1;
				}
			} catch (error) {
				diagnosticErrors.push(`Shell read measurement: ${String(error)}`);
			}
		}
		const closed = await Promise.allSettled(
			contexts.map((context) => context.close()),
		);
		for (const result of closed) {
			if (result.status === "rejected")
				cleanupErrors.push(String(result.reason));
		}
		const slowRecords = records(logFile).filter(
			(record) =>
				record["msg"] === "slow rpc" &&
				(record["method"] === "CreateSession" ||
					record["method"] === "SubscribeShell"),
		);
		const report = {
			parameters,
			budgetMs,
			fixture,
			phaseStart,
			phaseEnd,
			cleanupErrors,
			diagnosticErrors,
			samples,
			slowestMs: distribution(
				samples.flatMap(({ slowestMs }) =>
					slowestMs === null ? [] : [slowestMs],
				),
			),
			rpcMs: distribution(
				samples.flatMap(({ rpcMs }) => (rpcMs === null ? [] : [rpcMs])),
			),
			background: {
				measured: backgroundMeasured,
				expectedWriteRate,
				achievedWriteRate,
				persistedTicks: backgroundTicks,
			},
			shell: {
				metricsFlushedAt,
				coversPhase:
					phaseEnd === null
						? null
						: metricsFlushedAt !== null && metricsFlushedAt >= phaseEnd,
				reads: shellReads,
				totalReads: Object.values(shellReads).reduce(
					(sum, count) => sum + count,
					0,
				),
				replacements: shellReads["replacement"] ?? 0,
			},
			slowRpc: slowRecords,
			trace: traceSummary(traceFile, debuggedSessionId),
		};
		mkdirSync("test-results", { recursive: true });
		const output = join(
			"test-results",
			`create-latency.${testInfo.project.name}.json`,
		);
		writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
		await testInfo.attach("create-latency", {
			path: output,
			contentType: "application/json",
		});
		expect
			.soft(
				shellReads["replacement"] ?? 0,
				"Create phase must not replace the shell snapshot",
			)
			.toBe(0);
		expect
			.soft(diagnosticErrors, "Create phase diagnostics must be available")
			.toEqual([]);
		expect
			.soft(cleanupErrors, "Isolated harness cleanup must succeed")
			.toEqual([]);
	}
});

test("overflow catches up every sidebar through create and delete bursts", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(280_000);
	const contexts: BrowserContext[] = [];
	const devices: {
		device: number;
		converged: boolean;
		ms: number | null;
		error?: string;
	}[] = Array.from({ length: 4 }, (_, device) => ({
		device,
		converged: false,
		ms: null,
	}));
	const created: { id: string; title: string }[] = [];
	let deleted: typeof created = [];
	let surviving: typeof created = [];
	const metricsFile = join(harness.root, "overflow-catch-up-metrics.json");
	const shellReads = { overflow: 0, window: 0, replacement: 0 };
	const diagnosticErrors: string[] = [];
	const cleanupErrors: string[] = [];
	let phaseStart: number | null = null;
	let phaseEnd: number | null = null;
	let metricsFlushedAt: number | null = null;
	let backgroundTicks = 0;
	try {
		await harness.terminate();
		await seedSessionLoadFixture(harness.daemonStorePath(), {
			projectId: "process-test",
		});
		await harness.restart({
			keepPort: true,
			skipBrowserProbe: true,
			metricsFile,
			serviceEnvironment: { CONDUIT_TEST_ADVANCE_BUS_CAPACITY: "1" },
		});
		const driver = await harness.connect(
			undefined,
			undefined,
			undefined,
			false,
		);
		await expect
			.poll(() => harness.generations.at(-1)?.fakeSdkActive)
			.toBe(true);
		const streams: string[] = [];
		for (let index = 0; index < parameters.streams; index++) {
			const sessionId = await driver.createSession(`Overflow stream ${index}`);
			await Effect.runPromise(
				driver.rpc["input.submit"]({
					sessionId,
					originId: driver.originId,
					inputId: randomUUID(),
					text: `load-stream-${index}`,
					delivery: "queue",
				}),
			);
			streams.push(sessionId);
		}
		const pages: Page[] = [];
		for (const { device } of devices) {
			const context = await browser.newContext({
				viewport: { width: 1440, height: 900 },
				isMobile: false,
			});
			contexts.push(context);
			const page = await context.newPage();
			pages[device] = page;
			await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
			await expect(
				page.locator(`[data-session-id="${HEAVY_SESSION_ID}"]`).first(),
			).toBeVisible({ timeout: 30_000 });
		}
		const database = new DatabaseSync(harness.daemonStorePath(), {
			readOnly: true,
		});
		try {
			const tickQuery = database.prepare(`
				SELECT coalesce(sum((length(json_extract(data, '$.text')) -
					length(replace(json_extract(data, '$.text'), 'tick(', ''))) / 5), 0) AS n
				FROM events WHERE type = 'text.delta'
				AND session_id IN (${streams.map(() => "?").join(",")})
			`);
			const ticks = () => Number(tickQuery.get(...streams)?.["n"] ?? 0);
			await expect.poll(ticks).toBeGreaterThan(parameters.streams * 10);
			// Keep setup snapshots outside the measured burst, as in the latency test.
			await new Promise((resolve) => setTimeout(resolve, 500));
			const beforeTicks = ticks();
			phaseStart = now();
			await Promise.all(
				Array.from({ length: 20 }, async (_, index) => {
					const title = `Overflow ${index}: ${randomUUID()}`;
					const reply = await Effect.runPromise(
						driver.rpc
							.CreateSession({
								projectSlug: "process-test",
								providerId: "claude",
								permissionMode: "ask",
								originId: driver.originId,
								title,
								model: {
									providerId: "claude",
									modelId: "sonnet",
									variant: "",
									contextWindow: "200k",
								},
							})
							.pipe(Effect.timeout("15 seconds")),
					);
					created.push({ id: reply.sessionId, title });
				}),
			);
			deleted = created.slice(0, 5);
			surviving = created.slice(5);
			await Promise.all(
				deleted.map(({ id }) =>
					Effect.runPromise(
						driver.rpc
							.DeleteSession({
								sessionId: id,
								originId: driver.originId,
							})
							.pipe(Effect.timeout("15 seconds")),
					),
				),
			);
			await Promise.all(
				devices.map(async (device) => {
					const page = pages[device.device];
					if (!page) throw new Error(`Missing sidebar device ${device.device}`);
					try {
						const result = await page.waitForFunction(
							({ surviving, deleted }) => {
								const sidebar = document.querySelector(
									"#sidebar-panel-sessions",
								);
								if (!sidebar) return false;
								const allSurvived = surviving.every(({ id, title }) => {
									const row = sidebar.querySelector(
										`[data-session-id="${id}"]`,
									);
									return (
										row !== null &&
										row.getClientRects().length > 0 &&
										row.textContent?.includes(title)
									);
								});
								const allDeleted = deleted.every(
									({ id, title }) =>
										!sidebar.querySelector(`[data-session-id="${id}"]`) &&
										!sidebar.textContent?.includes(title),
								);
								return allSurvived && allDeleted
									? performance.timeOrigin + performance.now()
									: false;
							},
							{ surviving, deleted },
							{ timeout: 30_000 },
						);
						const at = await result.jsonValue();
						await result.dispose();
						if (typeof at !== "number")
							throw new Error("Sidebar convergence did not return a timestamp");
						device.ms = at - (phaseStart ?? at);
						device.converged = true;
					} catch (error) {
						device.error = String(error);
					}
				}),
			);
			await expect.poll(ticks).toBeGreaterThan(beforeTicks);
			backgroundTicks = ticks() - beforeTicks;
		} finally {
			database.close();
		}
	} finally {
		phaseEnd = now();
		if (phaseStart !== null) {
			try {
				await expect
					.poll(
						() =>
							(JSON.parse(readFileSync(metricsFile, "utf8")) as Metrics)
								.flushedAt,
					)
					.toBeGreaterThan(phaseEnd);
			} catch (error) {
				diagnosticErrors.push(`Metrics flush: ${String(error)}`);
			}
		}
		try {
			await harness.terminate();
		} catch (error) {
			cleanupErrors.push(String(error));
		}
		try {
			const metrics = JSON.parse(readFileSync(metricsFile, "utf8")) as Metrics;
			metricsFlushedAt = metrics.flushedAt;
			for (const read of metrics.readModelReads) {
				if (
					read.source === "shell" &&
					phaseStart !== null &&
					read.at >= phaseStart &&
					read.at <= phaseEnd &&
					(read.kind === "overflow" ||
						read.kind === "window" ||
						read.kind === "replacement")
				)
					shellReads[read.kind] += 1;
			}
		} catch (error) {
			diagnosticErrors.push(`Shell read measurement: ${String(error)}`);
		}
		for (const result of await Promise.allSettled(
			contexts.map((context) => context.close()),
		)) {
			if (result.status === "rejected")
				cleanupErrors.push(String(result.reason));
		}
		mkdirSync("test-results", { recursive: true });
		const output = join(
			"test-results",
			`overflow-catch-up.${testInfo.project.name}.json`,
		);
		writeFileSync(
			output,
			`${JSON.stringify(
				{
					parameters: {
						devices: 4,
						creates: 20,
						deletes: 5,
						advanceBusCapacity: 1,
					},
					phaseStart,
					phaseEnd,
					devices,
					created,
					deleted,
					surviving,
					backgroundTicks,
					shell: { metricsFlushedAt, reads: shellReads },
					diagnosticErrors,
					cleanupErrors,
				},
				null,
				2,
			)}\n`,
		);
		await testInfo.attach("overflow-catch-up", {
			path: output,
			contentType: "application/json",
		});
		expect
			.soft(shellReads.overflow, "Overflow catch-up must run")
			.toBeGreaterThan(0);
		expect
			.soft(shellReads.replacement, "Shell must not replace its view")
			.toBe(0);
		expect.soft(created).toHaveLength(20);
		expect.soft(deleted).toHaveLength(5);
		expect.soft(surviving).toHaveLength(15);
		expect
			.soft(
				devices.filter(({ converged }) => !converged),
				"Every sidebar must converge",
			)
			.toEqual([]);
		expect
			.soft(diagnosticErrors, "Overflow diagnostics must be available")
			.toEqual([]);
		expect
			.soft(cleanupErrors, "Isolated harness cleanup must succeed")
			.toEqual([]);
	}
});
