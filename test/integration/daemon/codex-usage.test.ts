// Failure modes: merged main/Spark allowances, lost sparse resets, live updates
// probing again, duplicate token totals, fresh threads on reset, cross-account
// continuation, signed-out probes throwing, and incomplete trace consumption.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageReading } from "../../../src/lib/contracts/limit-recovery.js";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const RESET = 1_800_000_000;

describe("Codex usage through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	let artifactRoot = "";
	let tracePath = "";
	let usagePath = "";
	let reportPath = "";
	let capturePath = "";
	let gatePath = "";
	let evidence: Record<string, unknown> = {};
	const writeTrace = (path: string, trace: TraceRow[]) =>
		writeFileSync(
			path,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);

	async function start(name: string) {
		artifactRoot = resolve(`test-results/codex-usage/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		reportPath = join(artifactRoot, "trace-report.jsonl");
		capturePath = join(artifactRoot, "capture.jsonl");
		writeFileSync(reportPath, "");
		writeFileSync(capturePath, "");
		evidence = { scenario: name };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const fixture = harness;
		tracePath = join(fixture.root, "codex-replay.jsonl");
		usagePath = join(fixture.root, "codex-usage.jsonl");
		gatePath = join(fixture.root, "gate");
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		writeTrace(tracePath, signedInCodexDiscoveryTrace());
		writeTrace(usagePath, fixtureRows("usage-read"));
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			continuationSweepIntervalMs: 100,
			serviceEnvironment: {
				CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
				CONDUIT_TEST_CODEX_USAGE_TRACE: usagePath,
				CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
			},
		});
		const browser = await fixture.connect();
		const account = (await browser.instances()).instances.find(
			({ driver }) => driver === "codex",
		);
		if (!account) throw new Error("Missing Codex account");
		await codexModels(browser, account.id);
		return { fixture, browser, accountId: account.id };
	}

	async function createTurn(
		name: string,
		source = name,
		modelId = "gpt-6.1-sol",
	) {
		const context = await start(name);
		sessionId = await context.browser.createSession(
			name,
			context.accountId,
			"codex",
			{
				modelId,
				contextWindow: "",
				permissionMode: "full",
			},
		);
		writeTrace(tracePath, fixtureRows(source));
		return { ...context, id: sessionId };
	}

	const quota = async (fixture: ProcessHarness, accountId: string) =>
		(
			await fixture.requestRpc({
				_tag: "QuotaForAccounts",
				projectSlug: "process-test",
			})
		).find((reading) => reading.accountId === accountId);

	afterEach(async ({ task }) => {
		if (!harness) return;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const fixture = harness;
		const state = sessionId ? snapshot(fixture, sessionId) : undefined;
		try {
			await fixture.dispose();
			const reports = rows<AppServerTraceReport>(reportPath);
			evidence["traceReports"] = reports;
			expect(reports.length).toBeGreaterThan(0);
			for (const report of reports) {
				expect(report.consumed).toBe(report.total);
				expect(report.mismatches).toEqual([]);
				expect(report.unconsumed).toEqual([]);
			}
			expect(fixture.remainingRunnerPids()).toEqual([]);
			expect(fixture.proof().rpcDecodeFailures).toEqual([]);
		} finally {
			writeFileSync(
				join(artifactRoot, "events.json"),
				`${JSON.stringify(state ?? {}, null, 2)}\n`,
			);
			const runnerLog = join(fixture.configDir, "runners.log");
			if (existsSync(runnerLog))
				writeFileSync(
					join(artifactRoot, "runners.log"),
					readFileSync(runnerLog),
				);
			writeFileSync(
				join(artifactRoot, "evidence.json"),
				`${JSON.stringify({ ...evidence, result: task.result?.state, process: fixture.proof() }, null, 2)}\n`,
			);
			harness = undefined;
			sessionId = undefined;
		}
	});

	it(
		"reads main and Spark windows with independent resets",
		async () => {
			const { fixture, accountId } = await start("usage-read");
			const reading = await quota(fixture, accountId);
			expect(reading).toMatchObject({
				harness: "codex",
				status: "available",
				windows: [
					{
						id: "codex:primary",
						label: "Codex 5h",
						utilization: 40,
						resetsAt: new Date(RESET * 1000).toISOString(),
					},
					{
						id: "codex:secondary",
						label: "Codex Week",
						utilization: 60,
						resetsAt: new Date((RESET + 86400) * 1000).toISOString(),
					},
					{
						id: "codex_spark:primary",
						label: "Spark 5h",
						utilization: 20,
						resetsAt: new Date((RESET + 3600) * 1000).toISOString(),
					},
					{
						id: "codex_spark:secondary",
						label: "Spark Week",
						utilization: 30,
						resetsAt: new Date((RESET + 90000) * 1000).toISOString(),
					},
				],
			});
			expect(
				reading?.windows.every(
					(window) => !("history" in window) && !("forecast" in window),
				),
			).toBe(true);
			evidence["reading"] = reading;
		},
		TIMEOUT,
	);

	it(
		"reports signed-out usage as unavailable",
		async () => {
			const { fixture, accountId } = await start("signed-out");
			const trace = fixtureRows("usage-read");
			const index = trace.findIndex(
				(row) => row.message?.method === "account/rateLimits/read",
			);
			trace.splice(index);
			const account = trace.find((row) => row.message?.result?.["account"]);
			if (!account?.message?.result) throw new Error("Missing account/read");
			account.message.result["account"] = null;
			writeTrace(usagePath, trace);
			expect(await quota(fixture, accountId)).toMatchObject({
				status: "unavailable",
				windows: [],
				reason: expect.stringMatching(/codex login/),
			});
		},
		TIMEOUT,
	);

	it(
		"publishes a sparse mid-turn update without probing and preserves other allowances",
		async () => {
			const { fixture, browser, accountId, id } =
				await createTurn("usage-updated");
			const updates: (readonly UsageReading[])[] = [];
			const subscription = Effect.runFork(
				Stream.runForEach(browser.rpc.SubscribeUsage({}), ({ readings }) =>
					Effect.sync(() => {
						updates.push(readings);
					}),
				),
			);
			try {
				await vi.waitFor(
					() =>
						expect(
							updates.at(-1)?.find((reading) => reading.accountId === accountId)
								?.windows,
						).toHaveLength(4),
					{ timeout: TIMEOUT },
				);
				const readsBefore = rows<AppServerTraceReport>(reportPath).filter(
					(report) => report.scenario === "usage-read",
				).length;
				writeFileSync(gatePath, "10000");
				await fixture.requestRpc({
					_tag: "input.submit",
					sessionId: id,
					inputId: randomUUID(),
					delivery: "queue",
					text: "Say hello",
				});
				await vi.waitFor(
					() =>
						expect(
							rows<TraceRow>(capturePath).some(
								(row) => row.message?.method === "turn/start",
							),
						).toBe(true),
					{ timeout: TIMEOUT },
				);
				writeFileSync(gatePath, "50000");
				await vi.waitFor(
					() =>
						expect(
							updates
								.at(-1)
								?.find((reading) => reading.accountId === accountId)
								?.windows.find((window) => window.id === "codex_spark:primary"),
						).toMatchObject({
							utilization: 75,
							resetsAt: new Date((RESET + 3600) * 1000).toISOString(),
						}),
					{ timeout: TIMEOUT },
				);
				const reading = updates
					.at(-1)
					?.find((reading) => reading.accountId === accountId);
				expect(reading?.windows).toHaveLength(4);
				expect(
					reading?.windows.find((window) => window.id === "codex:primary")
						?.utilization,
				).toBe(40);
				expect(
					snapshot(fixture, id).turns.map(({ state }) => state),
				).not.toContain("completed");
				expect(
					rows<AppServerTraceReport>(reportPath).filter(
						(report) => report.scenario === "usage-read",
					),
				).toHaveLength(readsBefore);
				evidence["liveReading"] = reading;
				writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
				await vi.waitFor(
					() =>
						expect(
							snapshot(fixture, id).turns.map(({ state }) => state),
						).toEqual(["completed"]),
					{ timeout: TIMEOUT },
				);
			} finally {
				await Effect.runPromise(Fiber.interrupt(subscription));
			}
		},
		TIMEOUT,
	);

	it.each(["usage-limit", "usage-limit-429"])(
		"%s marks the session with its reset",
		async (source) => {
			const { fixture, browser, accountId, id } = await createTurn(source);
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "session.usage_limited",
							data: expect.objectContaining({
								instanceId: accountId,
								resetsAt: RESET,
							}),
						}),
					),
				{ timeout: TIMEOUT },
			);
			const sessions = await fixture.requestRpc({
				_tag: "ListDaemonSessions",
				projectSlug: "process-test",
			});
			expect(
				sessions.sessions.find((session) => session.id === id)?.limitRecovery,
			).toMatchObject({
				instanceId: accountId,
				resetsAt: RESET,
				continued: false,
			});
		},
		TIMEOUT,
	);

	it.each([
		{
			name: "main-429",
			source: "error-usage_limited-429",
			modelId: "gpt-6.1-sol",
			limitId: "codex",
		},
		{
			name: "main-sparse",
			source: "usage-limit",
			modelId: "gpt-6.1-sol",
			limitId: "codex",
		},
		{
			name: "spark-429",
			source: "error-usage_limited-429",
			modelId: "gpt-6-luna",
			limitId: "codex_spark",
		},
	])(
		"uses the latest account reset for $name with missing live reset data",
		async ({ name, source, modelId, limitId }) => {
			const { fixture, accountId, id } = await createTurn(
				`limit-from-reading-${name}`,
				source,
				modelId,
			);
			const turn = fixtureRows(source);
			const terminal = turn.findIndex(
				(row) => row.message?.method === "turn/completed",
			);
			for (const row of turn.slice(terminal)) row["at"] = 100000;
			if (source === "usage-limit") {
				const notification = turn.find(
					(row) => row.message?.method === "account/rateLimits/updated",
				)?.message?.params?.["rateLimits"] as
					| Record<string, unknown>
					| undefined;
				if (!notification) throw new Error("Missing live rate limit");
				notification["primary"] = {
					usedPercent: 100,
					windowDurationMins: null,
					resetsAt: null,
				};
			}
			writeTrace(tracePath, turn);
			writeFileSync(gatePath, "10000");
			await fixture.requestRpc({
				_tag: "input.submit",
				sessionId: id,
				inputId: randomUUID(),
				delivery: "queue",
				text: "Say hello",
			});
			await vi.waitFor(
				() =>
					expect(
						rows<TraceRow>(capturePath).some(
							(row) =>
								row.dir === "out" && row.message?.method === "turn/start",
						),
					).toBe(true),
				{ timeout: TIMEOUT },
			);
			const trace = fixtureRows("usage-read");
			const result = trace.find(
				(row) => row.message?.result?.["rateLimitsByLimitId"],
			)?.message?.result;
			const buckets = result?.["rateLimitsByLimitId"] as
				| Record<string, Record<string, unknown>>
				| undefined;
			if (!buckets?.[limitId]) throw new Error("Missing allowance");
			// The bucket's model alias is opaque, just like its limit ID. Use a
			// captured catalog model to exercise lookup without extending discovery.
			if (limitId === "codex_spark")
				buckets[limitId]["normalModelSlug"] = modelId;
			buckets[limitId]["primary"] = {
				usedPercent: 100,
				windowDurationMins: 300,
				resetsAt: RESET,
			};
			writeTrace(usagePath, trace);
			await quota(fixture, accountId);
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "session.usage_limited",
							data: expect.objectContaining({
								instanceId: accountId,
								rateLimitType: limitId,
								resetsAt: RESET,
							}),
						}),
					),
				{ timeout: TIMEOUT },
			);
		},
		TIMEOUT,
	);

	it(
		"resumes at reset on the stored native thread",
		async () => {
			const { fixture, browser, accountId, id } = await createTurn(
				"usage-resume",
				"usage-limit",
			);
			await fixture.requestRpc({
				_tag: "SetUsageLimitsSetting",
				usageLimits: {
					autoResume: true,
					autoSwitch: true,
					order: [],
					warnAt: 80,
				},
			});
			// As in the process continuation tests, use a short sweep and a controlled
			// reset timestamp rather than fake timers in the parent process.
			const reset = Math.floor(Date.now() / 1000) + 30;
			const quotaTrace = fixtureRows("usage-read");
			const quotaResult = quotaTrace.find(
				(row) => row.message?.result?.["rateLimitsByLimitId"],
			)?.message?.result;
			const buckets = quotaResult?.["rateLimitsByLimitId"] as
				| Record<string, Record<string, unknown>>
				| undefined;
			if (!buckets?.["codex_spark"]) throw new Error("Missing Spark allowance");
			buckets["codex_spark"]["primary"] = {
				usedPercent: 100,
				windowDurationMins: 300,
				resetsAt: reset + 3600,
			};
			writeTrace(usagePath, quotaTrace);
			expect(await quota(fixture, accountId)).toMatchObject({
				status: "limited",
				windows: expect.arrayContaining([
					expect.objectContaining({ limitId: "codex", utilization: 40 }),
					expect.objectContaining({ limitId: "codex_spark", utilization: 100 }),
				]),
			});
			// Cache Spark-only exhaustion; subsequent probes reflect the main limit.
			const primary = {
				usedPercent: 100,
				windowDurationMins: 300,
				resetsAt: reset,
			};
			if (!buckets["codex"] || !quotaResult)
				throw new Error("Missing Codex allowance");
			buckets["codex"]["primary"] = primary;
			(quotaResult["rateLimits"] as Record<string, unknown>)["primary"] =
				primary;
			writeTrace(usagePath, quotaTrace);
			const limited = fixtureRows("usage-limit");
			for (const row of limited) {
				const bucket = row.message?.params?.["rateLimits"] as
					| Record<string, unknown>
					| undefined;
				if (bucket)
					bucket["primary"] = {
						usedPercent: 100,
						windowDurationMins: 300,
						resetsAt: reset,
					};
			}
			writeTrace(tracePath, limited);
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "session.resume_scheduled",
							data: expect.objectContaining({ at: reset }),
						}),
					),
				{ timeout: TIMEOUT },
			);
			const initialCapture = rows<TraceRow>(capturePath);
			writeTrace(join(artifactRoot, "initial-capture.jsonl"), initialCapture);
			const original = initialCapture.find(
				(row) => row.dir === "out" && row.message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			expect(original).toBeTypeOf("string");
			const resumed = fixtureRows("usage-resume");
			const savedThread = resumed.find(
				(row) => row.message?.method === "thread/resume",
			)?.message?.params?.["threadId"];
			if (typeof savedThread !== "string")
				throw new Error("Missing recorded resumed thread");
			writeTrace(
				tracePath,
				JSON.parse(
					JSON.stringify(resumed).replaceAll(savedThread, String(original)),
				) as TraceRow[],
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "session.resumed",
							data: expect.objectContaining({
								instanceId: accountId,
								reason: "reset",
							}),
						}),
					),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
						["completed"],
					),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const captured = [...initialCapture, ...rows<TraceRow>(capturePath)];
			expect(
				captured.filter(
					(row) => row.dir === "out" && row.message?.method === "thread/start",
				),
			).toHaveLength(1);
			expect(
				captured
					.filter(
						(row) =>
							row.dir === "out" && row.message?.method === "thread/resume",
					)
					.map((row) => row.message?.params?.["threadId"]),
			).toEqual([original]);
			evidence["nativeThread"] = original;
			evidence["sparkStillLimitedAtResume"] = true;
		},
		TIMEOUT,
	);

	it(
		"sums multiple model responses and deduplicates repeated cumulative totals",
		async () => {
			const { fixture, browser, id } = await createTurn(
				"multi-response",
				"turn-command",
			);
			const trace = fixtureRows("turn-command");
			const index = trace.findIndex(
				(row) => row.message?.method === "thread/tokenUsage/updated",
			);
			const usage = trace[index];
			if (!usage) throw new Error("Missing captured usage");
			trace.splice(index, 0, structuredClone(usage));
			writeTrace(tracePath, trace);
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "turn.completed",
							data: expect.objectContaining({
								tokens: expect.objectContaining({
									input: 38,
									output: 26,
								}),
								contextTokens: 19,
							}),
						}),
					),
				{ timeout: TIMEOUT },
			);
		},
		TIMEOUT,
	);
});
