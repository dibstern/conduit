// Failure modes: settling each native turn, losing successor output, stale Stop
// targets, goal commands becoming prompts, missing goal facts/details, and a
// successor gap holding the conduit turn forever. Every replay must be consumed.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const goalPhase = async (harness: ProcessHarness, sessionId: string) =>
	(
		await harness.requestRpc({
			_tag: "ListDaemonSessions",
			projectSlug: "process-test",
		})
	).sessions.find((session) => session.id === sessionId)?.goalPhase;
const OBJECTIVE = "Say hello";

describe("Codex goals through the daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId = "";
	let artifactRoot = "";
	let tracePath = "";
	let reportPath = "";
	let capturePath = "";
	let gatePath = "";

	function writeTrace(trace: TraceRow[]) {
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}

	async function start(
		name: string,
		source = name,
		{
			successorTimeoutMs,
			nativeCommandMs,
		}: { successorTimeoutMs?: number; nativeCommandMs?: number } = {},
	) {
		artifactRoot = resolve(`test-results/codex-goals/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		reportPath = join(artifactRoot, "trace-report.jsonl");
		capturePath = join(artifactRoot, "capture.jsonl");
		writeFileSync(reportPath, "");
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		tracePath = join(harness.root, "codex-replay.jsonl");
		gatePath = join(harness.root, "codex-replay-gate");
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		writeTrace(signedInCodexDiscoveryTrace());
		const restartOptions = {
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
				CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
				...(successorTimeoutMs === undefined
					? {}
					: {
							CONDUIT_TEST_CODEX_GOAL_SUCCESSOR_TIMEOUT_MS:
								String(successorTimeoutMs),
						}),
				...(nativeCommandMs === undefined
					? {}
					: {
							CONDUIT_TEST_RUN_LEDGER_NATIVE_COMMAND_MS:
								String(nativeCommandMs),
						}),
			},
		};
		await harness.restart(restartOptions);
		const fixture = harness;
		const browser = await fixture.connect();
		const account = await vi.waitFor(
			async () => {
				const found = (await browser.instances()).instances.find(
					({ driver }) => driver === "codex",
				);
				expect(found).toBeDefined();
				return found;
			},
			{ timeout: TIMEOUT },
		);
		if (!account) throw new Error("Missing Codex account");
		await codexModels(browser, account.id);
		sessionId = await browser.createSession(name, account.id, "codex", {
			modelId: "gpt-6.1-sol",
			contextWindow: "",
			permissionMode: "ask",
		});
		writeTrace(fixtureRows(source));
		return { fixture, browser, id: sessionId };
	}

	/**
	 * Sets the goal and sends the prompt that launches Codex: with no live thread the set is held
	 * for the launch, and goes as thread/goal/set once its turn/start is accepted (82tn.32.27).
	 */
	async function goalSend(
		browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
		id: string,
		timeout = TIMEOUT,
	) {
		expect(
			await Effect.runPromise(
				browser.rpc.SetGoal({
					sessionId: id,
					commandId: randomUUID(),
					condition: OBJECTIVE,
				}),
			),
		).toEqual({ ok: true });
		return browser.send(id, OBJECTIVE, timeout);
	}

	function requests() {
		return rows<TraceRow>(capturePath).filter(({ dir }) => dir === "out");
	}

	function resumeTrace(trace: TraceRow[], threadId: string) {
		const original = trace.find(
			({ message }) => message?.method === "turn/start",
		)?.message?.params?.["threadId"];
		if (typeof original !== "string")
			throw new Error("Missing recorded thread id");
		const resumed = JSON.parse(
			JSON.stringify(trace).replaceAll(original, threadId),
		) as TraceRow[];
		const start = resumed.find(
			({ message }) => message?.method === "thread/start",
		)?.message;
		if (!start) throw new Error("Missing recorded thread/start");
		start.method = "thread/resume";
		start.params = { ...start.params, threadId, excludeTurns: true };
		return resumed;
	}

	/**
	 * goal-paused with Codex never answering the Pause: neither its reply nor its paused notification
	 * comes. The deadline's re-read (thread/goal/get) then finds the goal at `read`; with `retry`, a
	 * second Pause follows and Codex answers that one.
	 */
	function unansweredPause(read: string, retry = false) {
		const trace = fixtureRows("goal-paused");
		const pause = trace.find(
			({ message }) =>
				message?.method === "thread/goal/set" &&
				message.params?.["status"] === "paused",
		)?.message;
		const answered = (row: TraceRow) =>
			(row.dir === "in" && row.message?.id === pause?.id) ||
			(row.message?.method === "thread/goal/updated" &&
				(row.message.params?.["goal"] as { status?: string }).status ===
					"paused");
		const answers = trace.filter(answered);
		const goal = answers[0]?.message?.result?.["goal"] as
			| { threadId: string; updatedAt: number }
			| undefined;
		if (!pause || !goal) throw new Error("Missing recorded Pause");
		const kept = trace.filter((row) => !answered(row));
		const exit = kept.findIndex(({ dir }) => dir === "exit");
		const again = (row: TraceRow): TraceRow => ({
			...row,
			at: 0,
			message: {
				...row.message,
				...(row.message?.id === undefined ? {} : { id: 903 }),
			},
		});
		return [
			...kept.slice(0, exit),
			{
				dir: "out",
				at: 0,
				message: {
					id: 902,
					method: "thread/goal/get",
					params: { threadId: goal.threadId },
				},
			},
			{
				dir: "in",
				at: 0,
				message: {
					id: 902,
					result: {
						goal: { ...goal, status: read, updatedAt: goal.updatedAt + 1 },
					},
				},
			},
			...(retry
				? [again({ dir: "out", at: 0, message: pause }), ...answers.map(again)]
				: []),
			...kept.slice(exit),
		];
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const fixture = harness;
		const state = snapshot(fixture, sessionId);
		const logPath = join(fixture.configDir, "runners.log");
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		try {
			await fixture.dispose();
			const reports = rows<AppServerTraceReport>(reportPath);
			expect(reports.length).toBeGreaterThan(0);
			for (const report of reports) {
				expect(report.consumed).toBe(report.total);
				expect(report.mismatches).toEqual([]);
				expect(report.unconsumed).toEqual([]);
			}
			expect(fixture.remainingRunnerPids()).toEqual([]);
			const evidence = JSON.stringify(
				{
					result: task.result?.state,
					reports,
					process: fixture.proof(),
					state,
				},
				null,
				2,
			);
			writeFileSync(join(artifactRoot, "evidence.json"), evidence);
			// The lane's per-box proof (82tn.32.27), named for the test's trace case.
			writeFileSync(
				resolve(`test-results/82tn-32-27-${basename(artifactRoot)}.json`),
				evidence,
			);
		} finally {
			writeFileSync(
				join(artifactRoot, "events.json"),
				JSON.stringify(state, null, 2),
			);
			writeFileSync(join(artifactRoot, "runners.log"), log);
			harness = undefined;
		}
	});

	it(
		"chains three native turns into one conduit terminal and serves goal details",
		async () => {
			const { fixture, browser, id } = await start("goal-chain");
			const reply = await goalSend(browser, id);
			expect(reply.chunks.join("")).toBe(
				"Hello from the mock model.".repeat(3),
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([{ state: "completed" }]),
				{ timeout: TIMEOUT },
			);
			const { events } = snapshot(fixture, id);
			expect(
				events.filter(({ type }) =>
					/^turn\.(completed|interrupted|error)$/.test(type),
				),
			).toHaveLength(1);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "session.goal_changed",
					data: expect.objectContaining({
						goal: null,
						ended: "met",
						endedGoal: expect.objectContaining({ condition: OBJECTIVE }),
					}),
				}),
			);
			const details = await Effect.runPromise(
				browser.rpc.GetGoalDetails({ sessionId: id }),
			);
			expect(details).toMatchObject({ judgeModel: null, turnCount: 1 });
			expect(details.setAt).toBeTypeOf("number");
			expect(details.metAt).toBeTypeOf("number");
			expect(
				requests().filter(({ message }) => message?.method === "turn/start"),
			).toHaveLength(1);
			expect(
				requests().find(({ message }) => message?.method === "turn/start")
					?.message?.params?.["input"],
			).toEqual([expect.objectContaining({ text: OBJECTIVE })]);
		},
		TIMEOUT * 2,
	);

	it.each(["paused", "cleared"] as const)(
		"a goal %s mid-turn by its action closes the held turn",
		async (ending) => {
			const { fixture, browser, id } = await start(`goal-${ending}`);
			const sending = goalSend(browser, id);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "session.goal_changed",
							data: expect.objectContaining({
								goal: expect.objectContaining({ condition: OBJECTIVE }),
							}),
						}),
					),
				{ timeout: TIMEOUT },
			);
			const action = { sessionId: id, commandId: randomUUID() };
			expect(
				await Effect.runPromise(
					ending === "paused"
						? browser.rpc.PauseGoal(action)
						: browser.rpc.ClearGoal(action),
				),
			).toEqual({ ok: true });
			await sending;
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([{ state: "completed" }]),
				{ timeout: TIMEOUT },
			);
			const { events } = snapshot(fixture, id);
			expect(
				events.filter(({ type }) =>
					/^turn\.(completed|interrupted|error)$/.test(type),
				),
			).toHaveLength(1);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "session.goal_changed",
					data: expect.objectContaining(
						ending === "paused"
							? {
									goal: expect.objectContaining({ condition: OBJECTIVE }),
									pausedReason: "Paused",
								}
							: {
									goal: null,
									ended: "cleared",
									endedGoal: expect.objectContaining({ condition: OBJECTIVE }),
								},
					),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it(
		"closes at the successor deadline after native completion without a successor",
		async () => {
			const successorTimeoutMs = 2_000;
			const { fixture, browser, id } = await start(
				"goal-successor-timeout",
				"goal-successor-timeout",
				{ successorTimeoutMs },
			);
			const completion = fixtureRows("goal-successor-timeout").find(
				({ message }) => message?.method === "turn/completed",
			);
			if (typeof completion?.["at"] !== "number")
				throw new Error("Missing native completion timestamp");
			writeFileSync(gatePath, String(completion["at"] - 1));
			const sending = goalSend(browser, id);
			await vi.waitFor(
				() =>
					expect(
						rows<TraceRow>(capturePath).some(
							({ message }) => message?.method === "thread/tokenUsage/updated",
						),
					).toBe(true),
				{ timeout: TIMEOUT },
			);
			// Start timing after startup/output, immediately before native completion.
			const completionCursor = browser.frames.length;
			const began = Date.now();
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await browser.waitForTurnEnd(id, completionCursor, 15_000);
			await sending;
			expect(Date.now() - began).toBeGreaterThanOrEqual(successorTimeoutMs);
			const { turns, events } = snapshot(fixture, id);
			expect(turns).toEqual([{ state: "completed" }]);
			expect(
				events.filter(({ type }) => type === "turn.completed"),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it(
		"keeps a paused goal across a Codex restart; Resume sends status active only",
		async () => {
			const { fixture, browser, id } = await start(
				"goal-restart",
				"goal-paused",
			);
			const sending = goalSend(browser, id);
			await vi.waitFor(
				() =>
					expect(
						requests().filter(
							({ message }) => message?.method === "thread/goal/set",
						),
					).toHaveLength(1),
				{ timeout: TIMEOUT },
			);
			expect(
				await Effect.runPromise(
					browser.rpc.PauseGoal({ sessionId: id, commandId: randomUUID() }),
				),
			).toEqual({ ok: true });
			await sending;
			// test-waits-allow polling: Codex's paused goal reaches only the store.
			await vi.waitFor(
				() =>
					expect(
						snapshot(fixture, id).events.filter(
							({ type, data }) =>
								type === "session.goal_changed" &&
								(data as { pausedReason?: string }).pausedReason === "Paused",
						).length,
					).toBeGreaterThan(0),
				{ timeout: TIMEOUT },
			);
			const identity = JSON.parse(
				readFileSync(
					join(fixture.configDir, "codex", "stores", id, "session.json"),
					"utf8",
				),
			) as { threadId: string };
			for (const pid of fixture.remainingRunnerPids())
				process.kill(pid, "SIGKILL");
			// test-waits-allow polling: the runners' exit is seen only as their pids.
			await vi.waitFor(
				() => expect(fixture.remainingRunnerPids()).toEqual([]),
				{ timeout: TIMEOUT },
			);
			// Codex keeps the paused goal on its thread; thread/resume brings it back, and Resume
			// sets it active with no objective. With no live thread, it goes once the next launch
			// is accepted (8.5).
			writeTrace(resumeTrace(fixtureRows("goal-chain"), identity.threadId));
			expect(
				await Effect.runPromise(
					browser.rpc.ResumeGoal({ sessionId: id, commandId: randomUUID() }),
				),
			).toEqual({ ok: true });
			const reply = await browser.send(id, "Continue.", TIMEOUT);
			expect(reply.chunks.join("")).toBe(
				"Hello from the mock model.".repeat(3),
			);
			// The restarted app-server's capture starts at its own launch.
			expect(
				requests().some(({ message }) => message?.method === "thread/resume"),
			).toBe(true);
			const sets = requests().filter(
				({ message }) => message?.method === "thread/goal/set",
			);
			expect(sets.map(({ message }) => message?.params)).toEqual([
				{ threadId: identity.threadId, status: "active", origin: "user" },
			]);
			expect(snapshot(fixture, id).turns).toEqual([
				{ state: "completed" },
				{ state: "completed" },
			]);
		},
		TIMEOUT * 2,
	);

	it(
		"steers the executing successor and places its echoed input once",
		async () => {
			const { fixture, browser, id } = await start("goal-steer", "goal-chain");
			const trace = fixtureRows("goal-chain");
			const starts = trace.filter(
				({ message }) => message?.method === "turn/started",
			);
			const second = starts[1]?.message?.params;
			if (!second) throw new Error("Missing successor");
			const successor = (second["turn"] as { id: string }).id;
			const at = trace.findIndex(
				({ message }) =>
					message?.method === "item/agentMessage/delta" &&
					message.params?.["turnId"] === successor,
			);
			const inputId = "goal-successor-steer";
			const content = [
				{
					type: "text",
					text: "Use the successor instruction",
					text_elements: [],
				},
			];
			trace.splice(
				at + 1,
				0,
				{
					dir: "out",
					at: 0,
					message: {
						id: 900,
						method: "turn/steer",
						params: {
							threadId: second["threadId"],
							expectedTurnId: successor,
							clientUserMessageId: inputId,
							input: content,
						},
					},
				},
				{
					dir: "in",
					at: 0,
					message: { id: 900, result: { turnId: successor } },
				},
				{
					dir: "in",
					at: 0,
					message: {
						method: "item/completed",
						params: {
							threadId: second["threadId"],
							turnId: successor,
							item: {
								type: "userMessage",
								id: inputId,
								clientId: inputId,
								content,
							},
						},
					},
				},
			);
			writeTrace(trace);
			const sending = goalSend(browser, id);
			await vi.waitFor(
				() =>
					expect(
						snapshot(fixture, id).events.filter(
							({ type }) => type === "text.delta",
						).length,
					).toBeGreaterThanOrEqual(4),
				{ timeout: TIMEOUT },
			);
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "steer",
					text: "Use the successor instruction",
				}),
			);
			await sending;
			expect(
				requests().find(({ message }) => message?.method === "turn/steer")
					?.message?.params?.["expectedTurnId"],
			).toBe(successor);
			expect(
				(await browser.history(id)).filter(
					(message) =>
						message.role === "user" &&
						JSON.stringify(message).includes("Use the successor instruction"),
				),
			).toHaveLength(1);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "turn.completed",
				),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it(
		"declines a steer between native turns and requeues it after the goal",
		async () => {
			const { fixture, browser, id } = await start(
				"goal-gap-steer",
				"goal-chain",
			);
			const trace = fixtureRows("goal-chain");
			const nativeEnd = trace.findIndex(
				({ message }) => message?.method === "turn/completed",
			);
			const params = trace[nativeEnd]?.message?.params;
			const threadId = params?.["threadId"];
			const turnId = (params?.["turn"] as { id: string }).id;
			trace.splice(nativeEnd, 0, {
				dir: "in",
				at: 0,
				message: {
					method: "item/reasoning/summaryPartAdded",
					params: {
						threadId,
						turnId,
						itemId: "gap-open",
						summaryIndex: 0,
					},
				},
			});
			let held = false;
			const gated = trace
				.filter(({ dir }) => dir !== "exit")
				.map((row) => {
					const at = held ? 1 : 0;
					if (row.message?.method === "turn/completed") held = true;
					return { ...row, at };
				});
			const next = fixtureRows("basic");
			const nextAt = next.findIndex(
				({ message }) => message?.method === "turn/start",
			);
			const original = next[nextAt]?.message?.params?.["threadId"];
			if (typeof original !== "string" || typeof threadId !== "string")
				throw new Error("Missing native thread");
			const tail = JSON.parse(
				JSON.stringify(next.slice(nextAt)).replaceAll(original, threadId),
			) as TraceRow[];
			writeTrace([...gated, ...tail.map((row) => ({ ...row, at: 1 }))]);
			writeFileSync(gatePath, "0");
			const sending = goalSend(browser, id);
			try {
				await vi.waitFor(
					() =>
						expect(snapshot(fixture, id).events).toContainEqual(
							expect.objectContaining({
								type: "thinking.end",
								data: expect.objectContaining({
									partId: expect.stringContaining("gap-open"),
								}),
							}),
						),
					{ timeout: TIMEOUT },
				);
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId: id,
						originId: browser.originId,
						inputId: "gap-steer",
						delivery: "steer",
						text: "Run this after the goal",
					}),
				);
				await vi.waitFor(
					() =>
						expect(snapshot(fixture, id).events).toContainEqual(
							expect.objectContaining({
								type: "input.requeued",
								data: expect.objectContaining({ inputId: "gap-steer" }),
							}),
						),
					{ timeout: TIMEOUT },
				);
			} finally {
				writeFileSync(gatePath, "1");
				await sending;
			}
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "completed" },
						{ state: "completed" },
					]),
				{ timeout: TIMEOUT },
			);
			expect(
				requests().filter(({ message }) => message?.method === "turn/steer"),
			).toEqual([]);
			expect(
				requests().filter(({ message }) => message?.method === "turn/start"),
			).toHaveLength(2);
			expect(
				(await browser.history(id)).filter(
					(message) =>
						message.role === "user" &&
						JSON.stringify(message).includes("Run this after the goal"),
				),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it(
		"clears an idle native goal without starting a model turn",
		async () => {
			const { fixture, browser, id } = await start(
				"goal-idle-controls",
				"goal-chain",
			);
			const trace = fixtureRows("goal-chain");
			const threadId = trace.find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			const exit = trace.findIndex(({ dir }) => dir === "exit");
			writeTrace([
				...trace.slice(0, exit),
				{
					dir: "out",
					at: 0,
					message: {
						id: 901,
						method: "thread/goal/clear",
						params: { threadId, origin: "user" },
					},
				},
				{
					dir: "in",
					at: 0,
					message: { method: "thread/goal/cleared", params: { threadId } },
				},
				{ dir: "in", at: 0, message: { id: 901, result: { cleared: true } } },
				...trace.slice(exit),
			]);
			await goalSend(browser, id);
			const commandId = randomUUID();
			expect(
				await Effect.runPromise(
					browser.rpc.ClearGoal({ sessionId: id, commandId }),
				),
			).toEqual({ ok: true });
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "session.goal_changed",
							data: expect.objectContaining({
								goal: null,
								ended: "cleared",
								replyTo: commandId,
							}),
						}),
					),
				{ timeout: TIMEOUT },
			);
			const { events, turns } = snapshot(fixture, id);
			expect(turns).toEqual([{ state: "completed" }]);
			expect(events.filter(({ type }) => type === "turn.error")).toEqual([]);
			expect(
				requests().filter(({ message }) => message?.method === "turn/start"),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it.each([
		["blocked", "Goal blocked", "blocked"],
		["usageLimited", "Goal hit a usage limit", "usage"],
		["budgetLimited", "Goal reached its token budget", "budget"],
	])(
		"a Pause Codex answers %s ends Limited and closes the turn",
		async (status, reason, limit) => {
			const { fixture, browser, id } = await start(
				`goal-${status}`,
				"goal-paused",
			);
			let activated = false;
			writeTrace(
				fixtureRows("goal-paused").map((row) => {
					// Codex answers the Pause, in its reply and its notifications, with a limit.
					const goal = (row.message?.params?.["goal"] ??
						(row.message?.result as { goal?: unknown } | undefined)?.goal) as
						| { status: string }
						| undefined;
					if (goal?.status === "active") activated = true;
					else if (goal && activated) goal.status = status;
					return row;
				}),
			);
			const sending = goalSend(browser, id);
			await vi.waitFor(
				() =>
					expect(
						requests().filter(
							({ message }) => message?.method === "thread/goal/set",
						),
					).toHaveLength(1),
				{ timeout: TIMEOUT },
			);
			const commandId = randomUUID();
			expect(
				await Effect.runPromise(
					browser.rpc.PauseGoal({ sessionId: id, commandId }),
				),
			).toEqual({ ok: true });
			await sending;
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "session.goal_changed",
					data: expect.objectContaining({
						replyTo: commandId,
						pausedReason: reason,
						limit,
						goal: expect.objectContaining({ condition: OBJECTIVE }),
					}),
				}),
			);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "turn.completed",
				),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it(
		"reads Limited when an unanswered Pause's re-read finds the token budget reached",
		async () => {
			const { fixture, browser, id } = await start(
				"goal-unconfirmed-limited",
				"goal-paused",
				{ nativeCommandMs: 3_000 },
			);
			writeTrace(unansweredPause("budgetLimited"));
			const sending = goalSend(browser, id);
			await vi.waitFor(
				() =>
					expect(
						requests().filter(
							({ message }) => message?.method === "thread/goal/set",
						),
					).toHaveLength(1),
				{ timeout: TIMEOUT },
			);
			expect(
				await Effect.runPromise(
					browser.rpc.PauseGoal({ sessionId: id, commandId: randomUUID() }),
				),
			).toEqual({ ok: true });
			await sending;
			// test-waits-allow polling: the re-read's answer reaches only the store and the row.
			await vi.waitFor(
				async () => {
					expect(
						snapshot(fixture, id)
							.events.filter(({ type }) => type === "session.goal_changed")
							.at(-1)?.data,
					).toMatchObject({
						goal: expect.objectContaining({ condition: OBJECTIVE }),
						pausedReason: "Goal reached its token budget",
						limit: "budget",
					});
					expect(await goalPhase(fixture, id)).toBeUndefined();
				},
				{ timeout: TIMEOUT },
			);
			expect(
				requests().filter(
					({ message }) => message?.method === "thread/goal/get",
				),
			).toHaveLength(1);
			expect(snapshot(fixture, id).turns).toEqual([{ state: "completed" }]);
		},
		TIMEOUT * 2,
	);

	it(
		"shows Pause not confirmed when the re-read finds the goal still active, and Retry sends once",
		async () => {
			const { fixture, browser, id } = await start(
				"goal-unconfirmed-retry",
				"goal-paused",
				{ nativeCommandMs: 3_000, successorTimeoutMs: 1_000 },
			);
			writeTrace(unansweredPause("active", true));
			const sending = goalSend(browser, id);
			await vi.waitFor(
				() =>
					expect(
						requests().filter(
							({ message }) => message?.method === "thread/goal/set",
						),
					).toHaveLength(1),
				{ timeout: TIMEOUT },
			);
			expect(
				await Effect.runPromise(
					browser.rpc.PauseGoal({ sessionId: id, commandId: randomUUID() }),
				),
			).toEqual({ ok: true });
			await sending;
			// test-waits-allow polling: the deadline and its re-read reach only the row.
			await vi.waitFor(
				async () =>
					expect(await goalPhase(fixture, id)).toEqual({
						tag: "Pending",
						action: { kind: "pause" },
						send: "Unconfirmed",
					}),
				{ timeout: TIMEOUT },
			);
			const pauses = () =>
				requests().filter(
					({ message }) =>
						message?.method === "thread/goal/set" &&
						message.params?.["status"] === "paused",
				);
			expect(pauses()).toHaveLength(1);
			const retry = randomUUID();
			expect(
				await Effect.runPromise(
					browser.rpc.PauseGoal({ sessionId: id, commandId: retry }),
				),
			).toEqual({ ok: true });
			// test-waits-allow polling: the retry's answer reaches only the store and the row.
			await vi.waitFor(
				async () => {
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "session.goal_changed",
							data: expect.objectContaining({
								replyTo: retry,
								pausedReason: "Paused",
							}),
						}),
					);
					expect(await goalPhase(fixture, id)).toBeUndefined();
				},
				{ timeout: TIMEOUT },
			);
			expect(pauses()).toHaveLength(2);
			expect(
				requests().filter(
					({ message }) => message?.method === "thread/goal/get",
				),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	// Audit 10: Codex starts the successor before the Pause lands. A wake Run needs no active Run
	// (CONTRACT.md 960, 8.3), so the successor stays in the held Run, shows, and ends it once.
	it(
		"a successor that starts before the Pause lands shows in the held Run, which ends once",
		async () => {
			const { fixture, browser, id } = await start("goal-race", "goal-chain");
			const trace = fixtureRows("goal-chain");
			const [, successor] = trace.flatMap((row, index) =>
				row.message?.method === "turn/started" ? [index] : [],
			);
			const notified = trace.findIndex(
				(row, index) =>
					index > (successor ?? 0) &&
					row.message?.method === "thread/goal/updated",
			);
			const end = trace.findIndex(
				(row, index) =>
					index > notified && row.message?.method === "turn/completed",
			);
			const params = trace[notified]?.message?.params;
			const goal = { ...(params?.["goal"] as object), status: "paused" };
			const threadId = params?.["threadId"];
			if (successor === undefined || notified < 0 || end < 0 || !threadId)
				throw new Error("Missing recorded successor");
			writeTrace([
				...trace.slice(0, successor + 1),
				{
					dir: "out",
					at: 0,
					message: {
						id: 5,
						method: "thread/goal/set",
						params: { threadId, status: "paused", origin: "user" },
					},
				},
				{ dir: "in", at: 0, message: { id: 5, result: { goal } } },
				{
					dir: "in",
					at: 0,
					message: {
						method: "thread/goal/updated",
						params: { threadId, turnId: null, goal },
					},
				},
				...trace.slice(successor + 1, notified),
				...trace.slice(notified + 1, end + 1),
				...trace.filter(({ dir }) => dir === "exit"),
			]);
			const sending = goalSend(browser, id);
			await vi.waitFor(
				() =>
					expect(
						rows<TraceRow>(capturePath).filter(
							({ message }) => message?.method === "turn/started",
						),
					).toHaveLength(2),
				{ timeout: TIMEOUT },
			);
			expect(
				await Effect.runPromise(
					browser.rpc.PauseGoal({ sessionId: id, commandId: randomUUID() }),
				),
			).toEqual({ ok: true });
			const reply = await sending;
			expect(reply.chunks.join("")).toBe(
				"Hello from the mock model.".repeat(2),
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([{ state: "completed" }]),
				{ timeout: TIMEOUT },
			);
			const { events } = snapshot(fixture, id);
			expect(
				events.filter(({ type }) =>
					/^turn\.(completed|interrupted|error)$/.test(type),
				),
			).toHaveLength(1);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "session.goal_changed",
					data: expect.objectContaining({
						pausedReason: "Paused",
						turnFinishing: true,
					}),
				}),
			);
			// Audit 33: once the turn has ended, the goal no longer says Codex is finishing it.
			const goalChanges = events.filter(
				({ type }) => type === "session.goal_changed",
			);
			expect(goalChanges.at(-1)?.data).not.toHaveProperty("turnFinishing");
			expect(await goalPhase(fixture, id)).toBeUndefined();
			expect(
				requests().filter(({ message }) => message?.method === "turn/start"),
			).toHaveLength(1);
			// The goal-stuck check counts continuations, not the reply and notification each change has:
			// the first native turn's, and none for the successor the Pause ended.
			const { checks } = await Effect.runPromise(
				browser.rpc.GetGoalDetails({ sessionId: id }),
			);
			expect(goalChanges.length).toBeGreaterThan(checks.length);
			expect(checks.map(({ iteration }) => iteration)).toEqual([1]);
		},
		TIMEOUT * 2,
	);

	it(
		"Stop interrupts the executing successor and leaves the goal active",
		async () => {
			const { fixture, browser, id } = await start(
				"goal-interrupt",
				"goal-interrupt",
			);
			await browser.followSession(id);
			const sending = goalSend(browser, id).catch(() => undefined);
			await vi.waitFor(
				() => {
					const text = snapshot(fixture, id).events.filter(
						({ type }) => type === "text.delta",
					);
					expect(text.length).toBeGreaterThan(3);
				},
				{ timeout: TIMEOUT },
			);
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "interrupted" },
					]),
				{ timeout: TIMEOUT },
			);
			await sending;
			const successor = fixtureRows("goal-interrupt").filter(
				({ message }) => message?.method === "turn/started",
			)[1]?.message?.params?.["turn"];
			// Stop is not a goal action (CONTRACT.md 2057, 2970): the only goal setters are the
			// goal set's own, and the goal stays active.
			expect(
				requests()
					.filter(({ message }) => message?.method === "thread/goal/set")
					.map(({ message }) => message?.params?.["status"]),
			).toEqual(["active"]);
			expect(
				requests().find(({ message }) => message?.method === "turn/interrupt")
					?.message?.params?.["turnId"],
			).toBe((successor as { id: string }).id);
			const { events } = snapshot(fixture, id);
			expect(
				events.filter(({ type }) => type === "turn.interrupted"),
			).toHaveLength(1);
			const goal = events
				.filter(({ type }) => type === "session.goal_changed")
				.at(-1)?.data;
			expect(goal).toMatchObject({
				goal: expect.objectContaining({ condition: OBJECTIVE }),
			});
			expect(goal).not.toHaveProperty("pausedReason");
		},
		TIMEOUT * 2,
	);
});
