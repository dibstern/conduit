// Failure modes: streamed usage counted again at wait, cumulative usage hiding
// background follow-up turns, context summed across requests, account-denied
// cost failing a valid turn, cents treated as dollars, old turns' late billing
// charged to a new turn, SDK error codes replaced by message matching, diagnostic text lost,
// Conduit resending SDK-retried failures, cancellation hanging indefinitely,
// durable retry scheduling despite a terminal SDK failure,
// wait/stream failures replacing their original transport diagnostic,
// late terminal updates reopening interrupted turns, and force-resume colliding
// with the abandoned controller's still-live run.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddInstance } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: unknown;
	[key: string]: unknown;
}

interface StoredEvent {
	type: string;
	data: Record<string, unknown>;
	metadata: Record<string, unknown>;
	createdAt: number;
}

const TIMEOUT = 90_000;
const BASIC_USAGE = {
	inputTokens: 7742,
	outputTokens: 51,
	cacheReadTokens: 3427,
	cacheWriteTokens: 0,
	totalTokens: 11220,
};

function traceRows(path: string): TraceRow[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceRow);
}

function snapshot(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		const events = db
			.prepare<
				[string],
				{ type: string; data: string; metadata: string; created_at: number }
			>(
				"SELECT type, data, metadata, created_at FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(sessionId)
			.map<StoredEvent>((event) => ({
				type: event.type,
				data: JSON.parse(event.data) as Record<string, unknown>,
				metadata: JSON.parse(event.metadata) as Record<string, unknown>,
				createdAt: event.created_at,
			}));
		return {
			events,
			commands: db
				.prepare<
					[string],
					{
						status: string;
						attemptCount: number;
						nextAttemptAt: number | null;
					}
				>(
					"SELECT status, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
			turns: db
				.prepare<[string], { state: string }>(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId)
				.map(({ state }) => state),
		};
	} finally {
		db.close();
	}
}

describe("Cursor usage, errors and cancellation through daemon and runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	let tracePath = "";
	let capturePath = "";
	let scenario = "setup";
	let sources: string[] = [];
	let diagnostics: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];

	function writeTrace(
		source: string,
		operations: TraceRow[] = [],
		transform?: (rows: TraceRow[]) => TraceRow[],
	) {
		sources.push(source);
		const captured = traceRows(
			resolve(`test/fixtures/cursor-sdk-traces/${source}.jsonl`),
		);
		const rows = transform ? transform(captured) : captured;
		const catalog = traceRows(
			resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
		).find(({ kind }) => kind === "models.list");
		if (!catalog) throw new Error("Basic capture has no model catalog");
		rows.splice(
			1,
			0,
			{
				kind: "credential.store",
				data: {
					apiKey: "[REDACTED]",
					backendUrl: "https://api2.cursor.sh",
					createdAtMs: 0,
				},
			},
			...(!rows.some(({ kind }) => kind === "models.list") ? [catalog] : []),
			...operations.filter(({ kind }) => kind !== "send.error"),
		);
		const send = rows.findIndex(({ kind }) => kind === "send.options");
		rows.splice(
			send + 1,
			0,
			...operations.filter(({ kind }) => kind === "send.error"),
		);
		writeFileSync(
			tracePath,
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}

	async function start(
		name: string,
		source = "basic",
		scheduling: { terminalDelayMs?: number; neverSettles?: boolean } = {},
	) {
		scenario = name;
		sources = [];
		diagnostics = {};
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		tracePath = join(harness.root, "cursor-replay.jsonl");
		capturePath = join(harness.root, "cursor-capture.jsonl");
		writeTrace(source);
		await harness.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				...(scheduling.terminalDelayMs === undefined
					? {}
					: {
							CONDUIT_TEST_CURSOR_CANCEL_TERMINAL_DELAY_MS: String(
								scheduling.terminalDelayMs,
							),
						}),
				...(scheduling.neverSettles
					? { CONDUIT_TEST_CURSOR_CANCEL_NEVER_SETTLES: "1" }
					: {}),
			},
		});
		const added = await harness.requestRpc(
			new AddInstance({ name: "Cursor usage replay", driver: "cursor" }),
		);
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await harness.connect();
		sessionId = await browser.createSession(
			name,
			added.addedInstanceId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "", permissionMode: "ask" },
		);
		return { fixture: harness, browser, id: sessionId };
	}

	async function submit(browser: ProcessBrowser, id: string, text: string) {
		await Effect.runPromise(
			browser.rpc.input.submit({
				sessionId: id,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text,
			}),
		);
	}

	async function expectTurns(
		fixture: ProcessHarness,
		id: string,
		states: readonly string[],
	) {
		await vi.waitFor(
			() => expect(snapshot(fixture, id).turns).toEqual(states),
			{
				timeout: TIMEOUT,
				interval: 100,
			},
		);
	}

	function record(name: string, invariants: Record<string, boolean>) {
		if (!harness || !sessionId) throw new Error("No Cursor session");
		scenarios.push({
			scenario: name,
			...snapshot(harness, sessionId),
			invariants,
		});
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const state = sessionId ? snapshot(fixture, sessionId) : undefined;
		const captured = traceRows(capturePath);
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			const proof = fixture.proof();
			scenarios.push({
				scenario,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
				sources,
				diagnostics,
				...state,
				capturedOperations: captured.filter(({ kind }) =>
					[
						"create.options",
						"resume.options",
						"send.options",
						"send.error",
						"usage",
						"usage.error",
						"wait.result",
						"wait.result.error",
						"wait.error",
						"stream.error",
						"cancel.call",
					].includes(kind ?? ""),
				),
				invariants: {
					isolatedConfig: true,
					realDaemon: proof.generations.every(({ pid }) => pid > 0),
					noRemainingRunner: fixture.remainingRunnerPids().length === 0,
					noRpcDecodeFailure: proof.rpcDecodeFailures.length === 0,
				},
				process: {
					buildIdentity: proof.buildIdentity,
					generations: proof.generations.map(({ pid, exitCode, signal }) => ({
						pid,
						exitCode,
						signal,
					})),
					runnerPids: fixture.runnerPids(),
					remainingRunnerPids: fixture.remainingRunnerPids(),
					...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
				},
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.19.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.19", scenarios }, null, 2)}\n`,
			);
			harness = undefined;
			sessionId = undefined;
		}
	}, TIMEOUT);

	it("reconciles streamed, same-run follow-up and cumulative usage once", async () => {
		const { fixture, browser, id } = await start("usage-reconciliation");
		const cases = [
			{
				source: "basic",
				tokens: { input: 7742, output: 51, cacheRead: 3427, cacheWrite: 0 },
				contextTokens: 11169,
			},
			{
				source: "turn-usage-followup",
				tokens: { input: 11153, output: 97, cacheRead: 3863, cacheWrite: 0 },
				contextTokens: 3847,
			},
			{
				source: "turn-usage-final-extra",
				tokens: { input: 15484, output: 102, cacheRead: 6854, cacheWrite: 0 },
				contextTokens: 11169,
			},
		];
		for (const [index, testCase] of cases.entries()) {
			writeTrace(testCase.source);
			await submit(browser, id, `Replay usage ${testCase.source}.`);
			await expectTurns(fixture, id, Array(index + 1).fill("completed"));
			const completed = snapshot(fixture, id).events.filter(
				({ type }) => type === "turn.completed",
			);
			expect(completed).toHaveLength(index + 1);
			expect(completed.at(-1)?.data).toMatchObject({
				tokens: testCase.tokens,
				contextTokens: testCase.contextTokens,
			});
			expect(completed.at(-1)?.data).not.toHaveProperty("cost");
			const assistant = (await browser.history(id))
				.filter(({ role }) => role === "assistant")
				.at(-1);
			expect(assistant).toMatchObject({
				contextTokens: testCase.contextTokens,
				tokens: {
					input: testCase.tokens.input,
					output: testCase.tokens.output,
					cache: {
						read: testCase.tokens.cacheRead,
						write: testCase.tokens.cacheWrite,
					},
					context_window: 0,
				},
			});
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "turn.error",
				),
			).toEqual([]);
			record(testCase.source, {
				usageCountedOnce: true,
				lastRequestContext: true,
				missingCostNotError: true,
			});
		}
		const claudeId = await browser.createSession("Unchanged Claude usage");
		await browser.send(claudeId, "usage-provider-parity", TIMEOUT);
		await expectTurns(fixture, claudeId, ["completed"]);
		const claudeState = snapshot(fixture, claudeId);
		const claudeCompletion = claudeState.events.find(
			({ type }) => type === "turn.completed",
		);
		expect(claudeCompletion?.data["tokens"]).not.toHaveProperty(
			"contextWindow",
		);
		const claudeHistory = await browser.history(claudeId);
		expect(
			claudeHistory.find(({ role }) => role === "assistant")?.tokens,
		).not.toHaveProperty("context_window");
		diagnostics["unrelatedClaudeProvider"] = {
			completion: claudeCompletion,
			history: claudeHistory,
		};
	}, 240_000);

	it("omits unavailable cost and charges only correlated per-turn cents", async () => {
		const { fixture, browser, id } = await start("optional-cost");
		const run = (runId: string, chargedCents?: number) => ({
			runId,
			usage: BASIC_USAGE,
			...(chargedCents === undefined
				? {}
				: { cost: { rawCostCents: 900, chargedCents } }),
		});
		const usage = (
			chargedCents?: number,
			runs: ReturnType<typeof run>[] = [],
		): TraceRow => ({
			kind: "usage",
			data: {
				usage: Object.fromEntries(
					Object.entries(BASIC_USAGE).map(([key, value]) => [
						key,
						value * Math.max(1, runs.length),
					]),
				),
				runs,
				...(chargedCents === undefined
					? {}
					: { cost: { rawCostCents: 1900, chargedCents } }),
			},
		});
		const denied: TraceRow = {
			kind: "usage.error",
			data: {
				name: "UnknownAgentError",
				message: "This local account cannot read billed usage.",
				code: "feature_unavailable",
				status: 403,
				isRetryable: false,
			},
		};
		// Local billing UUIDs identify usage groups, not the SDK run handle.
		const prior = "db1d8d17-dafb-4012-badb-2bb4b714ef48";
		const current = "97aa30dc-6c20-4a04-b218-a1c73afae40f";
		const old = run(prior, 50.25);
		const cases = [
			{ name: "missing", operations: [usage(), usage()] },
			{ name: "denied", operations: [denied, denied] },
			{
				name: "aggregate-only",
				operations: [usage(50.25), usage(75.75)],
			},
			{
				name: "late-old-charge",
				operations: [
					usage(50.25, [old]),
					usage(75.75, [run(prior, 50.5), run(current, 25.25)]),
				],
			},
			{
				name: "correlated-current-charge",
				operations: [
					usage(50.25, [old]),
					usage(75.75, [old, run(current, 25.5)]),
				],
				cost: 0.255,
			},
			{
				name: "correlated-included-turn",
				operations: [usage(50.25, [old]), usage(50.25, [old, run(current, 0)])],
				cost: 0,
			},
		];
		for (const [index, testCase] of cases.entries()) {
			writeTrace("basic", testCase.operations);
			await submit(browser, id, `Replay optional cost ${testCase.name}.`);
			await expectTurns(fixture, id, Array(index + 1).fill("completed"));
			const completed = snapshot(fixture, id).events.filter(
				({ type }) => type === "turn.completed",
			);
			const data = completed.at(-1)?.data;
			if (testCase.cost === undefined) expect(data).not.toHaveProperty("cost");
			else expect(data?.["cost"]).toBeCloseTo(testCase.cost, 9);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "turn.error",
				),
			).toEqual([]);
			record(`cost:${testCase.name}`, {
				optionalCostNotError: true,
				chargedOnlyWhenCurrentTurnCorrelated: true,
			});
		}
		record("optional-cost-and-correlated-per-turn-cents", {
			missingCostNotError: true,
			deniedCostNotError: true,
			aggregateOnlyDeltaNotAttributed: true,
			latePriorTurnBillingNotAttributed: true,
			correlatedPerTurnChargedCentsConvertedToDollars: true,
			includedCurrentTurnCostsZero: true,
		});
	}, 240_000);

	it("maps SDK errors, preserves diagnostics and never resends failed turns", async () => {
		const { fixture, browser, id } = await start("sdk-errors");
		const cases = [
			["AuthenticationError", "UNAUTHORIZED", false, "auth_required"],
			["RateLimitError", "RATE_LIMITED", true, "rate_limited"],
			["ConfigurationError", "BAD_MODEL_NAME", false, "model_unavailable"],
			["ConfigurationError", "MODEL_BLOCKED", false, "model_unavailable"],
			["NetworkError", "unavailable", true, "network_error"],
			["CursorSdkError", "connection_stalled", true, "network_error"],
			["AgentBusyError", "agent_busy", false, "agent_busy"],
			["UnknownAgentError", undefined, false, "provider_error"],
		] as const;
		for (const [index, [name, code, retryable, mapped]] of cases.entries()) {
			const message = `transport diagnostic ${index}\nendpoint=/agent.Run\nframe={opaque: detail}`;
			writeTrace("basic", [
				{
					kind: "send.error",
					data: {
						name,
						message,
						...(code ? { code } : {}),
						isRetryable: retryable,
					},
				},
			]);
			await submit(browser, id, `Fail with ${name} ${code ?? "no-code"}.`);
			await expectTurns(fixture, id, Array(index + 1).fill("error"));
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).commands).toEqual(
						Array.from({ length: index + 1 }, () => ({
							status: "failed",
							attemptCount: 1,
							nextAttemptAt: null,
						})),
					),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const errors = snapshot(fixture, id).events.filter(
				({ type }) => type === "turn.error",
			);
			expect(errors).toHaveLength(index + 1);
			expect(errors.at(-1)?.data).toMatchObject({
				code: mapped,
				retryable,
				error: `${message}\n\n${retryable ? "You can retry this turn." : "Resolve this error before retrying."}`,
			});
			expect(
				traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(index + 1);
			record(`${name}:${code ?? "no-code"}`, {
				declaredSdkErrorMapped: true,
				retryabilityStored: true,
				transportDiagnosticPreserved: true,
				oneSdkSendForOneInput: true,
				durableNoRetryScheduled: true,
			});
		}
	}, 360_000);

	it("preserves wait and stream failures without scheduling another send", async () => {
		const { fixture, browser, id } = await start("wait-stream-failures");
		for (const [index, operation] of [
			"terminal",
			"wait.result.error",
			"stream.error",
		].entries()) {
			const message = `transport ${operation} diagnostic\nendpoint=/agent.Run\nframe={opaque: full dump ${index}}`;
			const failure = {
				name: "NetworkError",
				message,
				code:
					operation === "stream.error" ? "connection_stalled" : "unavailable",
				isRetryable: true,
			};
			writeTrace("basic", [], (rows) =>
				rows.flatMap((row) => {
					if (row.kind === "wait.result") {
						if (operation === "stream.error") return [];
						if (operation === "wait.result.error")
							return [{ ...row, kind: operation, data: failure }];
						return [
							{
								...row,
								data: {
									...(row.data as Record<string, unknown>),
									status: "error",
									error: { message, code: "connection_stalled" },
								},
							},
						];
					}
					if (operation === "stream.error" && row.kind === "stream.end")
						return [{ kind: operation, data: failure }, row];
					return [row];
				}),
			);
			await submit(browser, id, `Fail through ${operation}.`);
			await expectTurns(fixture, id, Array(index + 1).fill("error"));
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).commands).toEqual(
						Array.from({ length: index + 1 }, () => ({
							status: "failed",
							attemptCount: 1,
							nextAttemptAt: null,
						})),
					),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const errors = snapshot(fixture, id).events.filter(
				({ type }) => type === "turn.error",
			);
			expect(errors).toHaveLength(index + 1);
			expect(errors.at(-1)?.data).toMatchObject({
				code: "network_error",
				retryable: true,
				error: `${message}\n\nYou can retry this turn.`,
			});
			expect(
				traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(index + 1);
			record(operation, {
				transportDiagnosticPreserved: true,
				declaredSdkErrorShapeMapped: true,
				oneSdkSendForOneInput: true,
				durableNoRetryScheduled: true,
			});
		}
	}, 240_000);

	it("interrupts at ten seconds and ignores a later authoritative terminal", async () => {
		const { fixture, browser, id } = await start(
			"late-cancel-terminal",
			"cancel",
			{
				terminalDelayMs: 10_500,
			},
		);
		await submit(
			browser,
			id,
			"Call the human custom tool once, then say done.",
		);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, id).events.some(
						({ type }) => type === "thinking.delta",
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
		);
		await expectTurns(fixture, id, ["interrupted"]);
		const interrupted = snapshot(fixture, id).events.find(
			({ type }) => type === "turn.interrupted",
		);
		const cancel = traceRows(capturePath).find(
			({ kind }) => kind === "cancel.call",
		);
		expect(interrupted).toBeDefined();
		expect(typeof cancel?.["at"]).toBe("string");
		const fallbackMs =
			(interrupted?.createdAt ?? 0) - Date.parse(String(cancel?.["at"]));
		diagnostics["fallbackMs"] = fallbackMs;
		expect(fallbackMs).toBeGreaterThanOrEqual(10_000);
		expect(fallbackMs).toBeLessThan(20_000);
		await vi.waitFor(
			() =>
				expect(
					traceRows(capturePath).filter(({ kind }) => kind === "wait.result"),
				).toHaveLength(1),
			{ timeout: TIMEOUT, interval: 20 },
		);
		const terminal = traceRows(capturePath).find(
			({ kind }) => kind === "wait.result",
		);
		expect(Date.parse(String(terminal?.["at"]))).toBeGreaterThan(
			interrupted?.createdAt ?? 0,
		);
		await vi.waitFor(() => expect(fixture.remainingRunnerPids()).toEqual([]), {
			timeout: TIMEOUT,
		});
		const state = snapshot(fixture, id);
		expect(state.turns).toEqual(["interrupted"]);
		expect(
			state.events.filter(({ type }) =>
				["turn.completed", "turn.error", "turn.interrupted"].includes(type),
			),
		).toEqual([interrupted]);
		record("late-terminal-ignored", {
			defaultTenSecondFallback: true,
			lateTerminalActuallyArrived: true,
			oneInterruptedTerminal: true,
			abandonedControllerExited: true,
		});
	}, 240_000);

	it("sends immediately after fallback by replacing the still-live controller", async () => {
		const { fixture, browser, id } = await start(
			"live-abandoned-run",
			"cancel",
			{
				neverSettles: true,
			},
		);
		await submit(
			browser,
			id,
			"Call the human custom tool once, then say done.",
		);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, id).events.some(
						({ type }) => type === "thinking.delta",
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
		);
		await expectTurns(fixture, id, ["interrupted"]);
		const abandoned = fixture.runnerPids();
		expect(abandoned).toHaveLength(1);
		expect(fixture.remainingRunnerPids()).toEqual(abandoned);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "wait.result"),
		).toEqual([]);
		const startedAt = Date.now();
		await submit(browser, id, "Say cancel followup.");
		await expectTurns(fixture, id, ["interrupted", "completed"]);
		diagnostics["recoveryMs"] = Date.now() - startedAt;
		expect(Date.now() - startedAt).toBeLessThan(30_000);
		expect(fixture.runnerPids()).toHaveLength(2);
		expect(fixture.remainingRunnerPids()).not.toContain(abandoned[0]);
		const captured = traceRows(capturePath);
		expect(captured.filter(({ kind }) => kind === "send.options")).toHaveLength(
			2,
		);
		expect(
			captured.filter(({ kind }) => kind === "resume.options"),
		).toHaveLength(1);
		const created = captured.find(({ kind }) => kind === "created")?.data as
			| Record<string, unknown>
			| undefined;
		expect(
			captured.find(({ kind }) => kind === "resume.options")?.data,
		).toMatchObject({ agentId: created?.["agentId"] });
		expect(
			captured.filter(({ kind }) => kind === "send.options").at(-1)?.data,
		).toMatchObject({ options: { local: { force: true } } });
		expect(
			snapshot(fixture, id).events.filter(({ type }) => type === "turn.error"),
		).toEqual([]);
		const history = await browser.history(id);
		expect(
			history.some(
				({ role, text }) => role === "assistant" && text === "cancel followup",
			),
		).toBe(true);
		record("fresh-controller-after-fallback", {
			oldRunStillLiveAtNextAdmission: true,
			boundedControllerReplacement: true,
			resumeForceAfterOldProcessExit: true,
			noAgentBusy: true,
			capturedFollowupAnswered: true,
		});
	}, 240_000);
});
