// Failure modes: mode settings leak between turns, approvals lose file paths or
// decisions, an unanswered callback blocks notifications, restart loses it, or
// async questions block, expire at turn end, or answer through native callbacks.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROVIDER_DRIVERS } from "../../../src/lib/contracts/provider-instance.js";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import type { RunnerMessage } from "../../../src/lib/provider/runner/runner-protocol.js";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import type { SessionPermissionMode } from "../../../src/lib/shared-types.js";
import {
	codexModels,
	fixtureRows,
	rows,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const MODEL = "gpt-6.1-sol";
const TEXT = "Hello from the mock model.";
const APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
const PERMISSIONS = "item/permissions/requestApproval";
const QUESTION = "item/tool/requestUserInput";
const ELICITATION = "mcpServer/elicitation/request";
const ASYNC_ANSWERS = { "0": "Safe, Scenic", "1": "Ship it." };
const ASYNC_TEXT = "Which route?\nSafe, Scenic\n\nAnything else?\nShip it.";

function discoveryTrace() {
	const trace = fixtureRows("model-list");
	const result = trace.find((row) => row.message?.result?.["account"] === null)
		?.message?.result;
	if (!result) throw new Error("No recorded account/read response");
	result["account"] = {
		type: "chatgpt",
		email: "codex-replay@example.test",
		planType: "plus",
	};
	result["requiresOpenaiAuth"] = true;
	return trace;
}

function serverRequest(trace: TraceRow[], method: string) {
	const request = trace.find(
		(row) => row.dir === "in" && row.message?.method === method,
	)?.message;
	if (!request?.params || request["id"] === undefined)
		throw new Error(`No recorded ${method} request`);
	return { id: request["id"], params: request.params };
}

function sessionRows(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const result: Record<string, Record<string, unknown>[]> = {};
		const tables = db
			.prepare<[], { name: string }>(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
			)
			.all();
		for (const { name } of tables) {
			const columns = db
				.prepare<[string], { name: string }>(
					"SELECT name FROM pragma_table_info(?)",
				)
				.all(name)
				.map((column) => column.name);
			const predicate =
				name === "sessions"
					? "id = ?"
					: columns.includes("session_id")
						? "session_id = ?"
						: columns.includes("message_id")
							? "message_id IN (SELECT id FROM messages WHERE session_id = ?)"
							: name === "input_drafts"
								? "draft_key LIKE ? OR promoted_session_id = ?"
								: name === "claude_runner_cursors"
									? "1 = 1"
									: undefined;
			if (!predicate) continue;
			const quote = (identifier: string) =>
				`"${identifier.replaceAll('"', '""')}"`;
			// This isolated fixture has one runner. Its reply cache has no session_id.
			const parameters =
				name === "claude_runner_cursors"
					? []
					: name === "input_drafts"
						? [`%${sessionId}%`, sessionId]
						: [sessionId];
			result[name] = db
				.prepare<string[], Record<string, unknown>>(
					`SELECT ${columns.map(quote).join(", ")} FROM ${quote(name)} WHERE ${predicate}`,
				)
				.all(...parameters);
		}
		return result;
	} finally {
		db.close();
	}
}

describe("Codex interactions through the real daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	let artifactRoot = "";
	let tracePath = "";
	let capturePath = "";
	let reportPath = "";
	let gatePath = "";
	let evidence: Record<string, unknown> = {};
	let proxy: Awaited<ReturnType<typeof interceptAnswer>> | undefined;

	// Failure modes: lose resolution output after native delivery, or restart with
	// an accepted answer that never reached the runner. Gate wire events, not time.
	async function interceptAnswer(
		fixture: ProcessHarness,
		direction: "command" | "output",
	) {
		const [runner] = discoverRunners(fixture.projectDir, fixture.configDir);
		expect(runner).toBeDefined();
		if (!runner) return undefined;
		const upstreamPath = `${runner.socketPath}u`;
		renameSync(runner.socketPath, upstreamPath);
		let signalIntercepted!: () => void;
		const intercepted = new Promise<void>((resolve) => {
			signalIntercepted = resolve;
		});
		const sockets = new Set<Socket>();
		let blocking = true;
		const server = createServer((downstream) => {
			const upstream = createConnection(upstreamPath);
			for (const socket of [downstream, upstream]) {
				sockets.add(socket);
				socket.on("error", () => socket.destroy());
				socket.on("close", () => {
					sockets.delete(socket);
					downstream.destroy();
					upstream.destroy();
				});
			}
			for (const [source, target, lane] of [
				[downstream, upstream, "command"],
				[upstream, downstream, "output"],
			] as const) {
				let held = false;
				// readline re-emits its input's errors; a daemon killed mid-write resets the socket.
				const lines = createInterface({ input: source });
				lines.on("error", () => source.destroy());
				lines.on("line", (line) => {
					const message: RunnerMessage = JSON.parse(line);
					if (
						blocking &&
						lane === direction &&
						((message.type === "command" &&
							message.command.type === "resolve-question") ||
							(message.type === "output" &&
								message.output.type === "resolve-question"))
					) {
						held = true;
						signalIntercepted();
					}
					if (!held) target.write(`${line}\n`);
				});
			}
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(runner.socketPath, resolve);
		});
		return {
			intercepted,
			reconnect() {
				blocking = false;
				for (const socket of sockets) socket.destroy();
			},
			async close() {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			},
		};
	}

	function assertNoSecret(fixture: ProcessHarness, id: string, secret: string) {
		const stored = sessionRows(fixture, id);
		const leakingTables = Object.entries(stored)
			.filter(([, tableRows]) => JSON.stringify(tableRows).includes(secret))
			.map(([name]) => name);
		const spoolLeaks = discoverRunners(
			fixture.projectDir,
			fixture.configDir,
		).map((runner) => {
			const spool = `${runner.socketPath}.spool`;
			return existsSync(spool) && readFileSync(spool, "utf8").includes(secret);
		});
		const logLeaks = [
			join(artifactRoot, "daemon.log"),
			join(fixture.configDir, "runners.log"),
		].map(
			(path) => existsSync(path) && readFileSync(path, "utf8").includes(secret),
		);
		evidence["secretExposure"] = {
			rowCounts: Object.fromEntries(
				Object.entries(stored).map(([name, tableRows]) => [
					name,
					tableRows.length,
				]),
			),
			leakingTables,
			spoolLeaks,
			logLeaks,
		};
		expect(leakingTables).toEqual([]);
		expect(spoolLeaks).not.toContain(true);
		expect(logLeaks).not.toContain(true);
		return stored;
	}

	function writeTrace(trace: TraceRow[]) {
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}

	async function start(
		scenario: string,
		source = scenario,
		mode: SessionPermissionMode = "ask",
		derive?: (trace: TraceRow[]) => TraceRow[],
	) {
		artifactRoot = resolve(`test-results/codex-interactions/${scenario}`);
		mkdirSync(artifactRoot, { recursive: true });
		reportPath = join(artifactRoot, "trace-report.jsonl");
		capturePath = join(artifactRoot, "capture.jsonl");
		writeFileSync(reportPath, "");
		writeFileSync(capturePath, "");
		writeFileSync(join(artifactRoot, "daemon.log"), "");
		evidence = { scenario, source, mode };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			...(scenario === "question-restart" ? { logLevel: "info" as const } : {}),
		});
		tracePath = join(harness.root, "codex-interactions.jsonl");
		gatePath = join(harness.root, "codex-interactions-gate");
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		writeTrace(discoveryTrace());
		const restartOptions = {
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			logFile: join(artifactRoot, "daemon.log"),
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
			permissionMode: mode,
		});
		const trace = fixtureRows(source).map((row) => ({ ...row, at: 0 }));
		writeTrace(derive ? derive(trace) : trace);
		writeFileSync(gatePath, "0");
		return {
			fixture,
			browser,
			id: sessionId,
			accountId: account.id,
			trace,
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
				text: "Continue the recorded interaction.",
			}),
		);
		return cursor;
	}

	async function pending(
		browser: ProcessBrowser,
		id: string,
		kind: "permission" | "question",
	) {
		const cursor = await submit(browser, id);
		return browser.waitFor(
			(message) =>
				message["type"] === `${kind}_pending` && message["sessionId"] === id,
			cursor,
			TIMEOUT,
		);
	}

	async function completed(fixture: ProcessHarness, id: string) {
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual([
					"completed",
				]),
			{ timeout: TIMEOUT, interval: 100 },
		);
		expect(
			snapshot(fixture, id).events.filter(({ type }) => type === "turn.error"),
		).toEqual([]);
	}

	function assertReply(requestId: unknown, result: Record<string, unknown>) {
		const reply = rows<TraceRow>(capturePath).filter(
			(row) =>
				row.dir === "out" &&
				row.message?.["id"] === requestId &&
				!row.message?.method &&
				row.message?.result !== undefined,
		);
		expect(reply).toHaveLength(1);
		expect(reply[0]?.message?.result).toEqual(result);
		evidence["nativeResponse"] = reply[0]?.message;
	}

	function assertTurnMode(
		fixture: ProcessHarness,
		mode: SessionPermissionMode,
	) {
		const request = rows<TraceRow>(capturePath).find(
			({ dir, message }) => dir === "out" && message?.method === "turn/start",
		)?.message?.params;
		const sandbox =
			mode === "full"
				? { type: "dangerFullAccess" }
				: mode === "acceptEdits" || mode === "auto"
					? {
							type: "workspaceWrite",
							writableRoots: [fixture.projectDir],
						}
					: { type: "readOnly" };
		expect(request).toMatchObject({
			approvalPolicy: mode === "ask" ? "untrusted" : "on-request",
			sandboxPolicy: sandbox,
			approvalsReviewer: mode === "auto" ? "auto_review" : "user",
			collaborationMode: {
				mode: mode === "plan" ? "plan" : "default",
				settings: { model: MODEL, reasoning_effort: "low" },
			},
		});
		evidence["turnStart"] = request;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const fixture = harness;
		const state = sessionId ? snapshot(fixture, sessionId) : undefined;
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
			await proxy?.close();
			proxy = undefined;
			writeFileSync(
				join(artifactRoot, "events.json"),
				`${JSON.stringify(state ?? {}, null, 2)}\n`,
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
		"coalesces overlapping secret answers with the same command id",
		async () => {
			const { fixture, browser, id, trace } = await start(
				"secret-overlap",
				"question-blocking",
				"plan",
			);
			const card = await pending(browser, id, "question");
			const command = {
				projectSlug: "process-test",
				originId: browser.originId,
				commandId: randomUUID(),
				toolId: String(card["toolId"]),
				answers: { "0": "Safe", "1": "overlap-secret" },
			};
			const results = await Effect.runPromise(
				Effect.all(
					[
						browser.rpc.AnswerQuestion(command),
						browser.rpc.AnswerQuestion(command),
					],
					{ concurrency: 2 },
				).pipe(Effect.timeout("10 seconds")),
			);
			expect(results).toEqual([{ ok: true }, { ok: true }]);
			await completed(fixture, id);
			assertReply(serverRequest(trace, QUESTION).id, {
				answers: {
					plan: { answers: ["Safe"] },
					secret: { answers: ["overlap-secret"] },
				},
			});
			const stored = assertNoSecret(fixture, id, "overlap-secret");
			expect(
				stored["provider_command_outbox"]?.filter(
					(row) => row["command_id"] === command.commandId,
				),
			).toHaveLength(1);
			evidence["completedCalls"] = results.length;
		},
		TIMEOUT * 2,
	);

	it.each(["output", "command"] as const)(
		"recovers a secret answer interrupted at runner %s",
		async (direction) => {
			const { fixture, browser, id, trace, restartOptions } = await start(
				`secret-interrupted-${direction}`,
				"question-blocking",
				"plan",
			);
			const card = await pending(browser, id, "question");
			await fixture.kill();
			proxy = await interceptAnswer(fixture, direction);
			expect(proxy).toBeDefined();
			writeTrace(discoveryTrace());
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await fixture.restart(restartOptions);
			const after = await fixture.connect(id);
			await after.waitFor(
				(message) => message["type"] === "question_pending",
				0,
				TIMEOUT,
			);
			const commandId = randomUUID();
			const answer = Effect.runPromiseExit(
				after.rpc.AnswerQuestion({
					projectSlug: "process-test",
					originId: after.originId,
					commandId,
					toolId: String(card["toolId"]),
					answers: { "0": "Safe", "1": "interrupted-secret" },
				}),
			);
			await proxy?.intercepted;
			assertNoSecret(fixture, id, "interrupted-secret");
			await fixture.kill();
			await answer;
			proxy?.reconnect();
			await fixture.restart(restartOptions);
			const recovered = await fixture.connect(id);
			if (direction === "command") {
				const expired = await recovered.waitFor(
					(message) => message["type"] === "question_pending",
					0,
					TIMEOUT,
				);
				const expiredState = sessionRows(fixture, id);
				expect(
					expiredState["command_receipts"]?.find(
						(row) => row["command_id"] === commandId,
					),
				).toMatchObject({
					status: "side_effect_failed",
					error_code: "secret_answer_expired",
				});
				expect(
					expiredState["pending_approvals"]?.find(
						(row) => row["id"] === card["toolId"],
					),
				).toMatchObject({ status: "pending" });
				evidence["expiredOutbox"] = expiredState[
					"provider_command_outbox"
				]?.find((row) => row["command_id"] === commandId);
				expect(JSON.stringify(await recovered.history(id))).toContain(
					"re-enter",
				);
				expect(
					await Effect.runPromise(
						recovered.rpc.AnswerQuestion({
							projectSlug: "process-test",
							originId: recovered.originId,
							commandId: randomUUID(),
							toolId: String(expired["toolId"]),
							answers: { "0": "Safe", "1": "interrupted-secret" },
						}),
					),
				).toEqual({ ok: true });
			}
			await completed(fixture, id);
			assertReply(serverRequest(trace, QUESTION).id, {
				answers: {
					plan: { answers: ["Safe"] },
					secret: { answers: ["interrupted-secret"] },
				},
			});
			const stored = assertNoSecret(fixture, id, "interrupted-secret");
			expect(
				stored["pending_approvals"]?.find(
					(row) => row["id"] === card["toolId"],
				),
			).toMatchObject({
				status: "resolved",
				decision: JSON.stringify({ "0": "Safe", "1": "[redacted]" }),
			});
			const resolutions = snapshot(fixture, id).events.filter(
				({ type }) => type === "question.resolved",
			);
			expect(resolutions).toHaveLength(direction === "output" ? 1 : 2);
			evidence["canonicalResolutionCount"] = resolutions.length;
			evidence["expiredCommands"] = direction === "command" ? 1 : 0;
		},
		TIMEOUT * 3,
	);

	it(
		"keeps an async question non-blocking across turn end, daemon restart and runner restart",
		async () => {
			const { fixture, browser, id, accountId, restartOptions } = await start(
				"async-question-restart",
				"async-question",
				"ask",
				(trace) => {
					const questionAt = trace.findIndex(
						({ message }) =>
							message?.method === "item/completed" &&
							(
								message.params?.["item"] as Record<string, unknown> | undefined
							)?.["delivery"] === "async",
					);
					if (questionAt < 0) throw new Error("Missing async question");
					return trace.map((row, index) => ({
						...row,
						at: index > questionAt ? 1 : 0,
					}));
				},
			);
			const card = await pending(browser, id, "question");
			expect(card).toMatchObject({
				delivery: "async",
				questions: [
					{
						header: "",
						question: "Which route?",
						custom: true,
						options: [
							{ label: "Fast" },
							{ label: "Safe" },
							{ label: "Scenic" },
						],
					},
					{ header: "", question: "Anything else?", custom: true, options: [] },
				],
			});
			expect(snapshot(fixture, id).turns).toEqual([{ state: "running" }]);
			const observer = await fixture.connect(id);
			const busy = await observer.waitFor(
				(message) =>
					message["type"] === "session_row" &&
					message["id"] === id &&
					message["status"] === "busy",
				0,
				TIMEOUT,
			);
			expect(busy["attention"]).toBe("working");
			expect(busy["pendingQuestionCount"] ?? 0).toBe(0);
			expect(
				await observer.waitFor(
					(message) =>
						message["type"] === "question_pending" &&
						message["sessionId"] === id,
					0,
					TIMEOUT,
				),
			).toMatchObject({ toolId: card["toolId"], delivery: "async" });
			writeFileSync(gatePath, "1");
			await completed(fixture, id);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "question.resolved",
				),
			).toEqual([]);
			const stored = sessionRows(fixture, id)["pending_approvals"]?.find(
				(row) => row["id"] === card["toolId"],
			);
			expect(stored?.["status"]).toBe("pending");
			const previousPids = fixture.runnerPids();
			await fixture.kill();
			writeTrace(discoveryTrace());
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await fixture.restart(restartOptions);
			expect(fixture.runnerPids()).toEqual(previousPids);
			const afterDaemon = await fixture.connect(id);
			// Complete fresh account discovery before replacing the shared trace for the runner.
			await codexModels(afterDaemon, accountId);
			const recovered = await afterDaemon.waitFor(
				(message) =>
					message["type"] === "question_pending" && message["sessionId"] === id,
				0,
				TIMEOUT,
			);
			expect(recovered).toMatchObject({
				toolId: card["toolId"],
				delivery: "async",
				questions: card["questions"],
			});
			const row = await afterDaemon.waitFor(
				(message) =>
					message["type"] === "session_row" &&
					message["id"] === id &&
					message["status"] === "idle",
				0,
				TIMEOUT,
			);
			expect(row["attention"]).not.toBe("needs-reply");
			expect(row["pendingQuestionCount"] ?? 0).toBe(0);
			const identity = JSON.parse(
				readFileSync(
					join(fixture.configDir, "codex", "stores", id, "session.json"),
					"utf8",
				),
			) as { threadId: string; controllerPid: number };
			process.kill(identity.controllerPid, "SIGKILL");
			await vi.waitFor(
				() => expect(() => process.kill(identity.controllerPid, 0)).toThrow(),
				{ timeout: 10_000 },
			);
			const afterRunner = await fixture.connect(id);
			const durable = await afterRunner.waitFor(
				(message) =>
					message["type"] === "question_pending" && message["sessionId"] === id,
				0,
				TIMEOUT,
			);
			expect(durable).toMatchObject({
				toolId: card["toolId"],
				delivery: "async",
				questions: card["questions"],
			});
			const resume = fixtureRows("resume-after-crash");
			const recordedThread = resume.find(
				({ message }) => message?.method === "thread/resume",
			)?.message?.params?.["threadId"];
			if (typeof recordedThread !== "string")
				throw new Error("Missing recorded resume thread");
			writeTrace(
				JSON.parse(
					JSON.stringify(resume)
						.replaceAll(recordedThread, identity.threadId)
						.replaceAll(
							JSON.stringify("Say hello"),
							JSON.stringify(ASYNC_TEXT),
						),
				) as TraceRow[],
			);
			await Effect.runPromise(
				afterRunner.rpc.AnswerQuestion({
					projectSlug: "process-test",
					originId: afterRunner.originId,
					commandId: randomUUID(),
					toolId: String(durable["toolId"]),
					answers: ASYNC_ANSWERS,
				}),
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "completed" },
						{ state: "completed" },
					]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const current = JSON.parse(
				readFileSync(
					join(fixture.configDir, "codex", "stores", id, "session.json"),
					"utf8",
				),
			) as { threadId: string; controllerPid: number };
			expect(current.threadId).toBe(identity.threadId);
			expect(current.controllerPid).not.toBe(identity.controllerPid);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "question.asked",
				),
			).toHaveLength(1);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "question.resolved",
				),
			).toHaveLength(1);
			evidence["pendingBeforeRestart"] = card;
			evidence["pendingAfterDaemonRestart"] = recovered;
			evidence["pendingAfterRunnerRestart"] = durable;
		},
		TIMEOUT * 4,
	);

	it.each(["mid-turn", "idle"] as const)(
		"answers an async question %s through ordinary user-message delivery",
		async (when) => {
			const { fixture, browser, id } = await start(
				`async-question-answer-${when}`,
				when === "mid-turn"
					? "async-question-answer"
					: "async-question-idle-answer",
				"ask",
				(trace) => {
					if (when !== "mid-turn") return trace;
					const final = [...trace].reverse().find(({ message }) => {
						const item = message?.params?.["item"] as
							| Record<string, unknown>
							| undefined;
						return (
							message?.method === "item/completed" &&
							item?.["type"] === "agentMessage" &&
							item["delivery"] !== "async"
						);
					});
					const item = final?.message?.params?.["item"] as
						| Record<string, unknown>
						| undefined;
					if (!final || !item) throw new Error("Missing final agent message");
					// A correction after the answer forces a snapshot that must preserve its summary.
					item["text"] = "Finished the steered work.";
					const finalAt = trace.indexOf(final);
					return trace.map((row, index) => ({
						...row,
						at: index >= finalAt ? 1 : 0,
					}));
				},
			);
			const card = await pending(browser, id, "question");
			expect(card["delivery"]).toBe("async");
			if (when === "idle") await completed(fixture, id);
			else expect(snapshot(fixture, id).turns).toEqual([{ state: "running" }]);
			const observer = await fixture.connect(id);
			await observer.waitFor(
				(message) =>
					message["type"] === "question_pending" &&
					message["toolId"] === card["toolId"],
				0,
				TIMEOUT,
			);
			const cursor = observer.frames.length;
			expect(
				await Effect.runPromise(
					browser.rpc.AnswerQuestion({
						projectSlug: "process-test",
						originId: browser.originId,
						commandId: randomUUID(),
						toolId: String(card["toolId"]),
						answers: ASYNC_ANSWERS,
					}),
				),
			).toEqual({ ok: true });
			if (when === "mid-turn") writeFileSync(gatePath, "1");
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
						["completed", "completed"],
					),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await observer.waitFor(
				(message) =>
					message["type"] === "approval_removed" &&
					message["id"] === card["toolId"],
				cursor,
				TIMEOUT,
			);
			const outgoing = rows<TraceRow>(capturePath).filter(
				({ dir }) => dir === "out",
			);
			const answers = outgoing.filter(
				({ message }) =>
					message?.method ===
					(when === "mid-turn" ? "turn/steer" : "turn/start"),
			);
			const answer = answers.at(-1)?.message?.params;
			expect(answer?.["input"]).toEqual([
				{ type: "text", text: ASYNC_TEXT, text_elements: [] },
			]);
			expect(
				outgoing.filter(({ message }) => message?.method === "turn/start"),
			).toHaveLength(when === "mid-turn" ? 1 : 2);
			expect(
				outgoing.filter(({ message }) => message?.method === "turn/steer"),
			).toHaveLength(when === "mid-turn" ? 1 : 0);
			expect(
				outgoing.filter(
					({ message }) => message?.result && message.id !== undefined,
				),
			).toEqual([]);
			const state = snapshot(fixture, id);
			expect(
				state.events.filter(({ type }) => type === "question.asked"),
			).toHaveLength(1);
			expect(
				state.events.filter(({ type }) => type === "question.resolved"),
			).toMatchObject([{ data: { answers: ASYNC_ANSWERS } }]);
			if (when === "mid-turn")
				expect(
					state.events.filter(({ type }) => type === "message.snapshot"),
				).not.toEqual([]);
			const asyncParts =
				sessionRows(fixture, id)["message_parts"]?.filter((part) => {
					const input = JSON.parse(String(part["input"] ?? "{}")) as Record<
						string,
						unknown
					>;
					return input["delivery"] === "async";
				}) ?? [];
			expect(asyncParts).toHaveLength(1);
			expect(JSON.parse(String(asyncParts[0]?.["result"]))).toBe(ASYNC_TEXT);
			const history = await browser.history(id);
			expect(JSON.stringify(history)).toContain(
				ASYNC_TEXT.replaceAll("\n", "\\n"),
			);
			for (const message of history)
				expect(message.turnTiming?.waits ?? []).toEqual([]);
			evidence["answerDelivery"] = answer;
		},
		TIMEOUT * 2,
	);

	it(
		"keeps an async question pending when Stop interrupts its turn",
		async () => {
			const { fixture, browser, id } = await start(
				"async-question-stop",
				"async-question",
				"ask",
				(trace) => {
					const questionAt = trace.findIndex(
						({ message }) =>
							message?.method === "item/completed" &&
							(
								message.params?.["item"] as Record<string, unknown> | undefined
							)?.["delivery"] === "async",
					);
					const terminal = trace.find(
						({ message }) => message?.method === "turn/completed",
					);
					if (questionAt < 0 || !terminal?.message?.params)
						throw new Error("Missing async question or turn terminal");
					const turn = terminal.message.params["turn"] as Record<
						string,
						unknown
					>;
					terminal.message.params["turn"] = {
						...turn,
						status: "interrupted",
						items: [],
					};
					return [
						...trace.slice(0, questionAt + 1),
						{
							dir: "out",
							at: 0,
							message: {
								id: 99,
								method: "turn/interrupt",
								params: {
									threadId: terminal.message.params["threadId"],
									turnId: turn["id"],
								},
							},
						},
						{ dir: "in", at: 0, message: { id: 99, result: {} } },
						terminal,
						...trace.filter(({ dir }) => dir === "exit"),
					];
				},
			);
			const card = await pending(browser, id, "question");
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "interrupted" },
					]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "question.resolved",
				),
			).toEqual([]);
			const observer = await fixture.connect(id);
			expect(
				await observer.waitFor(
					(message) =>
						message["type"] === "question_pending" &&
						message["toolId"] === card["toolId"],
					0,
					TIMEOUT,
				),
			).toMatchObject({ delivery: "async" });
			await observer.rejectQuestion(card);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "question.resolved",
				),
			).toMatchObject([{ data: { answers: {} } }]);
		},
		TIMEOUT * 2,
	);

	it(
		"dismisses an async question after turn completion without sending a message",
		async () => {
			const { fixture, browser, id } = await start(
				"async-question-dismiss",
				"async-question",
			);
			const card = await pending(browser, id, "question");
			await completed(fixture, id);
			const outgoing = rows<TraceRow>(capturePath).filter(
				({ dir }) => dir === "out",
			);
			const cursor = browser.frames.length;
			await browser.rejectQuestion(card);
			await browser.waitFor(
				(message) =>
					message["type"] === "approval_removed" &&
					message["id"] === card["toolId"],
				cursor,
				TIMEOUT,
			);
			expect(
				rows<TraceRow>(capturePath).filter(({ dir }) => dir === "out"),
			).toEqual(outgoing);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "question.resolved",
				),
			).toMatchObject([{ data: { answers: {} } }]);
			expect(
				snapshot(fixture, id)
					.events.filter(({ type }) => type === "tool.completed")
					.at(-1),
			).toMatchObject({ data: { result: null } });
			expect(
				sessionRows(fixture, id)["pending_approvals"]?.find(
					(row) => row["id"] === card["toolId"],
				)?.["status"],
			).toBe("resolved");
			const after = await fixture.connect(id);
			expect(
				after.frames.filter(
					({ message }) =>
						message["type"] === "question_pending" &&
						message["toolId"] === card["toolId"],
				),
			).toEqual([]);
		},
		TIMEOUT * 2,
	);

	it.each(["allow", "deny"] as const)(
		"returns elicitation consent %s even in full mode",
		async (decision) => {
			const { fixture, browser, id, trace } = await start(
				`elicitation-consent-${decision}`,
				"elicitation-consent",
				"full",
			);
			const card = await pending(browser, id, "permission");
			expect(card).toMatchObject({
				toolName: "McpElicitation",
				toolInput: {
					serverName: "fixture",
					message: "Allow access to the fixture?",
				},
			});
			expect(snapshot(fixture, id).turns).toEqual([{ state: "running" }]);
			await browser.answerApproval(card, decision);
			await completed(fixture, id);
			assertReply(serverRequest(trace, ELICITATION).id, {
				action: decision === "allow" ? "accept" : "decline",
			});
		},
		TIMEOUT * 2,
	);

	it.each([
		"typed",
		"invalid-number",
		"invalid-integer",
		"missing-required",
		"reject",
	])(
		"round trips an elicitation form: %s",
		async (answer) => {
			const { fixture, browser, id, trace } = await start(
				`elicitation-form-${answer}`,
				"elicitation-form",
			);
			const card = await pending(browser, id, "question");
			expect(card["questions"]).toMatchObject([
				{ custom: true },
				{ options: [{ label: "Fast" }, { label: "Safe" }] },
				{ options: [{ label: "Yes" }, { label: "No" }] },
				{ custom: true },
				{ multiSelect: true },
				{ options: [{ label: "First" }, { label: "Second" }] },
				{ custom: true },
			]);
			expect(JSON.stringify(card["questions"])).toContain(
				"fixture: Configure the fixture.",
			);
			const answers =
				answer === "reject"
					? {}
					: {
							...(answer === "missing-required" ? {} : { "0": "Ada" }),
							"1": "Safe",
							"2": "No",
							"3": answer === "invalid-number" ? "oops" : "2.5",
							"4": "Alpha, Beta",
							"5": "Second",
							"6": answer === "invalid-integer" ? "2.5" : "3",
						};
			await Effect.runPromise(
				answer === "reject"
					? browser.rpc.RejectQuestion({
							projectSlug: "process-test",
							originId: browser.originId,
							commandId: randomUUID(),
							toolId: String(card["toolId"]),
						})
					: browser.rpc.AnswerQuestion({
							projectSlug: "process-test",
							originId: browser.originId,
							commandId: randomUUID(),
							toolId: String(card["toolId"]),
							answers,
						}),
			);
			await completed(fixture, id);
			assertReply(
				serverRequest(trace, ELICITATION).id,
				answer === "typed"
					? {
							action: "accept",
							content: {
								name: "Ada",
								route: "safe",
								enabled: false,
								count: 2.5,
								tags: ["alpha", "beta"],
								priority: "second",
								retries: 3,
							},
						}
					: { action: "decline" },
			);
			if (
				answer === "invalid-number" ||
				answer === "invalid-integer" ||
				answer === "missing-required"
			)
				expect(JSON.stringify(await browser.history(id))).toContain(
					answer === "missing-required"
						? "missing required field name"
						: answer === "invalid-number"
							? "invalid number for count"
							: "invalid integer for retries",
				);
		},
		TIMEOUT * 2,
	);

	it.each(["url", "openai/form", "openaiForm"])(
		"declines %s elicitation with a diagnostic",
		async (mode) => {
			const { fixture, browser, id, trace } = await start(
				`elicitation-${mode.replaceAll("/", "-")}-declined`,
				"elicitation-url-declined",
				"ask",
				(trace) => {
					const params = serverRequest(trace, ELICITATION).params;
					params["mode"] = mode;
					if (mode !== "url") params["requestedSchema"] = {};
					return trace;
				},
			);
			await browser.send(id, "Continue", TIMEOUT);
			await completed(fixture, id);
			assertReply(serverRequest(trace, ELICITATION).id, { action: "decline" });
			expect(JSON.stringify(await browser.history(id))).toContain(
				`MCP elicitation from fixture declined: unsupported ${mode} mode`,
			);
			expect(
				browser.frames.filter(
					({ message }) =>
						message["type"] === "permission_pending" ||
						message["type"] === "question_pending",
				),
			).toEqual([]);
		},
		TIMEOUT * 2,
	);

	it(
		"supports plain enums, optional fields and nullable turn correlation",
		async () => {
			const { fixture, browser, id, trace } = await start(
				"elicitation-plain-form",
				"elicitation-form",
				"full",
				(trace) => {
					const params = serverRequest(trace, ELICITATION).params;
					params["turnId"] = null;
					params["requestedSchema"] = {
						type: "object",
						properties: {
							choice: { type: "string", enum: ["a", "b"] },
							selected: {
								type: "array",
								items: { type: "string", enum: ["a", "b"] },
							},
							enabled: { type: "boolean" },
							optional: { type: "integer" },
						},
						required: ["choice", "selected", "enabled"],
					};
					return trace;
				},
			);
			const card = await pending(browser, id, "question");
			await Effect.runPromise(
				browser.rpc.AnswerQuestion({
					projectSlug: "process-test",
					originId: browser.originId,
					commandId: randomUUID(),
					toolId: String(card["toolId"]),
					answers: { "0": "b", "1": "a, b", "2": "Yes" },
				}),
			);
			await completed(fixture, id);
			assertReply(serverRequest(trace, ELICITATION).id, {
				action: "accept",
				content: { choice: "b", selected: ["a", "b"], enabled: true },
			});
		},
		TIMEOUT * 2,
	);

	it.each(["format", "empty-enum", "empty-titled-enum"])(
		"declines an unsupported %s form field with a diagnostic",
		async (shape) => {
			const { fixture, browser, id, trace } = await start(
				`elicitation-unsupported-${shape}`,
				"elicitation-form",
				"ask",
				(trace) => {
					serverRequest(trace, ELICITATION).params["requestedSchema"] = {
						type: "object",
						properties: {
							field:
								shape === "format"
									? { type: "string", format: "email" }
									: shape === "empty-enum"
										? { type: "string", enum: [] }
										: { type: "string", oneOf: [] },
						},
					};
					return trace;
				},
			);
			await browser.send(id, "Continue", TIMEOUT);
			await completed(fixture, id);
			assertReply(serverRequest(trace, ELICITATION).id, { action: "decline" });
			expect(JSON.stringify(await browser.history(id))).toContain(
				shape === "format"
					? "unsupported format for field"
					: "unsupported options for field",
			);
		},
		TIMEOUT * 2,
	);

	it.each(["threadId", "turnId"])(
		"cancels an elicitation for a different %s",
		async (key) => {
			const { fixture, browser, id, trace } = await start(
				`elicitation-wrong-${key}`,
				"elicitation-consent",
				"ask",
				(trace) => {
					serverRequest(trace, ELICITATION).params[key] =
						"another-thread-or-turn";
					return trace;
				},
			);
			await browser.send(id, "Continue", TIMEOUT);
			await completed(fixture, id);
			assertReply(serverRequest(trace, ELICITATION).id, { action: "cancel" });
			expect(
				browser.frames.filter(
					({ message }) =>
						message["type"] === "permission_pending" ||
						message["type"] === "question_pending",
				),
			).toEqual([]);
		},
		TIMEOUT * 2,
	);

	it(
		"keeps reused native elicitation request IDs distinct across turns",
		async () => {
			const { fixture, browser, id, trace } = await start(
				"elicitation-reused-request-id",
				"elicitation-consent",
				"full",
				(trace) => {
					const second = fixtureRows("elicitation-consent");
					const turnStart = second.findIndex(
						(row) => row.message?.method === "turn/start",
					);
					const turnId = String(
						serverRequest(trace, ELICITATION).params["turnId"],
					);
					const nextTurnId = randomUUID();
					return [
						...trace.filter((row) => row.dir !== "exit"),
						...second
							.slice(turnStart)
							.map(
								(row) =>
									JSON.parse(
										JSON.stringify({ ...row, at: 0 }).replaceAll(
											turnId,
											nextTurnId,
										),
									) as TraceRow,
							),
					];
				},
			);
			const first = await pending(browser, id, "permission");
			await browser.answerApproval(first, "allow");
			await completed(fixture, id);
			const next = await pending(browser, id, "permission");
			expect(next["requestId"]).not.toBe(first["requestId"]);
			await browser.answerApproval(next, "deny");
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "completed" },
						{ state: "completed" },
					]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const requestId = serverRequest(trace, ELICITATION).id;
			expect(
				rows<TraceRow>(capturePath)
					.filter(
						(row) =>
							row.dir === "out" &&
							row.message?.id === requestId &&
							!row.message.method,
					)
					.map((row) => row.message?.result),
			).toEqual([{ action: "accept" }, { action: "decline" }]);
		},
		TIMEOUT * 2,
	);

	it(
		"Stop cancels a pending elicitation",
		async () => {
			const { fixture, browser, id, trace } = await start(
				"elicitation-interrupt",
			);
			await pending(browser, id, "question");
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "interrupted" },
					]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			assertReply(serverRequest(trace, ELICITATION).id, { action: "cancel" });
		},
		TIMEOUT * 2,
	);

	it.each([
		["once", "allow", "accept"],
		["always", "allow_always", "acceptForSession"],
		["reject", "deny", "decline"],
	] as const)(
		"returns command approval %s and completes the turn",
		async (decision, browserDecision, nativeDecision) => {
			const { fixture, browser, id, trace } = await start(
				`approval-command-${decision}`,
				`approval-command-${decision}`,
				"ask",
				(trace) => {
					if (decision === "always") {
						const params = serverRequest(trace, APPROVAL).params;
						params["availableDecisions"] = [
							"accept",
							"acceptForSession",
							"decline",
							"cancel",
						];
					}
					return trace;
				},
			);
			const native = serverRequest(trace, APPROVAL);
			const card = await pending(browser, id, "permission");
			expect(card).toMatchObject({
				requestId: expect.any(String),
				toolName: "Bash",
				toolInput: { command: native.params["command"] },
			});
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "permission.asked",
					data: expect.objectContaining({
						id: card["requestId"],
						providerRequestId:
							native.params["approvalId"] ?? native.params["itemId"],
					}),
				}),
			);
			expect(card["always"]).toEqual(
				expect.arrayContaining([expect.any(String)]),
			);
			expect(snapshot(fixture, id).turns).toEqual([{ state: "running" }]);
			await browser.answerApproval(card, browserDecision);
			await completed(fixture, id);
			assertReply(native.id, { decision: nativeDecision });
			assertTurnMode(fixture, "ask");
			expect(JSON.stringify(await browser.history(id))).toContain(TEXT);
		},
		TIMEOUT * 2,
	);

	it(
		"correlates command approvals by approvalId and treats unavailable always as once",
		async () => {
			const { fixture, browser, id, trace } = await start(
				"approval-command-always-unavailable",
				"approval-command-once",
				"ask",
				(trace) => {
					const params = serverRequest(trace, APPROVAL).params;
					params["approvalId"] = "distinct-command-approval";
					params["availableDecisions"] = ["accept", "decline", "cancel"];
					return trace;
				},
			);
			const card = await pending(browser, id, "permission");
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "permission.asked",
					data: expect.objectContaining({
						id: card["requestId"],
						providerRequestId: "distinct-command-approval",
					}),
				}),
			);
			await browser.answerApproval(card, "allow_always");
			await completed(fixture, id);
			assertReply(serverRequest(trace, APPROVAL).id, { decision: "accept" });
		},
		TIMEOUT * 2,
	);

	it.each([
		["once", "allow", "accept"],
		["always", "allow_always", "accept"],
		["reject", "deny", "decline"],
	] as const)(
		"lists both file paths and returns file approval %s",
		async (decision, browserDecision, nativeDecision) => {
			const { fixture, browser, id, trace } = await start(
				`approval-file-${decision}`,
				decision === "reject" ? "approval-file-reject" : "approval-file-once",
			);
			const native = serverRequest(trace, FILE_APPROVAL);
			const card = await pending(browser, id, "permission");
			expect(card).toMatchObject({
				requestId: expect.any(String),
				toolName: "Edit",
				toolInput: {
					file_path: "/workspace/alpha.txt",
					filePaths: ["/workspace/alpha.txt", "/workspace/beta.txt"],
				},
			});
			expect(card["always"]).toEqual([
				"/workspace/alpha.txt",
				"/workspace/beta.txt",
			]);
			await browser.answerApproval(card, browserDecision);
			await completed(fixture, id);
			assertReply(native.id, { decision: nativeDecision });
			expect(JSON.stringify(await browser.history(id))).toContain(TEXT);
		},
		TIMEOUT * 2,
	);

	it.each([
		["once", "allow", "turn"],
		["always", "allow_always", "session"],
		["reject", "deny", "turn"],
	] as const)(
		"returns the requested permissions with decision %s",
		async (decision, browserDecision, scope) => {
			const { fixture, browser, id, trace } = await start(
				`approval-permissions-${decision}`,
				"approval-permissions",
			);
			const native = serverRequest(trace, PERMISSIONS);
			const card = await pending(browser, id, "permission");
			expect(card).toMatchObject({
				requestId: expect.any(String),
				toolName: "Permissions",
				toolInput: { permissions: native.params["permissions"] },
			});
			await browser.answerApproval(card, browserDecision);
			await completed(fixture, id);
			assertReply(native.id, {
				permissions: decision === "reject" ? {} : native.params["permissions"],
				scope,
			});
		},
		TIMEOUT * 2,
	);

	it.each([
		["acceptEdits", "mode-accept-edits"],
		["auto", "mode-auto"],
		["plan", "mode-plan"],
	] as const)(
		"pins %s turn settings in the captured request",
		async (mode, source) => {
			const { fixture, browser, id } = await start(source, source, mode);
			await browser.send(id, "Say hello", TIMEOUT);
			await completed(fixture, id);
			assertTurnMode(fixture, mode);
			expect(
				browser.frames.filter(
					({ message }) => message["type"] === "permission_pending",
				),
			).toEqual([]);
		},
		TIMEOUT * 2,
	);

	it(
		"automatically accepts full mode command escalation without a permission card",
		async () => {
			const { fixture, browser, id, trace } = await start(
				"mode-full",
				"mode-full",
				"full",
			);
			await browser.send(id, "Run the command", TIMEOUT);
			await completed(fixture, id);
			assertTurnMode(fixture, "full");
			assertReply(serverRequest(trace, APPROVAL).id, { decision: "accept" });
			expect(
				browser.frames.filter(
					({ message }) => message["type"] === "permission_pending",
				),
			).toEqual([]);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "permission.asked",
				),
			).toEqual([]);
		},
		TIMEOUT * 2,
	);

	it.each(["permission", "question"] as const)(
		"keeps a pending %s answerable after a daemon restart",
		async (kind) => {
			const source =
				kind === "question" ? "question-blocking" : "approval-command-once";
			const { fixture, browser, id, trace, restartOptions } = await start(
				`${kind}-restart`,
				source,
				kind === "question" ? "plan" : "ask",
			);
			expect(PROVIDER_DRIVERS.codex.promptsSurviveRestart).toBe(true);
			const card = await pending(browser, id, kind);
			if (kind === "question") {
				expect(card["delivery"]).toBeUndefined();
				expect(snapshot(fixture, id).turns).toEqual([{ state: "running" }]);
				const waiting = await browser.waitFor(
					(message) =>
						message["type"] === "session_row" &&
						message["id"] === id &&
						message["attention"] === "needs-reply",
					0,
					TIMEOUT,
				);
				expect(waiting["pendingQuestionCount"]).toBe(1);
			}
			const runnerPids = fixture.runnerPids();
			expect(runnerPids).toHaveLength(1);
			await fixture.kill();
			writeTrace(discoveryTrace());
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await fixture.restart(restartOptions);
			expect(fixture.runnerPids()).toEqual(runnerPids);
			const after = await fixture.connect(id);
			const observer =
				kind === "question" ? await fixture.connect(id) : undefined;
			const recovered = await after.waitFor(
				(message) =>
					message["type"] === `${kind}_pending` && message["sessionId"] === id,
				0,
				TIMEOUT,
			);
			if (kind === "permission") {
				expect(recovered["requestId"]).toBe(card["requestId"]);
				await after.answerApproval(recovered, "allow");
			} else {
				expect(recovered["toolId"]).toBe(card["toolId"]);
				expect(recovered["questions"]).toMatchObject([
					{
						header: "Route",
						question: "Which route?",
						options: [
							{ label: "Fast", description: expect.any(String) },
							{ label: "Safe", description: expect.any(String) },
						],
						custom: true,
						isOther: true,
						isSecret: false,
					},
					{
						header: "Access code",
						question: "Access code?",
						options: [],
						custom: false,
						isOther: false,
						isSecret: true,
					},
				]);
				expect(
					await Effect.runPromise(
						after.rpc.AnswerQuestion({
							projectSlug: "process-test",
							originId: after.originId,
							commandId: randomUUID(),
							toolId: String(recovered["toolId"]),
							answers: { "0": "Safe", "1": "fixture-secret" },
						}),
					),
				).toEqual({ ok: true });
			}
			await completed(fixture, id);
			if (kind === "permission") {
				assertReply(serverRequest(trace, APPROVAL).id, { decision: "accept" });
			} else {
				assertReply(serverRequest(trace, QUESTION).id, {
					answers: {
						plan: { answers: ["Safe"] },
						secret: { answers: ["fixture-secret"] },
					},
				});
				const stored = sessionRows(fixture, id);
				await Promise.all(
					[after, ...(observer ? [observer] : [])].map((client) =>
						client.waitForTurnEnd(id, 0, TIMEOUT),
					),
				);
				const histories = await Promise.all(
					[after, ...(observer ? [observer] : [])].map((client) =>
						client.history(id),
					),
				);
				const receivedFrames = [
					browser,
					after,
					...(observer ? [observer] : []),
				].map((client) => client.frames.map(({ message }) => message));
				const leakingTables = Object.entries(stored)
					.filter(([, tableRows]) =>
						JSON.stringify(tableRows).includes("fixture-secret"),
					)
					.map(([name]) => name);
				evidence["secretExposure"] = {
					rowCounts: Object.fromEntries(
						Object.entries(stored).map(([name, tableRows]) => [
							name,
							tableRows.length,
						]),
					),
					leakingTables,
					historyLeaks: histories.map((history) =>
						JSON.stringify(history).includes("fixture-secret"),
					),
					frameLeaks: receivedFrames.map((frames) =>
						JSON.stringify(frames).includes("fixture-secret"),
					),
				};
				expect(leakingTables).toEqual([]);
				expect(JSON.stringify(histories)).not.toContain("fixture-secret");
				expect(JSON.stringify(receivedFrames)).not.toContain("fixture-secret");
				const publicAnswers = { "0": "Safe", "1": "[redacted]" };
				expect(
					snapshot(fixture, id).events.find(
						({ type }) => type === "question.resolved",
					)?.data["answers"],
				).toEqual(publicAnswers);
				const approval = stored["pending_approvals"]?.find(
					(row) => row["id"] === recovered["toolId"],
				);
				expect(approval?.["status"]).toBe("resolved");
				expect(JSON.parse(String(approval?.["decision"]))).toEqual(
					publicAnswers,
				);
				await vi.waitFor(
					() => expect(fixture.proof().logTail).toContain("answering:"),
					{ timeout: 15_000, interval: 100 },
				);
				const answerLog = fixture
					.proof()
					.logTail.split("\n")
					.find((line) => line.includes("answering:"));
				expect(answerLog).toContain("[redacted]");
				expect(
					readFileSync(join(artifactRoot, "daemon.log"), "utf8"),
				).not.toContain("fixture-secret");
			}
			expect(JSON.stringify(await after.history(id))).toContain(TEXT);
			expect(
				rows<TraceRow>(capturePath).filter(
					({ dir, message }) =>
						dir === "out" && message?.method === "turn/start",
				),
			).toHaveLength(1);
			const state = snapshot(fixture, id);
			expect(
				state.events.filter(({ type }) => type === `${kind}.asked`),
			).toHaveLength(1);
			expect(
				state.events.filter(({ type }) => type === `${kind}.resolved`),
			).toHaveLength(1);
			evidence["pendingBeforeRestart"] = card;
			evidence["pendingAfterRestart"] = recovered;
			evidence["retainedRunnerPids"] = runnerPids;
		},
		TIMEOUT * 3,
	);

	it.each([
		{
			kind: "permission",
			source: "elicitation-consent",
			method: ELICITATION,
			mode: "full",
			offline: false,
		},
		{
			kind: "question",
			source: "elicitation-form",
			method: ELICITATION,
			mode: "ask",
			offline: false,
		},
		{
			kind: "permission",
			source: "approval-command-once",
			method: APPROVAL,
			mode: "ask",
			offline: false,
		},
		{
			kind: "question",
			source: "question-blocking",
			method: QUESTION,
			mode: "plan",
			offline: false,
		},
		{
			kind: "permission",
			source: "approval-command-once",
			method: APPROVAL,
			mode: "ask",
			offline: true,
		},
		{
			kind: "question",
			source: "question-blocking",
			method: QUESTION,
			mode: "plan",
			offline: true,
		},
	] as const)(
		"clears a $kind card from $source resolved elsewhere while daemon offline=$offline",
		async ({ kind, source, method, mode, offline }) => {
			const { fixture, browser, id, trace, restartOptions } = await start(
				`${source}-resolved-elsewhere${offline ? "-offline" : ""}`,
				source,
				mode,
				(trace) => {
					const request = serverRequest(trace, method);
					const requestIndex = trace.findIndex(
						(row) => row.message?.method === method,
					);
					const before = trace.slice(0, requestIndex + 1);
					const after = trace
						.slice(requestIndex + 1)
						.filter(
							(row) =>
								!(
									row.dir === "out" &&
									row.message?.["id"] === request.id &&
									!row.message.method
								),
						);
					before.push({
						dir: "in",
						message: {
							method: "serverRequest/resolved",
							params: {
								threadId: request.params["threadId"],
								requestId: request.id,
							},
						},
					});
					return [...before, ...after].map((row, index) => ({
						...row,
						at: index > requestIndex ? 1 : 0,
					}));
				},
			);
			const card = await pending(browser, id, kind);
			const cursor = browser.frames.length;
			if (offline) await fixture.kill();
			writeFileSync(gatePath, "1");
			if (offline) {
				await vi.waitFor(
					() =>
						expect(rows<TraceRow>(capturePath)).toContainEqual(
							expect.objectContaining({
								dir: "in",
								message: expect.objectContaining({ method: "turn/completed" }),
							}),
						),
					{ timeout: TIMEOUT, interval: 100 },
				);
				writeTrace(discoveryTrace());
				writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
				await fixture.restart(restartOptions);
			} else {
				await browser.waitFor(
					(message) =>
						message["type"] === "approval_removed" &&
						message["id"] ===
							card[kind === "question" ? "toolId" : "requestId"],
					cursor,
					TIMEOUT,
				);
			}
			await completed(fixture, id);
			await vi.waitFor(
				() =>
					expect(
						snapshot(fixture, id).events.filter(
							({ type }) => type === `${kind}.resolved`,
						),
					).toHaveLength(1),
				{ timeout: 15_000, interval: 100 },
			);
			const reconnected = await fixture.connect(id);
			expect(
				reconnected.frames.filter(
					({ message }) => message["type"] === `${kind}_pending`,
				),
			).toEqual([]);
			expect(
				rows<TraceRow>(capturePath).filter(
					({ dir, message }) =>
						dir === "out" &&
						message?.["id"] === serverRequest(trace, method).id &&
						!message.method,
				),
			).toEqual([]);
		},
		TIMEOUT * 2,
	);

	it.each([
		["command", "approval-command-once", APPROVAL],
		["file", "approval-file-once", FILE_APPROVAL],
		["permissions", "approval-permissions", PERMISSIONS],
	] as const)(
		"cancels a pending %s approval when the turn is interrupted",
		async (kind, source, method) => {
			const { fixture, browser, id, trace } = await start(
				`approval-${kind}-interrupt`,
				source,
				"ask",
				(trace) => {
					const request = serverRequest(trace, method);
					const index = trace.findIndex(
						(row) => row.message?.method === method,
					);
					const terminal = trace.find(
						(row) => row.message?.method === "turn/completed",
					);
					if (!terminal?.message?.params)
						throw new Error("No recorded turn completion");
					const turn = terminal.message.params["turn"] as Record<
						string,
						unknown
					>;
					terminal.message.params["turn"] = {
						...turn,
						status: "interrupted",
						items: [],
					};
					const cancel =
						kind === "permissions"
							? { permissions: {}, scope: "turn" }
							: { decision: "cancel" };
					return [
						...trace.slice(0, index + 1),
						{
							dir: "out",
							at: 0,
							message: {
								id: 99,
								method: "turn/interrupt",
								params: {
									threadId: request.params["threadId"],
									turnId: request.params["turnId"],
								},
							},
						},
						{ dir: "in", at: 0, message: { id: 99, result: {} } },
						{ dir: "out", at: 0, message: { id: request.id, result: cancel } },
						terminal,
						...trace.filter((row) => row.dir === "exit"),
					];
				},
			);
			const card = await pending(browser, id, "permission");
			const cursor = browser.frames.length;
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
			);
			await vi.waitFor(
				() => {
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "interrupted" },
					]);
					assertReply(
						serverRequest(trace, method).id,
						kind === "permissions"
							? { permissions: {}, scope: "turn" }
							: { decision: "cancel" },
					);
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			await browser.waitFor(
				(message) =>
					message["type"] === "approval_removed" &&
					message["id"] === card["requestId"],
				cursor,
				TIMEOUT,
			);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "turn.error",
				),
			).toEqual([]);
		},
		TIMEOUT * 2,
	);
});
