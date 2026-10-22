// Failure modes: duplicate/lost steers, interrupting an accepted queued id,
// startup submitting after Stop, stale controller ownership, replacing a lost
// thread, and losing the terminal error's retryability across the daemon.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_DRIVERS } from "../../../src/lib/contracts/provider-instance.js";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import { writeCodexSessionIdentity } from "../../../src/lib/provider/codex/codex-session-store.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const STEER = "Use the steered instruction";
const TEXT = "Hello from the mock model.";

describe("Codex control through the daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	let artifactRoot = "";
	let tracePath = "";
	let capturePath = "";
	let reportPath = "";
	let gatePath = "";
	let controller: ChildProcess | undefined;
	let evidence: Record<string, unknown> = {};

	function writeTrace(trace: TraceRow[]) {
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}

	async function start(name: string, source = name) {
		artifactRoot = resolve(`test-results/codex-control/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		reportPath = join(artifactRoot, "trace-report.jsonl");
		capturePath = join(artifactRoot, "capture.jsonl");
		writeFileSync(reportPath, "");
		evidence = { scenario: name };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			buildId: "codex-control-old",
		});
		tracePath = join(harness.root, "codex-replay.jsonl");
		gatePath = join(harness.root, "codex-gate");
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
		const browser = await harness.connect();
		const accounts = await vi.waitFor(
			async () => {
				const found = (await browser.instances()).instances.filter(
					({ driver }) => driver === "codex",
				);
				expect(found).toHaveLength(1);
				return found;
			},
			{ timeout: TIMEOUT },
		);
		const found = accounts[0];
		if (!found) throw new Error("No replay Codex account");
		expect(await codexModels(browser, found.id)).toContainEqual(
			expect.objectContaining({ id: "gpt-6.1-sol" }),
		);
		sessionId = await browser.createSession(name, found.id, "codex", {
			modelId: "gpt-6.1-sol",
			contextWindow: "",
			permissionMode: "ask",
		});
		writeTrace(fixtureRows(source));
		return {
			fixture: harness,
			browser,
			id: sessionId,
			accountId: found.id,
			restartOptions,
		};
	}

	const captured = () => rows<TraceRow>(capturePath);
	const requests = () =>
		captured().filter((row) => row.dir === "out" && row.message?.method);

	async function states(
		fixture: ProcessHarness,
		id: string,
		expected: string[],
	) {
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
					expected,
				),
			{ timeout: TIMEOUT },
		);
	}

	function expectFailedRun(
		fixture: ProcessHarness,
		id: string,
		accepted: boolean,
	) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			const commands = db
				.prepare<[string], { inputId: string; runId: string }>(
					"SELECT json_extract(payload_json, '$.inputId') AS inputId, run_id AS runId FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(id);
			expect(commands).toHaveLength(1);
			const command = commands[0];
			if (!command) throw new Error("Missing failed Codex send reservation");
			expect(command.runId).toEqual(expect.any(String));
			expect(
				db
					.prepare<
						[string],
						{ id: string; status: string; started_at: number | null }
					>(
						"SELECT id, status, started_at FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
					)
					.all(id),
			).toEqual([
				{
					id: command.runId,
					status: "error",
					started_at: accepted ? expect.any(Number) : null,
				},
			]);
			expect(
				db
					.prepare<
						[string],
						{
							input_id: string;
							state: string;
							run_id: string | null;
							started_at: number | null;
						}
					>(
						"SELECT m.input_id, t.state, t.run_id, t.started_at FROM turns t JOIN messages m ON m.id = t.user_message_id WHERE t.session_id = ? ORDER BY t.requested_at, t.rowid",
					)
					.all(id),
			).toEqual([
				{
					input_id: command.inputId,
					state: "error",
					run_id: command.runId,
					started_at: accepted ? expect.any(Number) : null,
				},
			]);
			const { events } = snapshot(fixture, id);
			expect(events.filter(({ type }) => type === "run.started")).toHaveLength(
				accepted ? 1 : 0,
			);
			expect(events.filter(({ type }) => type === "turn.error")).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ runId: command.runId }),
				}),
			]);
		} finally {
			db.close();
		}
	}

	async function submit(
		browser: ProcessBrowser,
		id: string,
		text: string,
		delivery: "queue" | "steer" = "queue",
	) {
		await browser.followSession(id);
		const inputId = text === STEER ? "fixture-steer" : randomUUID();
		const result = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: id,
				originId: browser.originId,
				inputId,
				delivery,
				text,
			}),
		);
		expect(result.ok).toBe(true);
		return inputId;
	}

	async function cancel(browser: ProcessBrowser, id: string) {
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
		);
	}

	function seed(
		fixture: ProcessHarness,
		id: string,
		trace: TraceRow[],
		pid = 2_000_000_000,
	) {
		const threadId = trace.find(
			(row) => row.message?.method === "thread/resume",
		)?.message?.params?.["threadId"];
		if (typeof threadId !== "string")
			throw new Error("Missing recorded thread/resume");
		writeCodexSessionIdentity(fixture.configDir, id, {
			threadId,
			cwd: fixture.projectDir,
			controllerPid: pid,
		});
		return threadId;
	}

	function resumeTrace(threadId: string) {
		const trace = fixtureRows("resume-after-crash");
		const recorded = trace.find(
			(row) => row.message?.method === "thread/resume",
		)?.message?.params?.["threadId"];
		if (typeof recorded !== "string") throw new Error("Missing resume thread");
		return JSON.parse(
			JSON.stringify(trace).replaceAll(recorded, threadId),
		) as TraceRow[];
	}

	function identity(fixture: ProcessHarness, id: string) {
		return JSON.parse(
			readFileSync(
				join(fixture.configDir, "codex", "stores", id, "session.json"),
				"utf8",
			),
		) as { threadId: string; controllerPid: number };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		if (controller) {
			controller.kill("SIGKILL");
			controller = undefined;
		}
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const fixture = harness;
		const state = sessionId ? snapshot(fixture, sessionId) : undefined;
		const logPath = join(fixture.configDir, "runners.log");
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
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
			writeFileSync(join(artifactRoot, "runners.log"), log);
			writeFileSync(
				join(artifactRoot, "evidence.json"),
				`${JSON.stringify({ ...evidence, result: task.result?.state, process: fixture.proof() }, null, 2)}\n`,
			);
			harness = undefined;
			sessionId = undefined;
		}
	});

	it(
		"steer echoes the second input once on the executing turn",
		async () => {
			expect(PROVIDER_DRIVERS.codex.steering).toBe("native");
			const { fixture, browser, id } = await start("steer");
			// Release the RPC acknowledgement while holding its later user echo.
			writeFileSync(gatePath, "591");
			await submit(browser, id, "Say hello");
			await vi.waitFor(
				() =>
					expect(
						captured().some(
							(row) => row.message?.method === "item/agentMessage/delta",
						),
					).toBe(true),
				{ timeout: TIMEOUT },
			);
			await submit(browser, id, STEER, "steer");
			await vi.waitFor(
				() => {
					const { events } = snapshot(fixture, id);
					const requested = events.find(
						({ type, data }) =>
							type === "run.requested" && data["inputId"] === "fixture-steer",
					);
					const initial = events.find(({ type }) => type === "run.started");
					expect(requested).toBeDefined();
					expect(initial?.metadata["runId"]).toBeTypeOf("string");
					expect(events).toContainEqual(
						expect.objectContaining({
							type: "run.started",
							metadata: expect.objectContaining({
								runId: initial?.metadata["runId"],
							}),
							data: expect.objectContaining({
								inputId: "fixture-steer",
								requestedRunId: requested?.data["runId"],
							}),
						}),
					);
				},
				{ timeout: TIMEOUT },
			);
			expect(
				captured().filter(
					(row) =>
						row.message?.method === "item/completed" &&
						(row.message.params?.["item"] as { clientId?: string })
							?.clientId === "fixture-steer",
				),
			).toEqual([]);
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await states(fixture, id, ["completed", "completed"]);
			const starts = requests().filter(
				(row) => row.message?.method === "turn/start",
			);
			const steer = requests().find(
				(row) => row.message?.method === "turn/steer",
			);
			expect(starts).toHaveLength(1);
			expect(steer?.message?.params).toMatchObject({
				threadId: identity(fixture, id).threadId,
				expectedTurnId: expect.any(String),
				input: [{ type: "text", text: STEER, text_elements: [] }],
			});
			const echoed = captured().filter(
				(row) =>
					row.message?.method === "item/completed" &&
					(row.message.params?.["item"] as { clientId?: string })?.clientId ===
						steer?.message?.params?.["clientUserMessageId"],
			);
			expect(echoed).toHaveLength(1);
			expect(echoed[0]?.message?.params?.["turnId"]).toBe(
				steer?.message?.params?.["expectedTurnId"],
			);
			const user = (await browser.history(id)).filter(
				(message) => message.role === "user",
			);
			expect(user).toHaveLength(2);
			expect(
				user.filter((message) => JSON.stringify(message).includes(STEER)),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it.each([
		"completion-first",
		"rejection-first",
		"expected-id-mismatch",
	] as const)(
		"steer-race %s requeues the rejected input on a second turn exactly once",
		async (race) => {
			const source =
				race === "expected-id-mismatch" ? "steer-mismatch" : "steer-race";
			const { fixture, browser, id } = await start(
				`steer-race-${race}`,
				source,
			);
			const trace = fixtureRows(source);
			// Hold completion until the second send has issued its steer. The real
			// captured no-active-turn rejection then races that completion in flight.
			const steerAt = trace.findIndex(
				(row) => row.message?.method === "turn/steer",
			);
			const terminalAt = trace.findIndex(
				(row) => row.message?.method === "turn/completed",
			);
			if (race !== "expected-id-mismatch") {
				const terminal = trace.splice(terminalAt, 1)[0];
				if (!terminal || steerAt < 0) throw new Error("Missing recorded race");
				trace.splice(
					steerAt + (race === "rejection-first" ? 1 : 0),
					0,
					terminal,
				);
			}
			writeTrace(trace);
			await submit(browser, id, "Say hello");
			await vi.waitFor(
				() =>
					expect(
						captured().some(
							(row) => row.message?.method === "item/agentMessage/delta",
						),
					).toBe(true),
				{ timeout: TIMEOUT },
			);
			await submit(browser, id, "Say hello again", "steer");
			await states(fixture, id, ["completed", "completed"]);
			const starts = requests().filter(
				(row) => row.message?.method === "turn/start",
			);
			expect(starts).toHaveLength(2);
			expect(starts[1]?.message?.params?.["input"]).toEqual([
				{ type: "text", text: "Say hello again", text_elements: [] },
			]);
			const user = (await browser.history(id)).filter(
				(message) => message.role === "user",
			);
			expect(user).toHaveLength(2);
			expect(
				user.filter((message) =>
					JSON.stringify(message).includes("Say hello again"),
				),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it(
		"stop-queued waits for turn/started before interrupting",
		async () => {
			const { fixture, browser, id } = await start("stop-queued");
			let started = false;
			writeTrace(
				fixtureRows("stop-queued").map((row) => {
					if (row.message?.method === "turn/started") started = true;
					return { ...row, at: started ? 1 : 0 };
				}),
			);
			writeFileSync(gatePath, "0");
			await submit(browser, id, "Say hello");
			await vi.waitFor(
				() =>
					expect(captured().some((row) => row.message?.result?.["turn"])).toBe(
						true,
					),
				{ timeout: TIMEOUT },
			);
			const stopping = cancel(browser, id);
			await states(fixture, id, ["pending"]);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "run.started",
				),
			).toEqual([]);
			expect(
				requests().filter((row) => row.message?.method === "turn/interrupt"),
			).toHaveLength(0);
			writeFileSync(gatePath, "1");
			await stopping;
			await states(fixture, id, ["interrupted"]);
			await vi.waitFor(
				() =>
					expect(
						requests().filter(
							(row) => row.message?.method === "turn/interrupt",
						),
					).toHaveLength(1),
				{ timeout: TIMEOUT },
			);
			const executing = captured().find(
				(row) => row.message?.method === "turn/started",
			)?.message?.params?.["turn"] as { id: string };
			expect(
				requests().find((row) => row.message?.method === "turn/interrupt")
					?.message?.params?.["turnId"],
			).toBe(executing.id);
		},
		TIMEOUT * 2,
	);

	it(
		"stop-startup settles a stalled thread initialization without turn/start",
		async () => {
			const { fixture, browser, id } = await start("stop-startup");
			await submit(browser, id, "Say hello");
			await vi.waitFor(
				() =>
					expect(
						requests().some((row) => row.message?.method === "thread/start"),
					).toBe(true),
				{ timeout: TIMEOUT },
			);
			await cancel(browser, id);
			await states(fixture, id, ["interrupted"]);
			await vi.waitFor(
				() =>
					expect(
						rows<AppServerTraceReport>(reportPath).some(
							(report) => report.scenario === "stop-startup",
						),
					).toBe(true),
				{ timeout: 5000 },
			);
			expect(
				requests().filter((row) => row.message?.method === "turn/start"),
			).toHaveLength(0);
			expect(
				snapshot(fixture, id).events.some(
					({ type }) => type === "turn.interrupted",
				),
			).toBe(true);
			evidence["cancelledCapture"] = captured();
			writeTrace(fixtureRows("basic"));
			await browser.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["interrupted", "completed"]);
		},
		TIMEOUT * 2,
	);

	it(
		"resume-after-crash respawns a dead child and resumes the same thread",
		async () => {
			const { fixture, browser, id } = await start(
				"resume-after-crash",
				"basic",
			);
			const trace = fixtureRows("basic");
			const index = trace.findIndex(
				(row) => row.message?.method === "item/agentMessage/delta",
			);
			writeTrace([
				...trace.slice(0, index + 1),
				{
					dir: "exit",
					at: Number(trace[index]?.["at"]) + 1,
					code: 1,
					signal: null,
				},
			]);
			await submit(browser, id, "Say hello");
			await states(fixture, id, ["error"]);
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "turn.error",
					data: expect.objectContaining({
						code: "provider_unavailable",
						retryable: true,
					}),
				}),
			);
			const stored = identity(fixture, id);
			const pids = fixture.runnerPids();
			evidence["failedCapture"] = captured();
			writeTrace(resumeTrace(stored.threadId));
			expect(
				(await browser.send(id, "Say hello", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await states(fixture, id, ["error", "completed"]);
			expect(fixture.runnerPids()).toEqual(pids);
			expect(
				requests().find((row) => row.message?.method === "thread/resume")
					?.message?.params,
			).toMatchObject({ threadId: stored.threadId, excludeTurns: true });
			expect(
				requests().some((row) => row.message?.method === "thread/start"),
			).toBe(false);
		},
		TIMEOUT * 3,
	);

	it(
		"a runner crash and daemon restart resume the identity file's thread",
		async () => {
			const { fixture, browser, id, accountId, restartOptions } = await start(
				"runner-crash",
				"basic",
			);
			await browser.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["completed"]);
			const stored = identity(fixture, id);
			await fixture.kill();
			process.kill(stored.controllerPid, "SIGKILL");
			await vi.waitFor(
				() => expect(() => process.kill(stored.controllerPid, 0)).toThrow(),
				{ timeout: 10_000 },
			);
			writeTrace(signedInCodexDiscoveryTrace());
			await fixture.restart(restartOptions);
			const restarted = await fixture.connect(id);
			await codexModels(restarted, accountId);
			writeTrace(resumeTrace(stored.threadId));
			await restarted.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["completed", "completed"]);
			expect(identity(fixture, id).threadId).toBe(stored.threadId);
			expect(identity(fixture, id).controllerPid).not.toBe(
				stored.controllerPid,
			);
			expect(
				requests().find((row) => row.message?.method === "thread/resume")
					?.message?.params?.["threadId"],
			).toBe(stored.threadId);
		},
		TIMEOUT * 3,
	);

	it(
		"resume-unarchive retries the archived thread once",
		async () => {
			const { fixture, browser, id } = await start("resume-unarchive");
			const threadId = seed(fixture, id, fixtureRows("resume-unarchive"));
			await browser.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["completed"]);
			expect(requests().map((row) => row.message?.method)).toEqual([
				"initialize",
				"initialized",
				"thread/resume",
				"thread/unarchive",
				"thread/resume",
				"turn/start",
			]);
			expect(identity(fixture, id).threadId).toBe(threadId);
		},
		TIMEOUT * 2,
	);

	it(
		"resume-missing fails with codex_thread_missing after one unarchive",
		async () => {
			const { fixture, browser, id } = await start("resume-missing");
			const threadId = seed(fixture, id, fixtureRows("resume-missing"));
			await browser.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["error"]);
			expectFailedRun(fixture, id, false);
			expect(requests().map((row) => row.message?.method)).toEqual([
				"initialize",
				"initialized",
				"thread/resume",
				"thread/unarchive",
				"thread/resume",
			]);
			expect(identity(fixture, id).threadId).toBe(threadId);
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "turn.error",
					data: expect.objectContaining({
						code: "codex_thread_missing",
						retryable: false,
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it.each([
		["error-auth_required", "auth_required", false],
		["error-usage_limited", "usage_limited", false],
		["error-usage_limited-429", "usage_limited", false],
		["error-context_overflow", "context_overflow", false],
		["error-provider_unavailable", "provider_unavailable", true],
		["error-provider_unavailable-disconnected", "provider_unavailable", true],
		["error-provider_error", "provider_error", false],
	] as const)(
		"%s preserves its code and retryability",
		async (scenario, code, retryable) => {
			const { fixture, browser, id } = await start(scenario);
			await browser.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["error"]);
			expectFailedRun(fixture, id, true);
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "turn.error",
					data: expect.objectContaining({ code, retryable }),
				}),
			);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "turn.error",
				),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it(
		"a send immediately after a runner upgrade resumes instead of agent_busy",
		async () => {
			const { fixture, browser, id, accountId, restartOptions } = await start(
				"runner-upgrade",
				"basic",
			);
			await browser.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["completed"]);
			const stored = identity(fixture, id);
			await fixture.kill();
			writeTrace(signedInCodexDiscoveryTrace());
			await fixture.restart({
				...restartOptions,
				buildId: "codex-control-new",
			});
			await vi.waitFor(
				() =>
					expect(
						fixture.marks.some(
							(mark) =>
								mark.kind === "runner-upgrade" && mark.phase === "switched",
						),
					).toBe(true),
				{ timeout: TIMEOUT, interval: 5 },
			);
			const restarted = await fixture.connect(id);
			await codexModels(restarted, accountId);
			writeTrace(resumeTrace(stored.threadId));
			await restarted.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["completed", "completed"]);
			expect(identity(fixture, id).controllerPid).not.toBe(
				stored.controllerPid,
			);
			expect(identity(fixture, id).threadId).toBe(stored.threadId);
			expect(
				snapshot(fixture, id).events.filter(
					({ type }) => type === "turn.error",
				),
			).toEqual([]);
		},
		TIMEOUT * 3,
	);

	it(
		"waits for a retiring controller before resuming",
		async () => {
			const { fixture, browser, id } = await start(
				"retiring-controller",
				"resume-after-crash",
			);
			controller = spawn(
				process.execPath,
				["-e", "setTimeout(() => process.exit(0), 1500)"],
				{ stdio: "ignore" },
			);
			if (!controller.pid) throw new Error("No temporary controller pid");
			seed(fixture, id, fixtureRows("resume-after-crash"), controller.pid);
			await browser.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["completed"]);
			expect(
				requests().some((row) => row.message?.method === "thread/resume"),
			).toBe(true);
		},
		TIMEOUT * 2,
	);

	it(
		"a genuinely concurrent controller still fails agent_busy",
		async () => {
			const { fixture, browser, id } = await start(
				"live-controller",
				"resume-after-crash",
			);
			seed(fixture, id, fixtureRows("resume-after-crash"), process.pid);
			// Ownership must be rejected before even opening the app-server.
			writeTrace([]);
			await browser.send(id, "Say hello", TIMEOUT);
			await states(fixture, id, ["error"]);
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "turn.error",
					data: expect.objectContaining({ code: "agent_busy" }),
				}),
			);
		},
		TIMEOUT * 2,
	);
});
