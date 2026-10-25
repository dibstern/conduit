// Failure modes: child notifications contaminate the parent transcript, spawn
// finishes the card early, control calls create duplicate children, child
// approvals have no writable owner, Stop leaves children running, or restart
// loses the child link and exposes a resumable input path. Held command output
// must survive reloads, nested forks and source deletion without run ownership.
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
	type StoredEvent,
	signedInCodexDiscoveryTrace,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const MODEL = "gpt-6.1-sol";
const CHILD_THREAD = "fixture-subagent";
const CHILD_TEXT = "Child inspected the patch.";
const CHILD_THINKING = "I will inspect the patch.";
const CHILD_OUTPUT = "child tool output\n";
const APPROVAL = "item/commandExecution/requestApproval";
const QUESTION = "item/tool/requestUserInput";

function sessions(fixture: ProcessHarness) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare<
				[],
				{
					id: string;
					parent_id: string | null;
					provider: string;
					provider_sid: string | null;
					status: string;
				}
			>(
				"SELECT id, parent_id, provider, provider_sid, status FROM sessions WHERE project_id = 'process-test'",
			)
			.all();
	} finally {
		db.close();
	}
}

function content(events: readonly StoredEvent[], type: string) {
	const userMessages = new Set(
		events
			.filter(
				({ type, data }) =>
					type === "message.created" && data["role"] === "user",
			)
			.map(({ data }) => data["messageId"]),
	);
	return events
		.filter(
			(event) =>
				event.type === type && !userMessages.has(event.data["messageId"]),
		)
		.map(({ data }) => String(data["text"] ?? ""))
		.join("");
}

describe("Codex read-only children through the daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	let artifactRoot = "";
	let tracePath = "";
	let capturePath = "";
	let reportPath = "";
	let gatePath = "";
	let evidence: Record<string, unknown> = {};

	function writeTrace(trace: TraceRow[]) {
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}

	async function start(
		scenario: string,
		source = scenario,
		derive?: (trace: TraceRow[]) => TraceRow[],
	) {
		artifactRoot = resolve(
			`test-results/codex-subagents/${process.pid}/${scenario}`,
		);
		mkdirSync(artifactRoot, { recursive: true });
		capturePath = join(artifactRoot, "capture.jsonl");
		reportPath = join(artifactRoot, "trace-report.jsonl");
		writeFileSync(capturePath, "");
		writeFileSync(reportPath, "");
		evidence = { scenario, source };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		tracePath = join(harness.root, "codex-subagents.jsonl");
		gatePath = join(harness.root, "codex-subagents-gate");
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
				const found = (await browser.instances()).instances.filter(
					({ driver }) => driver === "codex",
				);
				expect(found).toHaveLength(1);
				return found[0];
			},
			{ timeout: TIMEOUT, interval: 100 },
		);
		if (!account) throw new Error("Missing signed-in Codex account");
		expect(await codexModels(browser, account.id)).toContainEqual(
			expect.objectContaining({ id: MODEL, provider: "codex" }),
		);
		sessionId = await browser.createSession(scenario, account.id, "codex", {
			modelId: MODEL,
			contextWindow: "",
			permissionMode: "ask",
		});
		const trace = fixtureRows(source).map((row) => ({ ...row, at: 0 }));
		expect(trace.length).toBeGreaterThan(0);
		writeTrace(derive ? derive(trace) : trace);
		writeFileSync(gatePath, "0");
		return {
			fixture,
			browser,
			id: sessionId,
			accountId: account.id,
			restartOptions,
		};
	}

	async function submit(browser: ProcessBrowser, id: string) {
		const cursor = browser.frames.length;
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: id,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "Inspect the patch with a child agent.",
			}),
		);
		return cursor;
	}

	async function waitChild(fixture: ProcessHarness, id: string) {
		return vi.waitFor(
			() => {
				const children = sessions(fixture).filter(
					(row) => row.parent_id === id,
				);
				expect(children).toHaveLength(1);
				const child = children[0];
				if (!child) throw new Error("Missing materialized child session");
				return child;
			},
			{ timeout: TIMEOUT, interval: 100 },
		);
	}

	async function waitTurn(
		fixture: ProcessHarness,
		id: string,
		state: "completed" | "interrupted",
	) {
		await vi.waitFor(
			() => expect(snapshot(fixture, id).turns).toEqual([{ state }]),
			{ timeout: TIMEOUT, interval: 100 },
		);
	}

	async function taskCard(browser: ProcessBrowser, id: string) {
		const cards = (await browser.history(id))
			.flatMap(({ parts }) => parts ?? [])
			.filter(({ tool }) => tool === "Task");
		expect(cards).toHaveLength(1);
		return cards[0];
	}

	async function rejectChildInput(browser: ProcessBrowser, childId: string) {
		const inputId = randomUUID();
		await expect(
			Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: childId,
					originId: browser.originId,
					inputId,
					delivery: "queue",
					text: "Cannot resume a native child",
				}),
			),
		).rejects.toThrow("Subagent sessions are read-only");
		if (!harness) throw new Error("Missing daemon harness");
		expect(
			snapshot(harness, childId).events.some(
				({ data }) => data["inputId"] === inputId,
			),
		).toBe(false);
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const fixture = harness;
		const state = sessions(fixture).map((session) => ({
			...session,
			...snapshot(fixture, session.id),
		}));
		const logPath = join(fixture.configDir, "runners.log");
		const runnerLog = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
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
		} finally {
			writeFileSync(
				join(artifactRoot, "events.json"),
				`${JSON.stringify(state, null, 2)}\n`,
			);
			writeFileSync(join(artifactRoot, "runners.log"), runnerLog);
			writeFileSync(
				join(artifactRoot, "evidence.json"),
				`${JSON.stringify({ ...evidence, result: task.result?.state, process: fixture.proof() }, null, 2)}\n`,
			);
			harness = undefined;
			sessionId = undefined;
		}
	});

	it(
		"streams one linked read-only child transcript and completes its card with the child result",
		async () => {
			const { fixture, browser, id, accountId } = await start(
				"spawn",
				"subagent-spawn",
				(trace) => {
					const spawnCompleted = trace.find(({ message }) => {
						const item = message?.params?.["item"] as
							| { id?: string }
							| undefined;
						return (
							message?.method === "item/completed" &&
							item?.id === "fixture-subagent-spawn"
						);
					});
					if (!spawnCompleted) throw new Error("Missing spawn completion");
					const earlyChild = trace.filter((row) => row !== spawnCompleted);
					const liveAt = earlyChild.findIndex(
						({ message }) =>
							message?.method === "item/agentMessage/delta" &&
							message.params?.["threadId"] === CHILD_THREAD,
					);
					expect(liveAt).toBeGreaterThan(0);
					// Native child items can arrive before the spawn call completes.
					const reordered = [
						...earlyChild.slice(0, liveAt + 1),
						spawnCompleted,
						...earlyChild.slice(liveAt + 1),
					];
					const outputAt = reordered.findIndex(
						({ message }) =>
							message?.method === "item/commandExecution/outputDelta" &&
							message.params?.["threadId"] === CHILD_THREAD,
					);
					expect(outputAt).toBeGreaterThan(0);
					expect(outputAt).toBeLessThan(liveAt);
					return reordered.map((row, index) => ({
						...row,
						at: index > liveAt ? 2 : index > outputAt ? 1 : 0,
					}));
				},
			);
			await submit(browser, id);
			const child = await waitChild(fixture, id);
			await vi.waitFor(
				() =>
					expect(
						sessions(fixture).find((row) => row.id === child.id),
					).toMatchObject({
						parent_id: id,
						provider: accountId,
						provider_sid: CHILD_THREAD,
						status: "busy",
					}),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await vi.waitFor(
				() =>
					expect(
						snapshot(fixture, child.id).events.some(
							({ type, data }) =>
								type === "tool.running" &&
								(data["metadata"] as Record<string, unknown> | undefined)?.[
									"output"
								] === CHILD_OUTPUT,
						),
					).toBe(true),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const liveEvents = snapshot(fixture, child.id).events;
			expect(
				liveEvents.filter(({ type }) =>
					["tool.completed", "turn.completed"].includes(type),
				),
			).toEqual([]);
			const liveRunId = liveEvents.find(({ type }) => type === "run.started")
				?.metadata["runId"];
			expect(liveRunId).toEqual(expect.any(String));
			const liveDb = new Database(fixture.daemonStorePath(), {
				readonly: true,
			});
			try {
				expect(
					liveDb
						.prepare(
							"SELECT status FROM provider_runs WHERE id = ? AND session_id = ?",
						)
						.get(liveRunId, child.id),
				).toEqual({ status: "running" });
				expect(
					liveDb
						.prepare(
							"SELECT provider FROM events WHERE session_id = ? AND type = 'run.started' AND json_extract(metadata, '$.runId') = ? ORDER BY sequence LIMIT 1",
						)
						.get(child.id, liveRunId),
				).toEqual({ provider: "codex" });
				expect(
					liveDb
						.prepare(
							"SELECT command_id FROM provider_command_outbox WHERE session_id = ?",
						)
						.all(child.id),
				).toEqual([]);
			} finally {
				liveDb.close();
			}
			let forkSource = child.id;
			const liveMessage = liveEvents.find(({ type }) => type === "tool.running")
				?.data["messageId"];
			if (typeof liveMessage !== "string")
				throw new Error("Missing live child tool message");
			let forkMessage = liveMessage;
			const inheritedHistories = [];
			for (let generation = 0; generation < 2; generation++) {
				const forked = await fixture.requestRpc({
					_tag: "ForkSession",
					originId: browser.originId,
					sessionId: forkSource,
					messageId: forkMessage,
				});
				if (!forked.sessionId) throw new Error("Missing fork session id");
				const history = await browser.history(forked.sessionId);
				const toolMessage = history.find(({ parts }) =>
					parts?.some((part) => part.tool === "Bash"),
				);
				if (!toolMessage) throw new Error("Missing inherited tool message");
				const reopened = await fixture.connect(forked.sessionId);
				inheritedHistories.push({
					sessionId: forked.sessionId,
					history,
					reloadedHistory: await reopened.history(forked.sessionId),
				});
				const forkDb = new Database(fixture.daemonStorePath(), {
					readonly: true,
				});
				try {
					expect(
						forkDb
							.prepare(
								"SELECT run_id FROM turns WHERE session_id = ? AND run_id IS NOT NULL",
							)
							.all(forked.sessionId),
					).toEqual([]);
				} finally {
					forkDb.close();
				}
				forkSource = forked.sessionId;
				forkMessage = toolMessage.id;
			}
			evidence["inheritedLiveOutput"] = inheritedHistories;
			for (const { history, reloadedHistory } of inheritedHistories)
				for (const rows of [history, reloadedHistory])
					expect(rows.flatMap(({ parts }) => parts ?? [])).toContainEqual(
						expect.objectContaining({
							tool: "Bash",
							state: expect.objectContaining({
								status: "running",
								metadata: { output: CHILD_OUTPUT },
							}),
						}),
					);
			const [middleFork, survivingFork] = inheritedHistories;
			if (!middleFork || !survivingFork)
				throw new Error("Missing nested fork history");
			await fixture.requestRpc({
				_tag: "DeleteSession",
				originId: browser.originId,
				sessionId: middleFork.sessionId,
			});
			expect(
				sessions(fixture).some(({ id }) => id === middleFork.sessionId),
			).toBe(false);
			const afterSourceDelete = await browser.history(survivingFork.sessionId);
			const survivingReload = await fixture.connect(survivingFork.sessionId);
			const reloadedAfterSourceDelete = await survivingReload.history(
				survivingFork.sessionId,
			);
			evidence["inheritedAfterSourceDelete"] = {
				afterSourceDelete,
				reloadedAfterSourceDelete,
			};
			for (const history of [afterSourceDelete, reloadedAfterSourceDelete])
				expect(history.flatMap(({ parts }) => parts ?? [])).toContainEqual(
					expect.objectContaining({
						tool: "Bash",
						state: expect.objectContaining({
							status: "running",
							metadata: { output: CHILD_OUTPUT },
						}),
					}),
				);
			const liveHistory = await browser.history(child.id);
			const reloaded = await fixture.connect(child.id);
			const reloadedHistory = await reloaded.history(child.id);
			for (const history of [liveHistory, reloadedHistory])
				expect(history.flatMap(({ parts }) => parts ?? [])).toContainEqual(
					expect.objectContaining({
						tool: "Bash",
						state: expect.objectContaining({
							status: "running",
							metadata: { output: CHILD_OUTPUT },
						}),
					}),
				);
			evidence["childLiveOutput"] = { liveRunId, liveHistory, reloadedHistory };
			writeFileSync(gatePath, "1");
			await vi.waitFor(
				() =>
					expect(
						content(snapshot(fixture, child.id).events, "text.delta"),
					).toBe(CHILD_TEXT),
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect((await taskCard(browser, id))?.state).toMatchObject({
				status: "running",
				metadata: { childSessionId: child.id },
			});
			expect(snapshot(fixture, id).turns).toEqual([{ state: "running" }]);
			writeFileSync(gatePath, "2");
			await waitTurn(fixture, id, "completed");
			await waitTurn(fixture, child.id, "completed");
			const childEvents = snapshot(fixture, child.id).events;
			expect(content(childEvents, "text.delta")).toBe(CHILD_TEXT);
			expect(content(childEvents, "thinking.delta")).toBe(CHILD_THINKING);
			expect(
				childEvents.filter(({ type }) => type === "tool.started"),
			).toMatchObject([{ data: { toolName: "Bash" } }]);
			expect(
				childEvents.filter(({ type }) => type === "tool.completed"),
			).toMatchObject([{ data: { result: CHILD_OUTPUT } }]);
			expect(
				childEvents.filter(({ type }) => type === "turn.completed"),
			).toHaveLength(1);
			const parentRunId = snapshot(fixture, id).events.find(
				({ type }) => type === "run.started",
			)?.metadata["runId"];
			const childRunId = childEvents.find(
				({ type }) => type === "turn.completed",
			)?.metadata["runId"];
			expect(parentRunId).toEqual(expect.any(String));
			expect(childRunId).toEqual(expect.any(String));
			expect(childRunId).not.toBe(parentRunId);
			expect(childEvents).toContainEqual(
				expect.objectContaining({
					type: "run.started",
					metadata: expect.objectContaining({ runId: childRunId }),
					data: expect.objectContaining({ requestedRunId: childRunId }),
				}),
			);
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare<[string], { id: string; status: string }>(
							"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
						)
						.all(child.id),
				).toEqual([{ id: childRunId, status: "completed" }]);
				expect(
					db
						.prepare<[string], { state: string; run_id: string | null }>(
							"SELECT state, run_id FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
						)
						.all(child.id),
				).toEqual([{ state: "completed", run_id: childRunId }]);
			} finally {
				db.close();
			}
			const childHistory = await browser.history(child.id);
			expect(childHistory).toContainEqual(
				expect.objectContaining({ role: "user" }),
			);
			const childParts = childHistory.flatMap(({ parts }) => parts ?? []);
			expect(
				childParts
					.filter(({ type }) => type === "text")
					.map(({ text }) => text),
			).toEqual(["Inspect the patch", CHILD_TEXT]);
			expect(childParts).toContainEqual(
				expect.objectContaining({ type: "thinking", text: CHILD_THINKING }),
			);
			expect(childParts).toContainEqual(
				expect.objectContaining({
					tool: "Bash",
					state: expect.objectContaining({
						output: { _tag: "whole", text: CHILD_OUTPUT },
					}),
				}),
			);
			const parentEvents = snapshot(fixture, id).events;
			expect(content(parentEvents, "text.delta")).not.toContain(CHILD_TEXT);
			expect(content(parentEvents, "thinking.delta")).not.toContain(
				CHILD_THINKING,
			);
			expect(
				parentEvents.filter(({ type }) => type === "tool.started"),
			).toMatchObject([{ data: { toolName: "Task" } }]);
			expect((await taskCard(browser, id))?.state).toMatchObject({
				status: "completed",
				metadata: { childSessionId: child.id, subagentResult: CHILD_TEXT },
				output: { text: CHILD_TEXT },
			});
			expect(
				sessions(fixture).find(({ id: candidate }) => candidate === child.id)
					?.status,
			).toBe("idle");
			await rejectChildInput(browser, child.id);
			// 8dda48ab emitted Codex envelopes without runId. Migration 0078
			// leaves closed history unowned; its frozen tool output still belongs
			// to the original Codex event channel, even after source deletion.
			const legacyDb = new Database(fixture.daemonStorePath());
			try {
				legacyDb
					.prepare(
						"UPDATE events SET metadata = json_remove(metadata, '$.runId') WHERE session_id = ?",
					)
					.run(child.id);
				legacyDb
					.prepare(
						"UPDATE turns SET run_id = NULL WHERE session_id = ? AND state = 'completed'",
					)
					.run(child.id);
				expect(
					legacyDb
						.prepare<[string], { count: number }>(
							"SELECT count(*) AS count FROM events WHERE session_id = ? AND json_extract(metadata, '$.runId') IS NOT NULL",
						)
						.get(child.id)?.count,
				).toBe(0);
				expect(
					legacyDb
						.prepare<[string], { count: number }>(
							"SELECT count(*) AS count FROM turns WHERE session_id = ? AND run_id IS NOT NULL",
						)
						.get(child.id)?.count,
				).toBe(0);
			} finally {
				legacyDb.close();
			}
			const legacyHistory = await browser.history(survivingFork.sessionId);
			const legacyReload = await fixture.connect(survivingFork.sessionId);
			const reloadedLegacyHistory = await legacyReload.history(
				survivingFork.sessionId,
			);
			evidence["inheritedLegacyOutput"] = {
				legacyHistory,
				reloadedLegacyHistory,
			};
			for (const history of [legacyHistory, reloadedLegacyHistory])
				expect(history.flatMap(({ parts }) => parts ?? [])).toContainEqual(
					expect.objectContaining({
						tool: "Bash",
						state: expect.objectContaining({
							status: "running",
							metadata: { output: CHILD_OUTPUT },
						}),
					}),
				);
		},
		TIMEOUT * 2,
	);

	it(
		"wait, send-input and close update the existing child's task card",
		async () => {
			const { fixture, browser, id } = await start(
				"wait",
				"subagent-wait",
				(trace) => {
					const waitAt = trace.findIndex(({ message }) => {
						const item = message?.params?.["item"] as
							| { tool?: string }
							| undefined;
						return message?.method === "item/started" && item?.tool === "wait";
					});
					expect(waitAt).toBeGreaterThan(0);
					return trace.map((row, index) => ({
						...row,
						at: index > waitAt ? 1 : 0,
					}));
				},
			);
			await submit(browser, id);
			const child = await waitChild(fixture, id);
			await vi.waitFor(
				() =>
					expect(
						rows<TraceRow>(capturePath).some(({ message }) => {
							const item = message?.params?.["item"] as
								| { tool?: string }
								| undefined;
							return (
								message?.method === "item/started" && item?.tool === "wait"
							);
						}),
					).toBe(true),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await vi.waitFor(
				async () =>
					expect((await taskCard(browser, id))?.state).toMatchObject({
						status: "running",
						metadata: { childSessionId: child.id },
					}),
				{ timeout: TIMEOUT, interval: 100 },
			);
			writeFileSync(gatePath, "1");
			await waitTurn(fixture, id, "completed");
			expect(
				sessions(fixture).filter(({ parent_id }) => parent_id === id),
			).toHaveLength(1);
			expect((await taskCard(browser, id))?.state).toMatchObject({
				status: "completed",
				metadata: { childSessionId: child.id },
				output: { text: CHILD_TEXT },
			});
		},
		TIMEOUT * 2,
	);

	it(
		"holds a child approval that arrives before the spawn notifications register its thread",
		async () => {
			const { fixture, browser, id } = await start(
				"early-approval",
				"subagent-approval",
				(trace) => {
					const request = trace.find(
						({ message }) => message?.method === APPROVAL,
					);
					const spawnAt = trace.findIndex(({ message }) => {
						const item = message?.params?.["item"] as
							| { tool?: string }
							| undefined;
						return (
							message?.method === "item/started" && item?.tool === "spawnAgent"
						);
					});
					if (!request || spawnAt < 0)
						throw new Error("Missing approval or spawn");
					return [
						...trace.slice(0, spawnAt),
						request,
						...trace
							.slice(spawnAt)
							.filter((row) => row !== request)
							.map((row) => ({ ...row, at: 1 })),
					];
				},
			);
			const cursor = await submit(browser, id);
			await vi.waitFor(
				() =>
					expect(
						rows<TraceRow>(capturePath).some(
							({ dir, message }) =>
								dir === "in" && message?.method === APPROVAL,
						),
					).toBe(true),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await browser.history(id);
			expect(
				rows<TraceRow>(capturePath).filter(
					({ dir, message }) =>
						dir === "out" && message?.id === "fixture-child-approval",
				),
			).toEqual([]);
			writeFileSync(gatePath, "1");
			const card = await browser.waitFor(
				(message) =>
					message["type"] === "permission_pending" &&
					message["sessionId"] === id,
				cursor,
				TIMEOUT,
			);
			await browser.answerApproval(card, "allow");
			const child = await waitChild(fixture, id);
			await waitTurn(fixture, id, "completed");
			await waitTurn(fixture, child.id, "completed");
			expect(
				rows<TraceRow>(capturePath)
					.filter(
						({ dir, message }) =>
							dir === "out" && message?.id === "fixture-child-approval",
					)
					.map(({ message }) => message?.result),
			).toEqual([{ decision: "accept" }]);
		},
		TIMEOUT * 2,
	);

	it.each(["permission", "question"] as const)(
		"routes a child's %s to the parent and answers the child's native request",
		async (kind) => {
			const { fixture, browser, id } = await start(
				`child-${kind}`,
				"subagent-approval",
				(trace) => {
					if (kind === "permission") return trace;
					const request = fixtureRows("question-blocking").find(
						({ message }) => message?.method === QUESTION,
					)?.message;
					if (!request?.params)
						throw new Error("Missing blocking question payload");
					return trace.map((row) => {
						if (row.message?.method === APPROVAL) {
							return {
								...row,
								message: {
									...row.message,
									method: QUESTION,
									params: {
										...request.params,
										threadId: CHILD_THREAD,
										turnId: row.message.params?.["turnId"],
										itemId: row.message.params?.["itemId"],
									},
								},
							};
						}
						if (row.dir === "out" && row.message?.result?.["decision"]) {
							return {
								...row,
								message: {
									...row.message,
									result: {
										answers: {
											plan: { answers: ["Safe"] },
											secret: { answers: ["fixture-code"] },
										},
									},
								},
							};
						}
						return row;
					});
				},
			);
			const cursor = await submit(browser, id);
			const child = await waitChild(fixture, id);
			const card = await browser.waitFor(
				(message) =>
					message["type"] === `${kind}_pending` && message["sessionId"] === id,
				cursor,
				TIMEOUT,
			);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === `${kind}.asked`,
				),
			).toHaveLength(1);
			expect(
				snapshot(fixture, child.id).events.filter(
					({ type }) => type === `${kind}.asked`,
				),
			).toEqual([]);
			if (kind === "permission") {
				expect(card).toMatchObject({
					toolName: "Bash",
					toolInput: { command: "printf child" },
				});
				await browser.answerApproval(card, "allow");
			} else {
				expect(card["questions"]).toMatchObject([
					{ question: "Which route?" },
					{ question: "Access code?" },
				]);
				await Effect.runPromise(
					browser.rpc.AnswerQuestion({
						projectSlug: "process-test",
						originId: browser.originId,
						commandId: randomUUID(),
						toolId: String(card["toolId"]),
						answers: { "0": "Safe", "1": "fixture-code" },
					}),
				);
			}
			await waitTurn(fixture, id, "completed");
			await waitTurn(fixture, child.id, "completed");
			const reply = rows<TraceRow>(capturePath).filter(
				({ dir, message }) =>
					dir === "out" &&
					message?.id === "fixture-child-approval" &&
					!message.method &&
					message.result !== undefined,
			);
			expect(reply).toHaveLength(1);
			expect(reply[0]?.message?.result).toEqual(
				kind === "permission"
					? { decision: "accept" }
					: {
							answers: {
								plan: { answers: ["Safe"] },
								secret: { answers: ["fixture-code"] },
							},
						},
			);
		},
		TIMEOUT * 2,
	);

	it(
		"streams a background child after its parent ends and creates children on later parent turns",
		async () => {
			const secondThread = `${CHILD_THREAD}-followup`;
			const { fixture, browser, id } = await start(
				"background-followup",
				"subagent-spawn",
				(trace) => {
					const parentThread = trace.find(
						({ message }) => message?.method === "turn/start",
					)?.message?.params?.["threadId"];
					const parentTurn = trace.find(
						({ message }) =>
							message?.method === "turn/started" &&
							message.params?.["threadId"] === parentThread,
					)?.message?.params?.["turn"] as { id: string } | undefined;
					const childCompletion = trace.findIndex(({ message }) => {
						const item = message?.params?.["item"] as
							| { id?: string }
							| undefined;
						return (
							message?.method === "item/completed" &&
							item?.id === "fixture-subagent-command"
						);
					});
					const parentAnswer = trace.findIndex(({ message }) => {
						const item = message?.params?.["item"] as
							| { type?: string }
							| undefined;
						return (
							message?.method === "item/started" &&
							message.params?.["threadId"] === parentThread &&
							item?.type === "reasoning"
						);
					});
					const secondTurnStart = trace.findIndex(
						({ message }) => message?.method === "turn/start",
					);
					if (!parentTurn || childCompletion < 0 || parentAnswer < 0)
						throw new Error("Missing child completion or parent answer");
					const secondTurn = trace
						.slice(secondTurnStart)
						.filter(({ message }) => {
							const thread = message?.params?.["thread"] as
								| { id?: string }
								| undefined;
							return !(
								message?.method === "thread/started" &&
								thread?.id === parentThread
							);
						})
						.map((row) => {
							const next = JSON.parse(
								JSON.stringify(row)
									.replaceAll(parentTurn.id, "fixture-parent-followup-turn")
									.replaceAll(CHILD_THREAD, secondThread),
							) as TraceRow;
							if (next.message?.id === 3) next.message.id = 4;
							return { ...next, at: 1 };
						});
					return [
						...trace.slice(0, childCompletion),
						...trace.slice(parentAnswer).filter(({ dir }) => dir !== "exit"),
						...trace
							.slice(childCompletion, parentAnswer)
							.map((row) => ({ ...row, at: 1 })),
						...secondTurn,
					];
				},
			);
			await submit(browser, id);
			const first = await waitChild(fixture, id);
			await waitTurn(fixture, id, "completed");
			expect(
				sessions(fixture).find(({ id: candidate }) => candidate === first.id)
					?.status,
			).toBe("busy");
			expect((await taskCard(browser, id))?.state).toMatchObject({
				status: "running",
				metadata: { childSessionId: first.id },
			});
			writeFileSync(gatePath, "1");
			await waitTurn(fixture, first.id, "completed");
			expect(content(snapshot(fixture, first.id).events, "text.delta")).toBe(
				CHILD_TEXT,
			);
			expect((await taskCard(browser, id))?.state).toMatchObject({
				status: "completed",
				output: { text: CHILD_TEXT },
			});
			await submit(browser, id);
			const second = await vi.waitFor(
				() => {
					const children = sessions(fixture).filter(
						({ parent_id }) => parent_id === id,
					);
					expect(children).toHaveLength(2);
					const child = children.find(
						({ provider_sid }) => provider_sid === secondThread,
					);
					if (!child) throw new Error("Missing later turn's child");
					return child;
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			await waitTurn(fixture, second.id, "completed");
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "completed" },
						{ state: "completed" },
					]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(content(snapshot(fixture, second.id).events, "text.delta")).toBe(
				CHILD_TEXT,
			);
			const cards = (await browser.history(id))
				.flatMap(({ parts }) => parts ?? [])
				.filter(({ tool }) => tool === "Task");
			expect(cards).toHaveLength(2);
			expect(cards).toMatchObject([
				{
					state: {
						status: "completed",
						metadata: { childSessionId: first.id },
					},
				},
				{
					state: {
						status: "completed",
						metadata: { childSessionId: second.id },
					},
				},
			]);
		},
		TIMEOUT * 3,
	);

	it(
		"reopens the same child's card and parent approval routing for a later native child turn",
		async () => {
			const { fixture, browser, id } = await start(
				"repeat-child-turn",
				"subagent-spawn",
				(trace) => {
					const parentTurn = trace.find(
						({ message }) =>
							message?.method === "turn/started" &&
							message.params?.["threadId"] !== CHILD_THREAD,
					)?.message?.params?.["turn"] as { id: string } | undefined;
					const followup = fixtureRows("subagent-approval");
					const startAt = followup.findIndex(
						({ message }) => message?.method === "turn/start",
					);
					if (!parentTurn || startAt < 0)
						throw new Error("Missing parent native turn");
					const second = followup
						.slice(startAt)
						.filter(({ message }) => message?.method !== "thread/started")
						.map((row) => {
							const next = JSON.parse(
								JSON.stringify(row)
									.replaceAll(parentTurn.id, "fixture-parent-repeat-turn")
									.replaceAll(
										"fixture-subagent-turn",
										"fixture-subagent-repeat-turn",
									)
									.replaceAll(
										"fixture-subagent-user",
										"fixture-subagent-repeat-user",
									)
									.replaceAll(
										"fixture-subagent-spawn",
										"fixture-subagent-send-input",
									),
							) as TraceRow;
							if (next.message?.id === 3) next.message.id = 4;
							const item = next.message?.params?.["item"] as
								| { type?: string; tool?: string }
								| undefined;
							if (
								item?.type === "collabAgentToolCall" &&
								item.tool === "spawnAgent"
							)
								item.tool = "sendInput";
							return next;
						});
					const approvalAt = second.findIndex(
						({ message }) => message?.method === APPROVAL,
					);
					expect(approvalAt).toBeGreaterThan(0);
					return [
						...trace.filter(({ dir }) => dir !== "exit"),
						...second.map((row, index) => ({
							...row,
							at: index < approvalAt ? 1 : 2,
						})),
					];
				},
			);
			await submit(browser, id);
			const child = await waitChild(fixture, id);
			await waitTurn(fixture, id, "completed");
			await waitTurn(fixture, child.id, "completed");
			expect((await taskCard(browser, id))?.state).toMatchObject({
				status: "completed",
				metadata: { childSessionId: child.id },
			});
			writeFileSync(gatePath, "1");
			const cursor = await submit(browser, id);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, child.id).turns).toEqual([
						{ state: "completed" },
						{ state: "running" },
					]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const running = await taskCard(browser, id);
			expect(running?.state).toMatchObject({
				status: "running",
				metadata: { childSessionId: child.id },
			});
			const metadata = running?.state?.["metadata"] as
				| Record<string, unknown>
				| undefined;
			expect(["completed", "failed", "stopped", "killed"]).not.toContain(
				metadata?.["outcome"],
			);
			expect(
				sessions(fixture).find(({ id: candidate }) => candidate === child.id)
					?.status,
			).toBe("busy");
			writeFileSync(gatePath, "2");
			const card = await browser.waitFor(
				(message) =>
					message["type"] === "permission_pending" &&
					message["sessionId"] === id,
				cursor,
				TIMEOUT,
			);
			await browser.answerApproval(card, "allow");
			await vi.waitFor(
				() => {
					for (const owner of [id, child.id])
						expect(snapshot(fixture, owner).turns).toEqual([
							{ state: "completed" },
							{ state: "completed" },
						]);
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(
				sessions(fixture).filter(({ parent_id }) => parent_id === id),
			).toHaveLength(1);
			await vi.waitFor(
				async () => {
					expect((await taskCard(browser, id))?.state).toMatchObject({
						status: "completed",
						metadata: { childSessionId: child.id },
						output: { text: CHILD_TEXT },
					});
					expect(
						content(snapshot(fixture, child.id).events, "text.delta"),
					).toBe(`${CHILD_TEXT}${CHILD_TEXT}`);
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(
				rows<TraceRow>(capturePath)
					.filter(
						({ dir, message }) =>
							dir === "out" && message?.id === "fixture-child-approval",
					)
					.map(({ message }) => message?.result),
			).toEqual([{ decision: "accept" }]);
		},
		TIMEOUT * 3,
	);

	it(
		"completes a grandchild's original card after its parent child resumes a new native turn",
		async () => {
			const grandchildThread = "fixture-grandchild";
			const grandchildResult = "Grandchild reviewed the detail.";
			const { fixture, browser, id } = await start(
				"nested-owner-generation",
				"subagent-spawn",
				(trace) => {
					const turnStart = trace.findIndex(
						({ message }) => message?.method === "turn/start",
					);
					const parentThread = trace[turnStart]?.message?.params?.["threadId"];
					const parentTurn = trace.find(
						({ message }) =>
							message?.method === "turn/started" &&
							message.params?.["threadId"] === parentThread,
					)?.message?.params?.["turn"] as { id: string } | undefined;
					const childThreadStart = trace.findIndex(({ message }) => {
						const thread = message?.params?.["thread"] as
							| { id?: string }
							| undefined;
						return (
							message?.method === "thread/started" &&
							thread?.id === CHILD_THREAD
						);
					});
					const spawn = trace.find(({ message }) => {
						const item = message?.params?.["item"] as
							| { tool?: string }
							| undefined;
						return (
							message?.method === "item/started" && item?.tool === "spawnAgent"
						);
					});
					const childCompletion = trace.findIndex(({ message }) => {
						const item = message?.params?.["item"] as
							| { id?: string }
							| undefined;
						return (
							message?.method === "item/completed" &&
							item?.id === "fixture-subagent-command"
						);
					});
					const parentAnswer = trace.findIndex(({ message }) => {
						const item = message?.params?.["item"] as
							| { type?: string }
							| undefined;
						return (
							message?.method === "item/started" &&
							message.params?.["threadId"] === parentThread &&
							item?.type === "reasoning"
						);
					});
					if (
						!parentTurn ||
						!spawn ||
						childThreadStart < 0 ||
						childCompletion < 0 ||
						parentAnswer < 0
					)
						throw new Error("Missing nested lifecycle source rows");
					const nested = (row: TraceRow): TraceRow => {
						const next = JSON.parse(
							JSON.stringify(row)
								.replaceAll(CHILD_THREAD, grandchildThread)
								.replaceAll(CHILD_TEXT, grandchildResult)
								.replaceAll("Inspect the patch", "Review a nested detail"),
						) as TraceRow;
						const params = next.message?.params;
						if (params && params["threadId"] === parentThread) {
							params["threadId"] = CHILD_THREAD;
							params["turnId"] = "fixture-subagent-turn";
							const item = params["item"] as
								| Record<string, unknown>
								| undefined;
							if (item?.["type"] === "collabAgentToolCall")
								item["senderThreadId"] = CHILD_THREAD;
						}
						if (next.message?.method === "thread/started" && params) {
							const thread = params["thread"] as Record<string, unknown>;
							thread["parentThreadId"] = CHILD_THREAD;
							thread["source"] = {
								subAgent: {
									thread_spawn: { parent_thread_id: CHILD_THREAD, depth: 2 },
								},
							};
						}
						return next;
					};
					const second = trace
						.slice(turnStart)
						.filter(({ message }) => message?.method !== "thread/started")
						.map((row) => {
							const next = JSON.parse(
								JSON.stringify(row)
									.replaceAll(
										parentTurn.id,
										"fixture-nested-parent-followup-turn",
									)
									.replaceAll(
										"fixture-subagent-turn",
										"fixture-nested-child-followup-turn",
									)
									.replaceAll(
										"fixture-subagent-user",
										"fixture-nested-child-followup-user",
									)
									.replaceAll(
										"fixture-subagent-spawn",
										"fixture-nested-child-send-input",
									),
							) as TraceRow;
							if (next.message?.id === 3) next.message.id = 4;
							const item = next.message?.params?.["item"] as
								| { type?: string; tool?: string }
								| undefined;
							if (
								item?.type === "collabAgentToolCall" &&
								item.tool === "spawnAgent"
							)
								item.tool = "sendInput";
							return next;
						});
					const liveAt = second.findIndex(
						({ message }) =>
							message?.method === "item/agentMessage/delta" &&
							message.params?.["threadId"] === CHILD_THREAD,
					);
					expect(liveAt).toBeGreaterThan(0);
					return [
						...trace.slice(0, childCompletion),
						...[spawn, ...trace.slice(childThreadStart, childCompletion)].map(
							nested,
						),
						...trace.slice(childCompletion).filter(({ dir }) => dir !== "exit"),
						...second.slice(0, liveAt + 1).map((row) => ({ ...row, at: 1 })),
						...trace
							.slice(childCompletion, parentAnswer)
							.map(nested)
							.map((row) => ({ ...row, at: 2 })),
						...second.slice(liveAt + 1).map((row) => ({ ...row, at: 3 })),
					];
				},
			);
			await submit(browser, id);
			const child = await waitChild(fixture, id);
			const grandchild = await waitChild(fixture, child.id);
			await waitTurn(fixture, id, "completed");
			await waitTurn(fixture, child.id, "completed");
			expect(grandchild.provider_sid).toBe(grandchildThread);
			const original = (await browser.history(child.id)).find(({ parts }) =>
				parts?.some(({ tool }) => tool === "Task"),
			);
			if (!original)
				throw new Error("Missing original grandchild card message");
			expect((await taskCard(browser, child.id))?.state).toMatchObject({
				status: "running",
				metadata: { childSessionId: grandchild.id },
			});
			writeFileSync(gatePath, "1");
			await submit(browser, id);
			await vi.waitFor(
				() => {
					expect(snapshot(fixture, child.id).turns).toEqual([
						{ state: "completed" },
						{ state: "running" },
					]);
					expect(
						content(snapshot(fixture, child.id).events, "text.delta"),
					).toBe(`${CHILD_TEXT}${CHILD_TEXT}`);
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			const current = (await browser.history(child.id))
				.filter(({ role }) => role === "assistant")
				.at(-1);
			if (!current || current.id === original.id)
				throw new Error("Missing resumed child message");
			writeFileSync(gatePath, "2");
			await waitTurn(fixture, grandchild.id, "completed");
			await vi.waitFor(
				async () => {
					const messages = await browser.history(child.id);
					expect(
						messages.find(({ id: messageId }) => messageId === original.id)
							?.parts,
					).toContainEqual(
						expect.objectContaining({
							tool: "Task",
							state: expect.objectContaining({
								status: "completed",
								metadata: expect.objectContaining({
									childSessionId: grandchild.id,
								}),
								output: expect.objectContaining({ text: grandchildResult }),
							}),
						}),
					);
					const newer = messages.find(
						({ id: messageId }) => messageId === current.id,
					);
					expect(newer?.parts?.some(({ tool }) => tool === "Task")).toBe(false);
					expect(
						newer?.parts
							?.filter(({ type }) => type === "text")
							.map(({ text }) => text)
							.join(""),
					).toBe(CHILD_TEXT);
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			writeFileSync(gatePath, "3");
			await vi.waitFor(
				() => {
					for (const owner of [id, child.id])
						expect(snapshot(fixture, owner).turns).toEqual([
							{ state: "completed" },
							{ state: "completed" },
						]);
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
		},
		TIMEOUT * 3,
	);

	it(
		"Stop interrupts the parent and its running child",
		async () => {
			const { fixture, browser, id } = await start("stop", "subagent-stop");
			await submit(browser, id);
			const child = await waitChild(fixture, id);
			await vi.waitFor(
				() =>
					expect(
						content(snapshot(fixture, child.id).events, "thinking.delta"),
					).toBe(CHILD_THINKING),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
			);
			await waitTurn(fixture, id, "interrupted");
			await waitTurn(fixture, child.id, "interrupted");
			expect(
				sessions(fixture).find(({ id: candidate }) => candidate === child.id)
					?.status,
			).toBe("idle");
			for (const owner of [id, child.id]) {
				expect(
					snapshot(fixture, owner).events.filter(
						({ type }) => type === "turn.interrupted",
					),
				).toHaveLength(1);
			}
			const outgoing = rows<TraceRow>(capturePath).filter(
				({ dir }) => dir === "out",
			);
			const parentThread = outgoing.find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			expect(
				outgoing
					.filter(({ message }) => message?.method === "turn/interrupt")
					.map(({ message }) => message?.params?.["threadId"]),
			).toEqual([parentThread, CHILD_THREAD]);
		},
		TIMEOUT * 2,
	);

	it(
		"keeps the child transcript, card link and read-only input after daemon restart",
		async () => {
			const { fixture, browser, id, accountId, restartOptions } = await start(
				"restart",
				"subagent-spawn",
			);
			await submit(browser, id);
			const child = await waitChild(fixture, id);
			await waitTurn(fixture, id, "completed");
			await waitTurn(fixture, child.id, "completed");
			const transcript = await browser.history(child.id);
			const linked = await taskCard(browser, id);
			await fixture.kill();
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			writeTrace(signedInCodexDiscoveryTrace());
			await fixture.restart(restartOptions);
			const restarted = await fixture.connect(id);
			await codexModels(restarted, accountId);
			expect(
				sessions(fixture).filter(({ parent_id }) => parent_id === id),
			).toHaveLength(1);
			expect((await waitChild(fixture, id)).id).toBe(child.id);
			expect(await restarted.history(child.id)).toEqual(transcript);
			expect(await taskCard(restarted, id)).toEqual(linked);
			await rejectChildInput(restarted, child.id);
		},
		TIMEOUT * 3,
	);
});
