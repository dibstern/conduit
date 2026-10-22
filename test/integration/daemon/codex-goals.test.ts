// Failure modes: settling each native turn, losing successor output, stale Stop
// targets, goal commands becoming prompts, missing goal facts/details, and a
// successor gap holding the conduit turn forever. Every replay must be consumed.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
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

	async function start(name: string, source = name) {
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
			writeFileSync(
				join(artifactRoot, "evidence.json"),
				JSON.stringify(
					{ result: task.result?.state, reports, process: fixture.proof() },
					null,
					2,
				),
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
			const reply = await browser.send(id, `$goal ${OBJECTIVE}`, TIMEOUT);
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
		"a goal %s notification closes the held turn",
		async (ending) => {
			const { fixture, browser, id } = await start(`goal-${ending}`);
			const sending = browser.send(id, `/goal ${OBJECTIVE}`, TIMEOUT);
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
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId: randomUUID(),
					delivery: "steer",
					text: `/goal ${ending === "paused" ? "pause" : "clear"}`,
				}),
			);
			await sending;
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "completed" },
						{ state: "completed" },
					]),
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
		"closes 30 seconds after native completion without a successor",
		async () => {
			const { fixture, browser, id } = await start("goal-successor-timeout");
			const began = Date.now();
			await browser.send(id, `/goal ${OBJECTIVE}`, TIMEOUT);
			expect(Date.now() - began).toBeGreaterThanOrEqual(30_000);
			const { turns, events } = snapshot(fixture, id);
			expect(turns).toEqual([{ state: "completed" }]);
			expect(
				events.filter(({ type }) => type === "turn.completed"),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it(
		"seeds a restarted runner with the dispatched paused goal and resumes on Continue",
		async () => {
			const { fixture, browser, id } = await start(
				"goal-restart",
				"goal-paused",
			);
			const sending = browser.send(id, `/goal ${OBJECTIVE}`, TIMEOUT);
			await vi.waitFor(
				() =>
					expect(
						requests().filter(
							({ message }) => message?.method === "thread/goal/set",
						),
					).toHaveLength(2),
				{ timeout: TIMEOUT },
			);
			const pauseInputId = randomUUID();
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId: pauseInputId,
					delivery: "steer",
					text: "/goal pause",
				}),
			);
			await sending;
			// A terminal can precede the control command's durable acknowledgement.
			await vi.waitFor(
				() => {
					const db = new Database(fixture.daemonStorePath(), {
						readonly: true,
					});
					try {
						expect(
							db
								.prepare(
									"SELECT status FROM provider_command_outbox WHERE session_id = ? AND command_id = ?",
								)
								.get(id, pauseInputId),
						).toEqual({ status: "completed" });
					} finally {
						db.close();
					}
				},
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
			await vi.waitFor(
				() => expect(fixture.remainingRunnerPids()).toEqual([]),
				{ timeout: TIMEOUT },
			);
			const trace = resumeTrace(fixtureRows("goal-chain"), identity.threadId);
			const setAt = trace.findIndex(
				({ message }) => message?.method === "thread/goal/set",
			);
			const turnAt = trace.findIndex(
				({ message }) => message?.method === "turn/start",
			);
			// The persisted native goal exists already. No new objective is sent.
			writeTrace([...trace.slice(0, setAt), ...trace.slice(turnAt)]);
			const reply = await browser.send(id, "Continue.", TIMEOUT);
			expect(reply.chunks.join("")).toBe(
				"Hello from the mock model.".repeat(3),
			);
			expect(
				requests().filter(
					({ message }) => message?.method === "thread/goal/set",
				),
			).toHaveLength(1);
			expect(
				requests().find(({ message }) => message?.method === "thread/goal/set")
					?.message?.params,
			).toMatchObject({
				threadId: identity.threadId,
				status: "active",
				origin: "user",
			});
			expect(snapshot(fixture, id).turns).toEqual([
				{ state: "completed" },
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
			const sending = browser.send(id, `/goal ${OBJECTIVE}`, TIMEOUT);
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
			const sending = browser.send(id, `/goal ${OBJECTIVE}`, TIMEOUT);
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
		"reads and clears an idle native goal without starting a model turn",
		async () => {
			const { fixture, browser, id } = await start(
				"goal-idle-controls",
				"goal-chain",
			);
			const trace = fixtureRows("goal-chain");
			const setAt = trace.findIndex(
				({ message }) => message?.method === "thread/goal/set",
			);
			const goal = trace.find(
				({ message }) =>
					message?.method === "thread/goal/updated" &&
					(message.params?.["goal"] as { status: string }).status === "active",
			)?.message?.params?.["goal"];
			const threadId = trace[setAt]?.message?.params?.["threadId"];
			writeTrace([
				...trace.slice(0, setAt),
				{
					dir: "out",
					at: 0,
					message: { id: 900, method: "thread/goal/get", params: { threadId } },
				},
				{ dir: "in", at: 0, message: { id: 900, result: { goal } } },
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
				{ dir: "exit", at: 0, code: 0, signal: null },
			]);
			await browser.send(id, "/goal", TIMEOUT);
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "session.goal_changed",
					data: expect.objectContaining({
						goal: expect.objectContaining({ condition: OBJECTIVE }),
					}),
				}),
			);
			await browser.send(id, "/goal clear", TIMEOUT);
			const { events, turns } = snapshot(fixture, id);
			expect(turns).toEqual([{ state: "completed" }, { state: "completed" }]);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "session.goal_changed",
					data: expect.objectContaining({ goal: null, ended: "cleared" }),
				}),
			);
			expect(events.filter(({ type }) => type === "turn.error")).toEqual([]);
			expect(
				requests().filter(({ message }) => message?.method === "turn/start"),
			).toEqual([]);
		},
		TIMEOUT * 2,
	);

	it.each([
		["blocked", "Blocked"],
		["usageLimited", "Usage limit reached"],
		["budgetLimited", "Goal budget reached"],
	])(
		"maps native %s to a paused goal and closes the turn",
		async (status, reason) => {
			const { fixture, browser, id } = await start(
				`goal-${status}`,
				"goal-paused",
			);
			let activated = false;
			writeTrace(
				fixtureRows("goal-paused").map((row) => {
					const goal = row.message?.params?.["goal"] as
						| { status: string }
						| undefined;
					if (row.message?.method === "thread/goal/updated" && goal) {
						if (goal.status === "active") activated = true;
						else if (activated) goal.status = status;
					}
					return row;
				}),
			);
			const sending = browser.send(id, `/goal ${OBJECTIVE}`, TIMEOUT);
			await vi.waitFor(
				() =>
					expect(
						requests().filter(
							({ message }) => message?.method === "thread/goal/set",
						),
					).toHaveLength(2),
				{ timeout: TIMEOUT },
			);
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId: randomUUID(),
					delivery: "steer",
					text: "/goal pause",
				}),
			);
			await sending;
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "session.goal_changed",
					data: expect.objectContaining({
						pausedReason: reason,
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

	it.each(["normal", "pause-error"])(
		"Stop pauses the goal and interrupts its executing successor (%s)",
		async (pauseResult) => {
			const { fixture, browser, id } = await start(
				`goal-stop-${pauseResult}`,
				"goal-stop",
			);
			if (pauseResult === "pause-error") {
				const trace = fixtureRows("goal-stop");
				const request = [...trace]
					.reverse()
					.find(
						({ message }) => message?.method === "thread/goal/set",
					)?.message;
				if (!request || request.id === undefined)
					throw new Error("Missing goal pause");
				const response = trace.find(
					({ dir, message }) =>
						dir === "in" && message?.id === request.id && message?.result,
				);
				if (!response) throw new Error("Missing goal pause response");
				response.message = {
					id: request.id,
					error: { code: -32603, message: "Fixture goal pause failure" },
				};
				writeTrace(trace);
			}
			await browser.followSession(id);
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId: randomUUID(),
					delivery: "queue",
					text: `/goal ${OBJECTIVE}`,
				}),
			);
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
			const trace = fixtureRows("goal-stop");
			const nativeStarts = trace.filter(
				({ message }) => message?.method === "turn/started",
			);
			const successor = nativeStarts[1]?.message?.params?.["turn"];
			expect(
				requests().find(({ message }) => message?.method === "turn/interrupt")
					?.message?.params?.["turnId"],
			).toBe((successor as { id: string }).id);
			const { events } = snapshot(fixture, id);
			expect(
				events.filter(({ type }) => type === "turn.interrupted"),
			).toHaveLength(1);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "session.goal_changed",
					data: expect.objectContaining({ pausedReason: "Interrupted" }),
				}),
			);
		},
		TIMEOUT * 2,
	);
});
