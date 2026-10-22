import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";

function turns(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT id, state, completed_at FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
			)
			.all(sessionId) as Array<{
			id: string;
			state: string;
			completed_at: number | null;
		}>;
	} finally {
		db.close();
	}
}

function ledger(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			session: db
				.prepare(
					"SELECT last_turn_end_version, last_turn_end_input_id FROM sessions WHERE id = ?",
				)
				.get(sessionId) as {
				last_turn_end_version: number | null;
				last_turn_end_input_id: string | null;
			},
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as Array<{ id: string; status: string }>,
			turns: db
				.prepare(
					"SELECT id, state, run_id, completed_at FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as Array<{
				id: string;
				state: string;
				run_id: string | null;
				completed_at: number | null;
			}>,
			commands: db
				.prepare(
					"SELECT command_id, status, run_id FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as Array<{
				command_id: string;
				status: string;
				run_id: string | null;
			}>,
			events: db
				.prepare(
					"SELECT sequence, type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId)
				.map((row) => {
					const event = row as {
						sequence: number;
						type: string;
						data: string;
						metadata: string;
					};
					return {
						...event,
						data: JSON.parse(event.data) as Record<string, unknown>,
						metadata: JSON.parse(event.metadata) as { runId?: string },
					};
				}),
			queued: db
				.prepare(
					"SELECT input_id FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at, rowid",
				)
				.all(sessionId) as Array<{ input_id: string }>,
		};
	} finally {
		db.close();
	}
}

function terminals(
	state: ReturnType<typeof ledger>,
	provider: "claude" | "opencode",
) {
	return state.events.filter(
		(event) =>
			event.metadata.runId !== undefined &&
			(provider === "claude"
				? ["turn.completed", "turn.error", "turn.interrupted"].includes(
						event.type,
					)
				: event.type === "session.status" &&
					["idle", "error"].includes(String(event.data["status"]))),
	);
}

function normalized(
	state: ReturnType<typeof ledger>,
	provider: "claude" | "opencode",
) {
	const runNumber = (id: string | null | undefined) =>
		id == null ? null : state.runs.findIndex((run) => run.id === id) + 1;
	return {
		runs: state.runs.map(({ id, status }) => ({ run: runNumber(id), status })),
		turns: state.turns.map(({ state, run_id }, index) => ({
			input: index + 1,
			state,
			run: runNumber(run_id),
		})),
		terminalRuns: terminals(state, provider).map((event) =>
			runNumber(event.metadata.runId),
		),
		queuedInputs: state.queued.length,
	};
}

async function submit(
	browser: ProcessBrowser,
	sessionId: string,
	text: string,
	delivery: "queue" | "steer" = "queue",
) {
	const inputId = randomUUID();
	const response = await Effect.runPromise(
		browser.rpc["input.submit"]({
			sessionId,
			originId: browser.originId,
			inputId,
			text,
			delivery,
		}),
	);
	expect(response.ok).toBe(true);
	return inputId;
}

// Failure modes: sending a steer closes its predecessor, queueing assigns an
// owner before acceptance, or a terminal event closes another run's turns.
describe("provider run ownership through the isolated daemon", () => {
	let harness: ProcessHarness | undefined;
	let modelServer: Server | undefined;
	const cases: Array<Record<string, unknown>> = [];
	let proof: Record<string, unknown>;

	afterEach(async ({ task }) => {
		try {
			if (task.result?.errors?.length && harness)
				writeFileSync(`/tmp/82tn24-${proof["case"]}.log`, harness.logTail);
			await harness?.dispose();
			harness?.assertNoRunners();
			proof["cleanup"] = "no fixture runners remain";
		} finally {
			if (modelServer) {
				modelServer.closeAllConnections();
				await new Promise<void>((resolve) =>
					modelServer?.close(() => resolve()),
				);
				modelServer = undefined;
			}
			proof["outcome"] = task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn24-run-ownership.json",
				`${JSON.stringify({ cases }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("keeps both accepted turns running until their shared Claude result", async () => {
		proof = { case: "claude-steer-joins-at-tool-boundary", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			...(process.env["CONDUIT_TEST_DIST"] && {
				dist: process.env["CONDUIT_TEST_DIST"],
			}),
			claudeReplay: {
				turns: ["steer-during-tool-folds"],
				delayMs: 100,
				holdBeforeResult: true,
			},
		});
		harness = fixture;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Joined run");
		await browser.followSession(sessionId);
		const alpha = await submit(browser, sessionId, "Alpha");
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				JSON.stringify(message["parts"]).includes("Bash"),
		);
		const bravo = await submit(browser, sessionId, "Bravo", "steer");
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				message["role"] === "assistant" &&
				JSON.stringify(message["parts"]).includes("BANANA"),
		);
		const beforeResult = turns(fixture, sessionId).map(({ state }) => state);
		proof["beforeResult"] = beforeResult;
		expect(beforeResult).toEqual(["running", "running"]);
		const accepted = ledger(fixture, sessionId);
		const runId = accepted.turns[0]?.run_id;
		expect(runId).toBeTruthy();
		expect(accepted.turns.map(({ id, run_id }) => ({ id, run_id }))).toEqual([
			{ id: alpha, run_id: runId },
			{ id: bravo, run_id: runId },
		]);
		expect(terminals(accepted, "claude")).toEqual([]);
		expect(new Set(accepted.commands.map(({ run_id }) => run_id)).size).toBe(2);
		expect(
			accepted.commands.every(({ run_id }) => typeof run_id === "string"),
		).toBe(true);
		proof["accepted"] = normalized(accepted, "claude");
		writeFileSync(join(fixture.root, "claude-replay-release"), "release");
		await vi.waitFor(
			() =>
				expect(turns(fixture, sessionId).map(({ state }) => state)).toEqual([
					"completed",
					"completed",
				]),
			{ timeout: 15_000 },
		);
		const completed = ledger(fixture, sessionId);
		expect(
			terminals(completed, "claude").map(({ metadata }) => metadata.runId),
		).toEqual([runId]);
		expect(completed.turns[0]?.completed_at).toBe(
			completed.turns[1]?.completed_at,
		);
		expect(completed.runs.map(({ status }) => status)).toEqual([
			"completed",
			"joined",
		]);
		proof["completed"] = normalized(completed, "claude");
	}, 60_000);

	it("leaves a missed Claude steer unjoined until its own run starts", async () => {
		proof = { case: "claude-steer-misses-tool-boundary", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			claudeReplay: {
				turns: ["steer-misses-boundary"],
				delayMs: 30,
				holdBeforeResult: true,
			},
		});
		harness = fixture;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Missed boundary");
		await browser.followSession(sessionId);
		const alpha = await submit(browser, sessionId, "Alpha");
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				message["role"] === "assistant",
		);
		const bravo = await submit(browser, sessionId, "Bravo", "steer");
		await vi.waitFor(() =>
			expect(ledger(fixture, sessionId).commands).toHaveLength(2),
		);
		const queued = ledger(fixture, sessionId);
		expect(queued.turns.map(({ id, state }) => ({ id, state }))).toEqual([
			{ id: alpha, state: "running" },
		]);
		expect(queued.runs.map(({ status }) => status)).toEqual([
			"running",
			"pending",
		]);
		expect(terminals(queued, "claude")).toEqual([]);
		proof["beforeFirstResult"] = normalized(queued, "claude");
		writeFileSync(join(fixture.root, "claude-replay-release"), "release");
		await vi.waitFor(
			() =>
				expect(
					ledger(fixture, sessionId).turns.map(({ state }) => state),
				).toEqual(["completed", "completed"]),
			{ timeout: 15_000 },
		);
		const completed = ledger(fixture, sessionId);
		const [alphaRun, bravoRun] = completed.runs.map(({ id }) => id);
		expect(completed.turns.map(({ id, run_id }) => ({ id, run_id }))).toEqual([
			{ id: alpha, run_id: alphaRun },
			{ id: bravo, run_id: bravoRun },
		]);
		expect(
			terminals(completed, "claude").map(({ metadata }) => metadata.runId),
		).toEqual([alphaRun, bravoRun]);
		const firstEnd = terminals(completed, "claude")[0];
		const bravoStarted = completed.events.find(
			(event) =>
				event.type === "run.started" && event.data["inputId"] === bravo,
		);
		expect(firstEnd?.sequence).toBeLessThan(bravoStarted?.sequence ?? 0);
		proof["completed"] = normalized(completed, "claude");
	}, 60_000);

	it("closes back-to-back Claude turns exactly once on their own run", async () => {
		proof = { case: "claude-back-to-back", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({ restartProof: true });
		harness = fixture;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Consecutive Claude runs");
		await browser.followSession(sessionId);
		for (const text of ["first-owned-run", "second-owned-run"]) {
			const cursor = browser.frames.length;
			const inputId = await submit(browser, sessionId, text);
			try {
				await browser.waitForTurnEnd(sessionId, cursor, 15_000, inputId);
			} finally {
				proof[text] = normalized(ledger(fixture, sessionId), "claude");
				const row = browser.frames
					.map(({ message }) => message)
					.filter(
						(message) =>
							message["type"] === "session_row" && message["id"] === sessionId,
					)
					.at(-1);
				proof[`${text}-shell`] = {
					status: row?.["status"],
					endedOwnInput: row?.["lastTurnEndInputId"] === inputId,
				};
			}
		}
		const completed = ledger(fixture, sessionId);
		expect(completed.turns.map(({ state }) => state)).toEqual([
			"completed",
			"completed",
		]);
		expect(completed.runs.map(({ status }) => status)).toEqual([
			"completed",
			"completed",
		]);
		expect(completed.turns.map(({ run_id }) => run_id)).toEqual(
			completed.runs.map(({ id }) => id),
		);
		expect(
			terminals(completed, "claude").map(({ metadata }) => metadata.runId),
		).toEqual(completed.runs.map(({ id }) => id));
		expect(completed.queued).toEqual([]);
		proof["completed"] = normalized(completed, "claude");
	}, 60_000);

	it("keeps a finished Claude run closed when its background shell ends between turns", async () => {
		proof = {
			case: "claude-background-shell-between-turns",
			outcome: "failed",
		};
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			claudeReplay: {
				turns: [
					"background-shell-ends-between-turns",
					"pong-thinking-text-turn",
				],
			},
		});
		harness = fixture;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Background shell between runs",
		);
		await browser.followSession(sessionId);
		await submit(browser, sessionId, "Run sleep 8 in the background");
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				const firstEnd = terminals(state, "claude")[0];
				expect(firstEnd).toBeDefined();
				expect(
					state.events.filter(
						(event) =>
							event.type === "tool.started" &&
							event.sequence > (firstEnd?.sequence ?? Number.MAX_SAFE_INTEGER),
					),
				).toHaveLength(1);
			},
			{ timeout: 15_000 },
		);
		const shellEnded = ledger(fixture, sessionId);
		expect(shellEnded.turns.map(({ state }) => state)).toEqual(["completed"]);
		expect(shellEnded.runs.map(({ status }) => status)).toEqual(["completed"]);
		expect(shellEnded.queued).toEqual([]);
		proof["shellEnded"] = normalized(shellEnded, "claude");
		const nextInput = randomUUID();
		const cursor = browser.frames.length;
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: nextInput,
					text: "ping",
					delivery: "queue",
				}),
			),
		).toEqual({ ok: true, sessionId, handedOff: true });
		await browser.waitForTurnEnd(sessionId, cursor, 15_000, nextInput);
		const completed = ledger(fixture, sessionId);
		expect(completed.turns.map(({ state }) => state)).toEqual([
			"completed",
			"completed",
		]);
		expect(completed.runs.map(({ status }) => status)).toEqual([
			"completed",
			"completed",
		]);
		expect(
			terminals(completed, "claude").map(({ metadata }) => metadata.runId),
		).toEqual(completed.runs.map(({ id }) => id));
		expect(completed.queued).toEqual([]);
		proof["nextCompleted"] = normalized(completed, "claude");
	}, 60_000);

	it("leaves an OpenCode reply with an unknown parent unplaced", async () => {
		proof = { case: "opencode-unowned-reply", outcome: "failed" };
		cases.push(proof);
		const fixture = await ProcessHarness.start({
			managedOpenCode: true,
			managedOpenCodeId: MANAGED_OPENCODE_ACCOUNT_ID,
			autoStartOpenCode: true,
		});
		harness = fixture;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Unowned reply",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);
		writeFileSync(join(fixture.configDir, "fake-opencode-hold-turn"), "hold");
		await submit(browser, sessionId, "Owned prompt");
		let userId: string | undefined;
		await vi.waitFor(() => {
			const request = fixture
				.opencodeRequestBodies()
				.find(({ path }) => path === `/session/${sessionId}/prompt_async`);
			userId = (JSON.parse(request?.body ?? "{}") as { messageID?: string })
				.messageID;
			expect(userId).toBeTruthy();
		});
		const directory = realpathSync(fixture.projectDir);
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: randomUUID(),
				type: "message.updated",
				properties: {
					info: {
						id: userId,
						sessionID: sessionId,
						role: "user",
						time: { created: Date.now() },
					},
				},
			},
		});
		await vi.waitFor(() =>
			expect(
				ledger(fixture, sessionId).turns.map(({ state }) => state),
			).toEqual(["running"]),
		);
		const beforeUnowned = ledger(fixture, sessionId).session;
		const unownedId = `msg_${randomUUID()}`;
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: randomUUID(),
				type: "message.updated",
				properties: {
					info: {
						id: unownedId,
						sessionID: sessionId,
						role: "assistant",
						parentID: "unknown-provider-input",
						time: { created: Date.now(), completed: Date.now() },
						modelID: "fake-model",
						providerID: "fake",
						mode: "build",
						agent: "build",
						path: { cwd: directory, root: directory },
						cost: 0,
						tokens: {
							input: 1,
							output: 1,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						finish: "stop",
					},
				},
			},
		});
		await vi.waitFor(() => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare("SELECT turn_id FROM messages WHERE id = ?")
						.get(unownedId),
				).toEqual({ turn_id: null });
			} finally {
				db.close();
			}
		});
		const state = ledger(fixture, sessionId);
		expect(state.turns.map(({ state }) => state)).toEqual(["running"]);
		expect(state.session).toEqual(beforeUnowned);
		expect(terminals(state, "opencode")).toEqual([]);
		const replyEvents = state.events.filter(
			(event) => event.data["messageId"] === unownedId,
		);
		expect(replyEvents.length).toBeGreaterThan(0);
		expect(
			replyEvents.every(({ metadata }) => metadata.runId === undefined),
		).toBe(true);
		proof["unownedMessageTurn"] = null;
		proof["unownedTerminalAdvancedShell"] = false;
		proof["whileRunning"] = normalized(state, "opencode");
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		await vi.waitFor(() =>
			expect(
				ledger(fixture, sessionId).runs.map(({ status }) => status),
			).toEqual(["completed"]),
		);
	}, 60_000);

	it("closes back-to-back real OpenCode turns exactly once on their own run", async () => {
		proof = { case: "opencode-back-to-back", outcome: "failed" };
		cases.push(proof);
		const fixture = ProcessHarness.create({
			managedOpenCode: true,
			managedOpenCodeId: MANAGED_OPENCODE_ACCOUNT_ID,
			realOpenCode: resolveRealOpenCode(),
		});
		harness = fixture;
		modelServer = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const input = JSON.parse(body) as { stream?: boolean };
			const result = {
				id: "run-ownership-reply",
				created: 1,
				model: "owned",
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			};
			if (input.stream) {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				for (const [delta, finish_reason] of [
					[{ role: "assistant", content: "Run complete." }, null],
					[{}, "stop"],
				])
					response.write(
						`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
					);
				response.end("data: [DONE]\n\n");
			} else {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						...result,
						object: "chat.completion",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "Run complete." },
								finish_reason: "stop",
							},
						],
					}),
				);
			}
		});
		await new Promise<void>((resolve) =>
			modelServer?.listen(0, "127.0.0.1", resolve),
		);
		const address = modelServer.address();
		if (!address || typeof address === "string")
			throw new Error("Missing model port");
		const seed = Result.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		);
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify({
				...seed,
				instances: seed?.instances?.map((instance) => ({
					...instance,
					env: {
						...instance.env,
						OPENCODE_CONFIG_CONTENT: JSON.stringify({
							enabled_providers: ["ownership-test"],
							model: "ownership-test/owned",
							small_model: "ownership-test/owned",
							provider: {
								"ownership-test": {
									npm: "@ai-sdk/openai-compatible",
									options: {
										baseURL: `http://127.0.0.1:${address.port}/v1`,
										apiKey: "test",
									},
									models: {
										owned: {
											name: "Owned run",
											limit: { context: 16384, output: 1024 },
										},
									},
								},
							},
						}),
					},
				})),
			}),
		);
		await fixture.restart();
		const browser = await fixture.connect();
		await vi.waitFor(() => browser.startInstance(MANAGED_OPENCODE_ACCOUNT_ID), {
			timeout: 60_000,
			interval: 500,
		});
		const sessionId = await browser.createSession(
			"Consecutive OpenCode runs",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
			{ modelProviderId: "ownership-test", modelId: "owned" },
		);
		await browser.followSession(sessionId);
		for (const text of ["first-owned-run", "second-owned-run"]) {
			const cursor = browser.frames.length;
			const inputId = await submit(browser, sessionId, text);
			await browser.waitForTurnEnd(sessionId, cursor, 30_000, inputId);
		}
		const completed = ledger(fixture, sessionId);
		expect(completed.turns.map(({ state }) => state)).toEqual([
			"completed",
			"completed",
		]);
		expect(completed.runs.map(({ status }) => status)).toEqual([
			"completed",
			"completed",
		]);
		expect(completed.turns.map(({ run_id }) => run_id)).toEqual(
			completed.runs.map(({ id }) => id),
		);
		expect(
			terminals(completed, "opencode").map(({ metadata }) => metadata.runId),
		).toEqual(completed.runs.map(({ id }) => id));
		expect(completed.queued).toEqual([]);
		proof["completed"] = normalized(completed, "opencode");
	}, 120_000);
});
