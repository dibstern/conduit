// Failure modes: duplicate stream content, terminal hints overriding wait,
// lost resume identity, stale agent options, dropped cancellation, auth hangs,
// unknown tools breaking replay, malformed updates aborting a valid turn,
// and image bytes or stored file parts disappearing at the runner boundary.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetailItemSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { attachmentFromDataUrl } from "../../../src/lib/persistence/attachment-store.js";

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
	metadata: Record<string, unknown> & {
		providerRefs?: Readonly<Record<string, unknown>>;
	};
}

const BASIC_TEXT =
	"Hi David — good to meet you. What would you like to work on today?";
const TIMEOUT = 90_000;

function traceRows(path: string): TraceRow[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceRow);
}

function snapshot(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const events = db
			.prepare<[string], { type: string; data: string; metadata: string }>(
				"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(sessionId)
			.map<StoredEvent>((event) => ({
				type: event.type,
				data: JSON.parse(event.data) as Record<string, unknown>,
				metadata: JSON.parse(event.metadata) as Record<string, unknown>,
			}));
		const runs = db
			.prepare<[string], { id: string; status: string }>(
				"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
			)
			.all(sessionId);
		const terminalErrors = events
			.filter(
				({ type, metadata }) =>
					type === "turn.error" &&
					runs.some(
						({ id, status }) => id === metadata["runId"] && status === "error",
					),
			)
			.filter(
				(event, index, errors) =>
					errors.findIndex(
						({ metadata }) => metadata["runId"] === event.metadata["runId"],
					) === index,
			);
		return {
			events,
			terminalErrors,
			eventCounts: events.reduce<Record<string, number>>((counts, event) => {
				counts[event.type] = (counts[event.type] ?? 0) + 1;
				return counts;
			}, {}),
			turns: db
				.prepare<
					[string],
					{ state: string; run_id: string | null; started_at: number | null }
				>(
					"SELECT state, run_id, started_at FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId),
			interactions: db
				.prepare<[string], { count: number }>(
					"SELECT COUNT(*) AS count FROM provider_command_interactions WHERE session_id = ?",
				)
				.get(sessionId)?.count,
			runs,
			commands: db
				.prepare<
					[string],
					{ input_id: string; run_id: string; status: string }
				>(
					"SELECT json_extract(payload_json, '$.inputId') AS input_id, run_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
		};
	} finally {
		db.close();
	}
}

describe("Cursor text turns through the built daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	let tracePath = "";
	let capturePath = "";
	let source = "basic";
	let credential: "present" | "rotated" | "missing" = "present";
	let sandboxFailure = false;
	let scenario = "setup";
	let diagnostics: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];

	function writeTrace() {
		const rows = traceRows(
			resolve(`test/fixtures/cursor-sdk-traces/${source}.jsonl`),
		);
		if (!rows.some(({ kind }) => kind === "models.list")) {
			const catalog = traceRows(
				resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
			).find(({ kind }) => kind === "models.list");
			if (!catalog) throw new Error("Basic capture has no model catalog");
			rows.splice(1, 0, catalog);
		}
		rows.splice(1, 0, {
			kind: "credential.store",
			data:
				credential === "missing"
					? null
					: {
							apiKey:
								credential === "rotated" ? "[REDACTED:rotated]" : "[REDACTED]",
							backendUrl: "https://api2.cursor.sh",
							createdAtMs: 0,
						},
		});
		if (sandboxFailure) {
			const failure = traceRows(
				resolve("test/fixtures/cursor-sdk-traces/sandbox-unprimed.jsonl"),
			).find(({ kind }) => kind === "sandbox.error");
			if (!failure) throw new Error("Sandbox capture has no failure");
			rows.splice(1, 0, { ...failure, kind: "sandbox.prime.error" });
		}
		writeFileSync(
			tracePath,
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}

	async function start(
		name: string,
		capture = "basic",
		permissionMode: "ask" | "full" = "ask",
		scheduling: { closeDelayMs?: number; disposeDelayMs?: number } = {},
	) {
		scenario = name;
		diagnostics = {};
		source = capture;
		credential = "present";
		sandboxFailure = false;
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		tracePath = join(harness.root, "cursor-replay.jsonl");
		capturePath = join(harness.root, "cursor-capture.jsonl");
		writeTrace();
		await harness.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				...(scheduling.closeDelayMs === undefined
					? {}
					: {
							CONDUIT_TEST_CURSOR_CLOSE_DELAY_MS: String(
								scheduling.closeDelayMs,
							),
						}),
				...(scheduling.disposeDelayMs === undefined
					? {}
					: {
							CONDUIT_TEST_CURSOR_DISPOSE_DELAY_MS: String(
								scheduling.disposeDelayMs,
							),
						}),
			},
		});
		const added = await harness.requestRpc({
			_tag: "AddInstance",
			name: "Cursor turn replay",
			driver: "cursor",
		});
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await harness.connect();
		sessionId = await browser.createSession(
			name,
			added.addedInstanceId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "", permissionMode },
		);
		return { fixture: harness, browser, id: sessionId };
	}

	function record(name: string, invariants: Record<string, boolean>) {
		if (!harness || !sessionId) throw new Error("No Cursor session");
		const state = snapshot(harness, sessionId);
		scenarios.push({
			scenario: name,
			sourceCapture: source,
			storedEventCounts: state.eventCounts,
			turnStatuses: state.turns.map(({ state: turnState }) => turnState),
			invariants,
		});
	}

	async function expectTurns(
		fixture: ProcessHarness,
		id: string,
		states: readonly string[],
	) {
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
					states,
				),
			{ timeout: TIMEOUT, interval: 100 },
		);
	}

	async function rejectBeforeIntake(
		fixture: ProcessHarness,
		browser: ProcessBrowser,
		id: string,
	) {
		const inputId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "queue",
					text: "Say hi.",
				}),
			),
		).toMatchObject({ ok: true });
		await vi.waitFor(
			() => {
				const state = snapshot(fixture, id);
				const command = state.commands.find((row) => row.input_id === inputId);
				if (!command) throw new Error("Missing rejected input reservation");
				expect(command).toMatchObject({ status: "failed" });
				expect(state.runs).toContainEqual({
					id: command.run_id,
					status: "error",
				});
				expect(
					state.runs.some(({ status }) =>
						["pending", "running"].includes(status),
					),
				).toBe(false);
				expect(state.events).toContainEqual(
					expect.objectContaining({
						type: "turn.error",
						metadata: expect.objectContaining({ runId: command.run_id }),
					}),
				);
				expect(state.eventCounts["run.started"] ?? 0).toBe(0);
				// Its exact terminal closes the input without inventing provider intake.
				expect(state.turns).toEqual([
					{ state: "error", run_id: command.run_id, started_at: null },
				]);
				diagnostics["preIntakeFailure"] = {
					runStatus: state.runs.find(({ id }) => id === command.run_id)?.status,
					commandStatus: command.status,
					errorCode: state.events.find(({ type }) => type === "turn.error")
						?.data["code"],
					errorOwnsReservation: state.events.some(
						(event) =>
							event.type === "turn.error" &&
							event.metadata["runId"] === command.run_id &&
							state.turns.some(
								(turn) =>
									turn.run_id === command.run_id &&
									turn.state === "error" &&
									turn.started_at === null,
							),
					),
					accepted: (state.eventCounts["run.started"] ?? 0) > 0,
					inboxBusy: state.runs.some(({ status }) =>
						["pending", "running"].includes(status),
					),
				};
			},
			{ timeout: TIMEOUT, interval: 100 },
		);
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
				scenario: `${scenario}:process-cleanup`,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
				diagnostics,
				storedEventCounts: state?.eventCounts,
				turnStatuses: state?.turns.map(({ state: turnState }) => turnState),
				capturedOperations: captured
					.filter(({ kind }) =>
						[
							"sandbox.prime.options",
							"create.options",
							"created",
							"resume.options",
							"resumed",
							"send.options",
							"wait.result",
							"cancel.call",
							"agent.disposed",
							"store.disposed.handles",
						].includes(kind ?? ""),
					)
					.map(({ kind, data }) => ({ kind, data })),
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
				"test-results/conduit-test-xqsg.5.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.5", scenarios }, null, 2)}\n`,
			);
			harness = undefined;
			sessionId = undefined;
		}
	});

	it("sends image bytes to Cursor and preserves their stored file parts", async () => {
		const { fixture, browser, id } = await start("image-attachments");
		const image =
			"data:image/png;name=pixel.png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=";
		const inputId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "queue",
					text: "Say hello",
					images: [image],
				}),
			),
		).toMatchObject({ ok: true });
		await expectTurns(fixture, id, ["completed"]);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					prompt: {
						text: "Say hello",
						images: [{ data: image.split(",")[1], mimeType: "image/png" }],
					},
				}),
			}),
		]);
		const userMessage = (await browser.history(id)).find(
			(message) => message.id === inputId && message.role === "user",
		);
		expect(userMessage?.parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: "Say hello" }),
				expect.objectContaining({
					type: "file",
					source: attachmentFromDataUrl(image).ref,
				}),
			]),
		);
		record("image-attachments", {
			imageBytesSent: true,
			storedFilePartPreserved: true,
		});
	}, 180_000);

	it("streams and resumes while reopening for folders, credentials and Ask → Full → Ask", async () => {
		const { fixture, browser, id } = await start("agent-lifecycle");
		const first = await browser.send(id, "Say hi.", TIMEOUT);
		expect(first.chunks.join("")).toBe(BASIC_TEXT);
		await expectTurns(fixture, id, ["completed"]);
		const firstState = snapshot(fixture, id);
		expect(firstState.eventCounts["thinking.delta"]).toBeGreaterThan(0);
		expect(firstState.eventCounts["text.delta"]).toBeGreaterThan(0);
		expect(firstState.eventCounts["turn.completed"]).toBe(1);
		expect(firstState.interactions).toBe(0);
		const acceptedRunId = firstState.events.find(
			({ type }) => type === "run.started",
		)?.metadata["runId"];
		expect(acceptedRunId).toEqual(expect.any(String));
		expect(firstState.events).toContainEqual(
			expect.objectContaining({
				type: "turn.completed",
				metadata: { runId: acceptedRunId },
			}),
		);
		const firstHistory = await browser.history(id);
		expect(
			firstHistory
				.flatMap(({ parts }) => parts ?? [])
				.some(
					(part) => part.type === "thinking" && part.text?.includes("say hi"),
				),
		).toBe(true);
		record("basic-turn", {
			textAndThinkingStreamed: true,
			textNotDuplicatedByStreamChannel: true,
			waitFinishedCompleted: true,
			requestNotInteraction: firstState.interactions === 0,
		});
		const runnerPids = fixture.runnerPids();
		expect(runnerPids).toHaveLength(1);
		const second = await browser.send(id, "Say hi again.", TIMEOUT);
		expect(second.chunks.join("")).toBe(BASIC_TEXT);
		await expectTurns(fixture, id, ["completed", "completed"]);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "resume.options"),
		).toHaveLength(1);
		record("resumed-second-turn", {
			sameRunner: true,
			agentResumed: true,
			completed: true,
		});

		const extra = join(fixture.root, "extra-folder");
		mkdirSync(extra);
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir, extra],
		});
		const afterFolders = await fixture.connect(id);
		expect(
			(
				await afterFolders.send(id, "Say hi with folders.", TIMEOUT)
			).chunks.join(""),
		).toBe(BASIC_TEXT);
		await expectTurns(fixture, id, ["completed", "completed", "completed"]);
		let resumes = traceRows(capturePath).filter(
			({ kind }) => kind === "resume.options",
		);
		expect(resumes.at(-1)?.data).toMatchObject({
			local: { cwd: fixture.projectDir, dirs: [extra] },
		});
		record("workspace-extra-folders-change", {
			reopened: true,
			fixedOriginalCwd: true,
			changedDirs: true,
		});

		credential = "rotated";
		writeTrace();
		expect(
			(
				await afterFolders.send(id, "Say hi after rotation.", TIMEOUT)
			).chunks.join(""),
		).toBe(BASIC_TEXT);
		await expectTurns(fixture, id, [
			"completed",
			"completed",
			"completed",
			"completed",
		]);
		const afterRotation = traceRows(capturePath).filter(
			({ kind }) => kind === "resume.options",
		);
		expect(afterRotation.length).toBeGreaterThan(resumes.length);
		const beforeOptions = resumes.at(-1)?.data as Record<string, unknown>;
		const rotatedOptions = afterRotation.at(-1)?.data as Record<
			string,
			unknown
		>;
		expect(rotatedOptions["credentialFingerprint"]).not.toBe(
			beforeOptions["credentialFingerprint"],
		);
		expect(rotatedOptions["credentialFingerprint"]).toEqual(expect.any(String));
		record("credential-change-live-runner", {
			reopened: true,
			changedFingerprint: true,
			sameRunner: true,
		});
		resumes = afterRotation;

		for (const [mode, count, autoReview] of [
			["full", 5, false],
			["ask", 6, true],
			["acceptEdits", 7, false],
			["auto", 8, true],
			["plan", 9, true],
		] as const) {
			await fixture.requestRpc({
				_tag: "SwitchPermissionMode",
				sessionId: id,
				mode,
				originId: afterFolders.originId,
			});
			expect(
				(
					await afterFolders.send(id, `Say hi in ${mode}.`, TIMEOUT)
				).chunks.join(""),
			).toBe(BASIC_TEXT);
			await expectTurns(
				fixture,
				id,
				Array.from({ length: count }, () => "completed"),
			);
			const next = traceRows(capturePath).filter(
				({ kind }) => kind === "resume.options",
			);
			expect(next.length).toBeGreaterThan(resumes.length);
			expect(next.at(-1)?.data).toMatchObject({
				local: {
					sandboxOptions: { enabled: mode !== "full" },
					autoReview,
				},
			});
			expect(
				traceRows(capturePath)
					.filter(({ kind }) => kind === "send.options")
					.at(-1)?.data,
			).toMatchObject({
				options: { mode: mode === "plan" ? "plan" : "agent" },
			});
			record(`permission-${mode}`, {
				reopened: true,
				sandboxMatchedMode: true,
				autoReviewMatchedMode: true,
				sendModeMatched: true,
			});
			resumes = next;
		}
		expect(fixture.runnerPids()).toEqual(runnerPids);
		await vi.waitFor(
			() =>
				expect(
					traceRows(capturePath).filter(
						({ kind }) => kind === "store.disposed.handles",
					),
				).toHaveLength(9),
			{ timeout: TIMEOUT },
		);
		const captured = traceRows(capturePath);
		expect(
			captured.filter(({ kind }) => kind === "create.options"),
		).toHaveLength(1);
		const creates = captured.filter(({ kind }) => kind === "created");
		const agentId = (creates[0]?.data as Record<string, unknown>)["agentId"];
		expect(agentId).toEqual(expect.any(String));
		for (const resume of resumes)
			expect(resume.data).toMatchObject({
				agentId,
				local: { cwd: fixture.projectDir },
			});
		for (const row of captured.filter(
			({ kind }) => kind === "create.options" || kind === "resume.options",
		)) {
			expect(row.data).toMatchObject({
				tools: expect.any(Array),
				disallowedTools: expect.any(Array),
				local: {
					settingSources: ["project", "user", "team", "mdm", "plugins"],
					customTools: expect.any(Array),
					subagentInherit: expect.any(Object),
					store: { stateRoot: expect.stringContaining(fixture.configDir) },
				},
			});
		}
		for (const row of captured.filter(({ kind }) => kind === "send.options"))
			expect(row.data).not.toHaveProperty("options.mcpServers");
		let agentCloses = 0;
		let storeDisposals = 0;
		for (const row of captured) {
			if (row.kind === "agent.disposed") agentCloses++;
			if (row.kind === "store.disposed.handles") {
				storeDisposals++;
				expect(agentCloses).toBeGreaterThanOrEqual(storeDisposals);
			}
		}
		expect(agentCloses).toBe(9);
		expect(storeDisposals).toBe(9);
		record("permission-ask-full-ask", {
			reopenedEachChange: true,
			sandboxMatchedMode: true,
			settingsExplicit: true,
			sameAgentId: true,
			sameRunner: true,
			storeUnderConduitConfig: true,
			noPerSendMcpOverride: true,
			agentClosedBeforeStoreEveryTurn: true,
		});
	}, 360_000);

	it("resumes the captured agent's remembered context on the second turn", async () => {
		const { fixture, browser, id } = await start(
			"remembered-context",
			"workspace-resume",
		);
		const first = await browser.send(
			id,
			"Remember the code word marble7931. Say saved.",
			TIMEOUT,
		);
		expect(first.chunks.join("")).toBe("saved.");
		const runnerPids = fixture.runnerPids();
		expect(runnerPids).toHaveLength(1);
		const second = await browser.send(
			id,
			"What code word did I give you?",
			TIMEOUT,
		);
		expect(second.chunks.join("")).toBe(
			"The code word you gave me is **marble7931**.",
		);
		await expectTurns(fixture, id, ["completed", "completed"]);
		const captured = traceRows(capturePath);
		const created = captured.filter(({ kind }) => kind === "created");
		const resumed = captured.filter(({ kind }) => kind === "resumed");
		expect(created).toHaveLength(1);
		expect(resumed).toHaveLength(1);
		expect(resumed[0]?.data).toEqual(created[0]?.data);
		expect(fixture.runnerPids()).toEqual(runnerPids);
		record("resumed-native-context", {
			rememberedCodeword: true,
			sameAgentId: true,
			sameRunner: true,
		});
	}, 240_000);

	it("delivers the next queued turn while prior SDK cleanup is delayed", async () => {
		const { fixture, browser, id } = await start(
			"queued-during-cleanup",
			"workspace-resume",
			"ask",
			{ closeDelayMs: 3000, disposeDelayMs: 3000 },
		);
		const prompts = [
			"Remember the code word marble7931. Say saved.",
			"What code word did I give you?",
		] as const;
		const firstInputId = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: id,
				originId: browser.originId,
				inputId: firstInputId,
				delivery: "queue",
				text: prompts[0],
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					traceRows(capturePath).filter(({ kind }) => kind === "close.call"),
				).toHaveLength(1),
			{ timeout: TIMEOUT, interval: 10 },
		);
		// close.call is emitted before playback waits. The first payload still
		// owns its agent/store, so this input must survive that cleanup boundary.
		diagnostics["stateAtSecondAdmission"] = snapshot(fixture, id);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "agent.disposed"),
		).toHaveLength(0);
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: id,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: prompts[1],
			}),
		);
		await expectTurns(fixture, id, ["completed", "completed"]);
		const state = snapshot(fixture, id);
		diagnostics["events"] = state.events;
		expect(state.eventCounts["input.admitted"]).toBe(2);
		expect(state.eventCounts["input.sent"]).toBe(2);
		expect(state.eventCounts["turn.completed"]).toBe(2);
		expect(state.eventCounts["turn.error"] ?? 0).toBe(0);
		const captured = traceRows(capturePath);
		expect(captured.filter(({ kind }) => kind === "send.options")).toHaveLength(
			2,
		);
		const created = captured.filter(({ kind }) => kind === "created");
		const resumed = captured.filter(({ kind }) => kind === "resumed");
		expect(created).toHaveLength(1);
		expect(resumed).toHaveLength(1);
		expect(resumed[0]?.data).toEqual(created[0]?.data);
		expect(fixture.runnerPids()).toHaveLength(1);
		const history = await browser.history(id);
		expect(
			history.filter(({ role }) => role === "user").map(({ text }) => text),
		).toEqual(prompts);
		expect(
			history
				.filter(({ role }) => role === "assistant")
				.map(({ text }) => text),
		).toEqual(["saved.", "The code word you gave me is **marble7931**."]);
		record("queued-turn-survives-delayed-cleanup", {
			secondAdmittedDuringCleanup: true,
			bothUserMessagesPlaced: true,
			twoSdkSends: true,
			twoCompletedTurns: true,
			rememberedContext: true,
			sameAgentId: true,
			sameRunner: true,
		});
	}, 240_000);

	it("exits after sandbox priming fails and retries successfully in a fresh runner", async () => {
		const { fixture, browser, id } = await start("sandbox-prime-failure");
		sandboxFailure = true;
		writeTrace();
		await rejectBeforeIntake(fixture, browser, id);
		const errors = snapshot(fixture, id).terminalErrors;
		diagnostics["sandboxError"] = errors;
		expect(errors).toHaveLength(1);
		expect(errors[0]?.data).toMatchObject({ code: "sandbox_unavailable" });
		expect(errors[0]?.data["error"]).toMatch(/sandbox.*restart/i);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toHaveLength(0);
		const failedPids = fixture.runnerPids();
		expect(failedPids).toHaveLength(1);
		await vi.waitFor(() => expect(fixture.remainingRunnerPids()).toEqual([]), {
			timeout: TIMEOUT,
			interval: 100,
		});
		sandboxFailure = false;
		writeTrace();
		expect((await browser.send(id, "Say hi.", TIMEOUT)).chunks.join("")).toBe(
			BASIC_TEXT,
		);
		await expectTurns(fixture, id, ["error", "completed"]);
		const allPids = fixture.runnerPids();
		expect(allPids).toHaveLength(2);
		expect(allPids.filter((pid) => !failedPids.includes(pid))).toHaveLength(1);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toHaveLength(1);
		record("sandbox-failure-requires-fresh-runner", {
			clearSandboxError: true,
			noUnsandboxedFallback: true,
			failedRunnerExited: true,
			retryUsedNewRunner: true,
			retryCompleted: true,
		});
	}, 240_000);

	it("primes sandbox support before the first unsandboxed Full agent", async () => {
		const { fixture, browser, id } = await start("full-first", "basic", "full");
		expect((await browser.send(id, "Say hi.", TIMEOUT)).chunks.join("")).toBe(
			BASIC_TEXT,
		);
		await expectTurns(fixture, id, ["completed"]);
		const captured = traceRows(capturePath);
		const primed = captured.findIndex(
			({ kind }) => kind === "sandbox.prime.options",
		);
		const opened = captured.findIndex(({ kind }) => kind === "create.options");
		expect(primed).toBeGreaterThanOrEqual(0);
		expect(primed).toBeLessThan(opened);
		expect(captured[primed]?.data).toMatchObject({
			local: { sandboxOptions: { enabled: true } },
		});
		expect(captured[opened]?.data).toMatchObject({
			local: { sandboxOptions: { enabled: false }, autoReview: false },
		});
		record("sandbox-prime-before-full", {
			primedBeforeUnsandboxedOpen: true,
			fullUnsandboxed: true,
		});
	}, 240_000);

	it("Stop before intake closes its exact pending input and pauses queued work", async () => {
		const { fixture, browser, id } = await start(
			"stop-before-intake",
			"cancel",
		);
		// Hold the recorded run before its RUNNING acknowledgement. Its wait
		// result still arrives only after the real runner calls cancel.
		writeFileSync(
			tracePath,
			`${traceRows(tracePath)
				.filter(
					(row) =>
						!(
							row.kind === "stream" &&
							typeof row.data === "object" &&
							row.data !== null &&
							"status" in row.data &&
							row.data.status === "RUNNING"
						),
				)
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		const inputId = randomUUID();
		const queuedId = randomUUID();
		const submit = (inputId: string) =>
			Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "queue",
					text: "Say done.",
				}),
			);
		await submit(inputId);
		await vi.waitFor(
			() => {
				const state = snapshot(fixture, id);
				const command = state.commands.find((row) => row.input_id === inputId);
				if (!command) throw new Error("Missing pending input reservation");
				expect(state.runs).toContainEqual({
					id: command.run_id,
					status: "pending",
				});
				expect(state.turns).toEqual([
					{ state: "pending", run_id: command.run_id, started_at: null },
				]);
				expect(
					traceRows(capturePath).some(({ kind }) => kind === "send.options"),
				).toBe(true);
			},
			{ timeout: TIMEOUT },
		);
		const reservation = snapshot(fixture, id).commands.find(
			(row) => row.input_id === inputId,
		);
		if (!reservation) throw new Error("Missing pending input reservation");
		const runId = reservation.run_id;
		await submit(queuedId);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
		);
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).runs).toEqual([
					{ id: runId, status: "interrupted" },
				]),
			{ timeout: TIMEOUT },
		);
		const state = snapshot(fixture, id);
		expect(state.turns).toEqual([
			{ state: "interrupted", run_id: runId, started_at: null },
		]);
		expect(state.eventCounts["run.started"] ?? 0).toBe(0);
		expect(
			state.events.filter(({ type }) => type === "turn.interrupted"),
		).toEqual([
			expect.objectContaining({ metadata: expect.objectContaining({ runId }) }),
		]);
		expect(state.commands).toEqual([
			{ input_id: inputId, run_id: runId, status: "failed" },
		]);
		await vi.waitFor(
			() => {
				const inbox = browser.frames
					.flatMap(({ message }) => {
						if (
							message["type"] !== "session_detail" ||
							message["sessionId"] !== id
						)
							return [];
						const items =
							message["_tag"] === "snapshot"
								? message["rows"]
								: [message["item"]];
						return Array.isArray(items)
							? items.flatMap((item: unknown) => {
									const decoded = Schema.decodeUnknownOption(
										SessionDetailItemSchema,
									)(item);
									return decoded._tag === "Some" &&
										decoded.value._tag === "inbox"
										? [decoded.value.inbox]
										: [];
								})
							: [];
					})
					.at(-1);
				expect(inbox?.paused).toBe(true);
			},
			{ timeout: TIMEOUT },
		);
		expect(snapshot(fixture, id).commands).toHaveLength(1);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toHaveLength(1);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT input_id, state FROM pending_inputs WHERE session_id = ? AND state = 'queued'",
					)
					.all(id),
			).toEqual([{ input_id: queuedId, state: "queued" }]);
		} finally {
			db.close();
		}
		record("stop-before-intake", {
			exactPendingInputInterrupted: true,
			queuePaused: true,
			noInventedIntake: true,
		});
	}, 240_000);

	it("cancels the captured active run and persists interrupted", async () => {
		const { fixture, browser, id } = await start("interrupt", "cancel");
		const inputId = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: id,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: "Call the human custom tool once, then say done.",
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, id).eventCounts["thinking.delta"],
				).toBeGreaterThan(0),
			{ timeout: TIMEOUT },
		);
		const active = snapshot(fixture, id);
		const command = active.commands.find((row) => row.input_id === inputId);
		if (!command) throw new Error("Missing accepted input reservation");
		expect(active.runs).toContainEqual({
			id: command.run_id,
			status: "running",
		});
		expect(active.turns).toEqual([
			{
				state: "running",
				run_id: command.run_id,
				started_at: expect.any(Number),
			},
		]);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
		);
		await expectTurns(fixture, id, ["interrupted"]);
		const interrupted = snapshot(fixture, id);
		expect(interrupted.eventCounts["turn.interrupted"]).toBe(1);
		expect(interrupted.runs).toContainEqual({
			id: command.run_id,
			status: "interrupted",
		});
		expect(interrupted.events).toContainEqual(
			expect.objectContaining({
				type: "turn.interrupted",
				metadata: expect.objectContaining({ runId: command.run_id }),
			}),
		);
		expect(
			traceRows(capturePath).some(({ kind }) => kind === "cancel.call"),
		).toBe(true);
		record("interrupt", { cancelCalled: true, waitCancelledInterrupted: true });
	}, 240_000);

	it("ends a send without credentials with an auth error", async () => {
		const { fixture, browser, id } = await start("missing-auth");
		credential = "missing";
		writeTrace();
		await rejectBeforeIntake(fixture, browser, id);
		const state = snapshot(fixture, id);
		const errors = state.events.filter(({ type }) => type === "turn.error");
		// Duplicate exact failure facts do not imply another terminal transition.
		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(state.runs).toEqual([
			{ id: state.commands[0]?.run_id, status: "error" },
		]);
		expect(new Set(errors.map(({ metadata }) => metadata["runId"]))).toEqual(
			new Set([state.commands[0]?.run_id]),
		);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			const terminal = db
				.prepare<[string], { completed_at: number; first_error_at: number }>(`
				SELECT run.completed_at, (SELECT created_at FROM events WHERE session_id = run.session_id
					AND type = 'turn.error' AND json_extract(metadata, '$.runId') = run.id ORDER BY sequence LIMIT 1) AS first_error_at
				FROM provider_runs run WHERE session_id = ?`)
				.get(id);
			expect(terminal?.completed_at).toBe(terminal?.first_error_at);
		} finally {
			db.close();
		}
		expect(errors[0]?.data["code"]).toMatch(/AUTH/i);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toEqual([]);
		record("missing-auth", {
			authError: true,
			noSdkSend: true,
			terminalNotHang: true,
		});
	}, 240_000);

	it("projects an unknown captured tool kind as a generic tool part", async () => {
		const { fixture, browser, id } = await start(
			"unknown-tool",
			"turn-unknown-tool",
		);
		await browser.send(id, "Run the recorded tool sequence.", TIMEOUT);
		await expectTurns(fixture, id, ["completed"]);
		const parts = (await browser.history(id)).flatMap(
			({ parts }) => parts ?? [],
		);
		diagnostics["parts"] = parts;
		diagnostics["toolEvents"] = snapshot(fixture, id).events.filter(
			({ type }) => type === "tool.started" || type === "tool.completed",
		);
		expect(parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "tool",
					tool: "future-tool",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({
							_tag: "whole",
							value: expect.objectContaining({
								tool: "Unknown",
								name: "future-tool",
							}),
						}),
					}),
				}),
			]),
		);
		expect(snapshot(fixture, id).eventCounts["tool.started"]).toBe(6);
		expect(snapshot(fixture, id).eventCounts["tool.completed"]).toBe(6);
		record("unknown-tool-generic-row", {
			genericCompletedToolPart: true,
			otherToolsPreserved: true,
		});
	}, 240_000);

	it("skips and reports a malformed delta while the captured wait completes", async () => {
		const { fixture, browser, id } = await start(
			"decode-failure",
			"turn-decode-failure",
		);
		expect((await browser.send(id, "Say hi.", TIMEOUT)).chunks.join("")).toBe(
			BASIC_TEXT,
		);
		await expectTurns(fixture, id, ["completed"]);
		expect(snapshot(fixture, id).eventCounts["thinking.delta"]).toBe(1);
		// Detached runners write their diagnostics before completing the turn.
		expect(
			readFileSync(join(fixture.configDir, "runners.log"), "utf8"),
		).toContain("Skipped malformed Cursor delta update");
		record("decode-failure-skipped-reported", {
			malformedUpdateSkipped: true,
			laterTextPreserved: true,
			reported: true,
			waitStillCompleted: true,
		});
	}, 240_000);

	it("errors when the stream closes with no authoritative wait terminal", async () => {
		const { fixture, browser, id } = await start(
			"missing-terminal",
			"turn-no-terminal",
		);
		await browser.send(id, "Say hi.", TIMEOUT);
		await expectTurns(fixture, id, ["error"]);
		const state = snapshot(fixture, id);
		expect(state.terminalErrors).toHaveLength(1);
		expect(state.eventCounts["turn.completed"] ?? 0).toBe(0);
		expect(
			JSON.stringify(state.events.filter(({ type }) => type === "turn.error")),
		).toMatch(/terminal/i);
		record("stream-without-terminal", {
			failedWithoutHanging: true,
			terminalHintsIgnored: true,
		});
	}, 240_000);
});
