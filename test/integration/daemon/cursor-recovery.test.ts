import { randomUUID } from "node:crypto";
// Failure modes: duplicate provider sends after replay, lost pre-send agent identity,
// orphaned active runs, force against a live controller, divergent restart events,
// idle/upgrade interrupting a turn, unbounded send journals, premature pruning,
// and deleted agents surviving in the owned store.
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	cursorSessionStorePath,
	readCursorSessionIdentity,
} from "../../../src/lib/provider/cursor/cursor-session-recovery.js";
import {
	RUNNER_PROTOCOL_VERSION,
	type RunnerHello,
	RunnerSocket,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import type { SessionTurn } from "../../../src/lib/provider/runner/session-runner.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: unknown;
	[key: string]: unknown;
}

const TIMEOUT = 120_000;
const EVIDENCE = "test-results/conduit-test-xqsg.6.json";

function rows(path: string): TraceRow[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as TraceRow)
		: [];
}

function persisted(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare<[string], { type: string; data: string }>(
					"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId)
				.map(({ type, data }) => ({
					type,
					data: JSON.parse(data) as Record<string, unknown>,
				})),
			turns: db
				.prepare<[string], { state: string }>(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId)
				.map(({ state }) => state),
			commands: db
				.prepare<
					[string],
					{
						command_id: string;
						run_id: string;
						attempt_count: number;
						status: string;
						error_code: string | null;
						payload_json: string;
					}
				>(
					"SELECT command_id, run_id, attempt_count, status, error_code, payload_json FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
			sessions: db
				.prepare<[string], { count: number }>(
					"SELECT COUNT(*) AS count FROM sessions WHERE id = ?",
				)
				.get(sessionId)?.count,
		};
	} finally {
		db.close();
	}
}

function comparable(
	events: ReturnType<typeof persisted>["events"],
	root: string,
): unknown {
	const ids = new Map<string, string>();
	return JSON.parse(
		JSON.stringify(events, (key, value: unknown) => {
			if (
				/^(createdAt|startedAt|completedAt|timestamp|duration|durationMs)$/.test(
					key,
				)
			)
				return "<clock>";
			if (typeof value !== "string") return value;
			return value
				.replaceAll(root, "<root>")
				.replace(
					/ses_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
					(id) => {
						if (!ids.has(id)) ids.set(id, `id-${ids.size}`);
						return ids.get(id) ?? id;
					},
				);
		}),
	) as unknown;
}

describe("Cursor recovery through the built daemon and detached runner", () => {
	const fixtures: ProcessHarness[] = [];
	const scenarios: Record<string, unknown>[] = [];
	const contexts: {
		fixture: ProcessHarness;
		id: string;
		capture: string;
		source: string;
	}[] = [];

	async function start(
		source = "basic",
		options: {
			streamGate?: boolean;
			sendGate?: boolean;
			idleMs?: number;
			buildId?: string;
			holdBeforeSend?: boolean;
		} = {},
	) {
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			...(options.holdBeforeSend
				? { holdRunnerOutput: "send-turn" as const }
				: {}),
			runnerLifecycle: { idleTimeoutMs: options.idleMs ?? null },
			...(options.buildId ? { buildId: options.buildId } : {}),
		});
		fixtures.push(fixture);
		const trace = join(fixture.root, "cursor-replay.jsonl");
		const capture = join(fixture.root, "cursor-capture.jsonl");
		const streamGate = join(fixture.root, "stream.gate");
		const sendGate = join(fixture.root, "send.gate");
		const replay = rows(
			resolve(`test/fixtures/cursor-sdk-traces/${source}.jsonl`),
		);
		if (!replay.some(({ kind }) => kind === "models.list")) {
			const catalog = rows(
				resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
			).find(({ kind }) => kind === "models.list");
			if (!catalog) throw new Error("Missing captured model catalog");
			replay.splice(1, 0, catalog);
		}
		replay.splice(1, 0, {
			kind: "credential.store",
			data: {
				apiKey: "[REDACTED]",
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		});
		writeFileSync(
			trace,
			`${replay.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		if (options.streamGate) writeFileSync(streamGate, "hold");
		if (options.sendGate) writeFileSync(sendGate, "hold");
		const restart = (overrides: { buildId?: string } = {}) =>
			fixture.restart({
				startupTimeoutMs: TIMEOUT,
				runnerStartupTimeoutMs: TIMEOUT,
				...overrides,
				serviceEnvironment: {
					CONDUIT_CURSOR_SDK_TRACE: trace,
					CONDUIT_CURSOR_SDK_CAPTURE: capture,
					CONDUIT_TEST_CURSOR_STREAM_GATE: streamGate,
					CONDUIT_TEST_CURSOR_SEND_GATE: sendGate,
				},
			});
		await restart();
		const account = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor recovery replay",
			driver: "cursor",
		});
		if (!account.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const id = await browser.createSession(
			"Cursor recovery",
			account.addedInstanceId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "", permissionMode: "full" },
		);
		contexts.push({ fixture, id, capture, source });
		return {
			fixture,
			browser,
			id,
			capture,
			streamGate,
			sendGate,
			trace,
			accountId: account.addedInstanceId,
			restart,
		};
	}

	async function turns(
		fixture: ProcessHarness,
		id: string,
		expected: readonly string[],
	) {
		await vi.waitFor(
			() => expect(persisted(fixture, id).turns).toEqual(expected),
			{ timeout: TIMEOUT, interval: 100 },
		);
	}

	function runner(fixture: ProcessHarness, id: string) {
		const mark = fixture.marks
			.filter(
				(entry) => entry.kind === "runner-started" && entry.sessionId === id,
			)
			.at(-1);
		if (mark?.kind !== "runner-started")
			throw new Error("Missing owned runner PID");
		return mark;
	}

	function journal(fixture: ProcessHarness, id: string) {
		const owned = fixture.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === id,
		);
		if (owned?.kind !== "runner-started") return [];
		const directory = join(dirname(owned.socketPath), "sends", id);
		if (!existsSync(directory)) return [];
		const commandIds = new Set(
			persisted(fixture, id).commands.map(({ command_id }) => command_id),
		);
		return readdirSync(directory)
			.map(
				(file) =>
					JSON.parse(readFileSync(join(directory, file), "utf8")) as Record<
						string,
						unknown
					>,
			)
			.filter((record) => commandIds.has(String(record["commandId"])));
	}

	function prunedJournal(fixture: ProcessHarness, id: string) {
		return rows(join(fixture.root, "sdk-proof.ndjson"))
			.filter(
				(row) => row.kind === "runner-send-pruned" && row["sessionId"] === id,
			)
			.flatMap((row) => row["records"] as Record<string, unknown>[]);
	}

	async function replayCommand(fixture: ProcessHarness, id: string) {
		const owned = runner(fixture, id);
		const command = persisted(fixture, id).commands[0];
		if (!command) throw new Error("Missing admitted command");
		const socket = createConnection(owned.socketPath);
		let peer: RunnerSocket | undefined;
		let acceptedCount = 0;
		let accept: () => void = () => {};
		const accepted = new Promise<void>((done) => {
			accept = done;
		});
		let settle: (commands: NonNullable<RunnerHello["sendCommands"]>) => void =
			() => {};
		const settled = new Promise<NonNullable<RunnerHello["sendCommands"]>>(
			(done) => {
				settle = done;
			},
		);
		const greeted = new Promise<RunnerHello>((done, fail) => {
			peer = new RunnerSocket(
				socket,
				(message) => {
					if (message.type === "hello") done(message);
					if (message.type === "command-accepted" && ++acceptedCount === 2)
						accept();
					if (message.type === "settled-commands-ack") settle(message.commands);
				},
				(failure) => fail(new Error(failure.message)),
			);
			socket.once("connect", () =>
				peer?.write({
					type: "hello",
					driverKind: "cursor",
					protocolVersion: RUNNER_PROTOCOL_VERSION,
					buildId: owned.buildId,
					config: {
						workspaceRoot: fixture.projectDir,
						daemonConfigDir: fixture.configDir,
					},
				}),
			);
		});
		try {
			const hello = await Effect.runPromise(
				Effect.tryPromise(() => greeted).pipe(Effect.timeout("30 seconds")),
			);
			const sinkId = hello.bindings?.find(
				(binding) => binding.commandId === command.command_id,
			)?.sinkId;
			if (!sinkId || !peer) throw new Error("Missing live command binding");
			// The old runner's Deferred must absorb both deliveries before reattachment.
			for (let attempt = 0; attempt < 2; attempt++)
				peer.write({
					type: "command",
					commandId: command.command_id,
					attempt: command.attempt_count,
					command: {
						type: "send-turn",
						aborted: false,
						sinkId,
						input: {
							...(JSON.parse(command.payload_json) as SessionTurn),
							runId: command.run_id,
						},
					},
				});
			await Effect.runPromise(
				Effect.tryPromise(() => accepted).pipe(Effect.timeout("30 seconds")),
			);
			const before = journal(fixture, id);
			expect(before).toMatchObject([{ attempt: command.attempt_count }]);
			const stale = [
				{ commandId: command.command_id, attempt: command.attempt_count - 1 },
			];
			peer.write({ type: "settled-commands", commands: stale });
			expect(
				await Effect.runPromise(
					Effect.tryPromise(() => settled).pipe(Effect.timeout("30 seconds")),
				),
			).toEqual(stale);
			expect(journal(fixture, id)).toEqual(before);
			scenarios.push({
				scenario: "stale completion acknowledgement",
				activeAttempt: command.attempt_count,
				acknowledged: stale,
				preservedJournal: before,
			});
		} finally {
			peer?.destroy();
			socket.destroy();
		}
	}

	afterEach(async ({ task }) => {
		for (const context of contexts) {
			const state = persisted(context.fixture, context.id);
			scenarios.push({
				scenario: task.name,
				result: task.result?.state,
				sourceCapture: context.source,
				storedEvents: state.events,
				turnStatuses: state.turns,
				commandStatuses: state.commands.map(({ status }) => status),
				commandErrors: state.commands.map(({ error_code }) => error_code),
				sendJournal: journal(context.fixture, context.id),
				prunedSendJournal: prunedJournal(context.fixture, context.id),
				operations: rows(context.capture).filter(({ kind }) =>
					[
						"created",
						"resumed",
						"send.options",
						"run.handle",
						"agent.delete",
						"agent.runs",
					].includes(kind ?? ""),
				),
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
			});
		}
		for (const fixture of fixtures) {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
			scenarios.push({
				scenario: "process-cleanup",
				runnerPids: fixture.runnerPids(),
				remainingRunnerPids: fixture.remainingRunnerPids(),
				rpcDecodeFailures: fixture.proof().rpcDecodeFailures,
				...(task.result?.errors?.length
					? { logTail: fixture.proof().logTail }
					: {}),
			});
		}
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			EVIDENCE,
			`${JSON.stringify({ ticket: "conduit-test-xqsg.6", scenarios }, null, 2)}\n`,
		);
		fixtures.length = 0;
		contexts.length = 0;
	});

	it(
		"matches uninterrupted stored events across daemon restart, replay and rebuild, retiring only once idle",
		async () => {
			const sequences: unknown[] = [];
			for (const mode of ["control", "restart", "rebuild"] as const) {
				const { fixture, browser, id, capture, streamGate, restart } =
					await start("basic", { streamGate: true, buildId: "xqsg6-before" });
				const pending = browser
					.send(id, "Say hi.", TIMEOUT)
					.catch(() => undefined);
				await vi.waitFor(
					() =>
						expect(
							persisted(fixture, id).events.some(
								({ type }) => type === "thinking.delta",
							),
						).toBe(true),
					{ timeout: TIMEOUT },
				);
				const original = runner(fixture, id);
				if (mode !== "control") {
					await fixture.kill();
					expect(() => process.kill(original.pid, 0)).not.toThrow();
					if (mode === "restart") await replayCommand(fixture, id);
					await restart({
						...(mode === "rebuild" ? { buildId: "xqsg6-after" } : {}),
					});
					expect(() => process.kill(original.pid, 0)).not.toThrow();
					expect(
						rows(capture).filter(({ kind }) => kind === "send.options"),
					).toHaveLength(1);
				}
				rmSync(streamGate);
				await turns(fixture, id, ["completed"]);
				await vi.waitFor(
					() =>
						expect(
							persisted(fixture, id).commands.every(
								({ status }) => status !== "running",
							),
						).toBe(true),
					{ timeout: TIMEOUT },
				);
				expect(
					persisted(fixture, id).commands.map(({ status }) => status),
				).toEqual(["completed"]);
				expect(
					rows(capture).filter(({ kind }) => kind === "send.options"),
				).toHaveLength(1);
				await vi.waitFor(
					() => {
						expect(prunedJournal(fixture, id)).toMatchObject([
							{
								providerRunId: expect.any(String),
								completedAt: expect.any(Number),
							},
						]);
						expect(journal(fixture, id)).toEqual([]);
					},
					{ timeout: TIMEOUT },
				);
				sequences.push(comparable(persisted(fixture, id).events, fixture.root));
				if (mode === "rebuild")
					await vi.waitFor(
						() => expect(() => process.kill(original.pid, 0)).toThrow(),
						{ timeout: TIMEOUT },
					);
				if (mode === "rebuild") {
					const identity = readCursorSessionIdentity(fixture.configDir, id);
					const reopened = await fixture.connect(id);
					const followup = await reopened.send(id, "Say hi again.", TIMEOUT);
					expect(followup.chunks.join("")).toBe(
						"Hi David — good to meet you. What would you like to work on today?",
					);
					await turns(fixture, id, ["completed", "completed"]);
					expect(runner(fixture, id).buildId).toBe("xqsg6-after");
					expect(
						readCursorSessionIdentity(fixture.configDir, id)?.agentId,
					).toBe(identity?.agentId);
				}
				if (mode === "control") await pending;
			}
			expect(sequences[1]).toEqual(sequences[0]);
			expect(sequences[2]).toEqual(sequences[0]);
			scenarios.push({
				scenario: "restart-event-parity",
				restartEqualsControl: true,
				rebuildEqualsControl: true,
				sendsPerScenario: 1,
				comparedSequences: sequences,
			});
		},
		TIMEOUT * 6,
	);

	it.each(["send", "stream"] as const)(
		"ends a SIGKILL during %s as an error without resending, then force-resumes the same agent",
		async (phase) => {
			const { fixture, browser, id, capture, sendGate, streamGate, restart } =
				await start("crashed-run", {
					sendGate: phase === "send",
					streamGate: phase === "stream",
				});
			const pending = browser
				.send(id, "Call hold once.", TIMEOUT)
				.catch(() => undefined);
			await vi.waitFor(
				() =>
					expect(
						rows(capture).filter(
							({ kind }) =>
								kind === (phase === "send" ? "send.options" : "run.handle"),
						),
					).toHaveLength(1),
				{ timeout: TIMEOUT },
			);
			if (phase === "send") {
				await vi.waitFor(
					() => {
						const state = JSON.parse(
							readFileSync(
								join(
									cursorSessionStorePath(fixture.configDir, id),
									"trace-state.json",
								),
								"utf8",
							),
						) as unknown;
						expect(state).toMatchObject({ activeRun: { status: "running" } });
					},
					{ timeout: TIMEOUT },
				);
			}
			if (phase === "stream")
				await vi.waitFor(
					() =>
						expect(
							persisted(fixture, id).events.some(
								({ type }) => type === "thinking.delta",
							),
						).toBe(true),
					{ timeout: TIMEOUT },
				);
			const identity = readCursorSessionIdentity(fixture.configDir, id);
			expect(identity?.agentId).toBeTruthy();
			if (phase === "stream")
				expect(journal(fixture, id)[0]?.["providerRunId"]).toEqual(
					(
						rows(capture).find(({ kind }) => kind === "run.handle")?.data as {
							id: string;
						}
					).id,
				);
			else expect(journal(fixture, id)[0]).not.toHaveProperty("providerRunId");
			const original = runner(fixture, id);
			process.kill(original.pid, "SIGKILL");
			await vi.waitFor(
				() => expect(() => process.kill(original.pid, 0)).toThrow(),
				{ timeout: TIMEOUT },
			);
			rmSync(sendGate, { force: true });
			rmSync(streamGate, { force: true });
			await turns(fixture, id, ["error"]);
			await fixture.kill();
			await restart();
			await turns(fixture, id, ["error"]);
			expect(
				rows(capture).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(1);
			const reopened = await fixture.connect(id);
			const followup = await reopened.send(
				id,
				"What was I asking you to do before the crash? One sentence.",
				TIMEOUT,
			);
			expect(followup.chunks.join("")).toBe(
				"You asked me to call the **hold** tool once.",
			);
			await turns(fixture, id, ["error", "completed"]);
			expect(readCursorSessionIdentity(fixture.configDir, id)?.agentId).toBe(
				identity?.agentId,
			);
			expect(
				rows(capture).filter(({ kind }) => kind === "created"),
			).toHaveLength(1);
			expect(
				rows(capture).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(2);
			expect(
				rows(capture)
					.filter(({ kind }) => kind === "send.options")
					.at(-1)?.data,
			).toMatchObject({ options: { local: { force: true } } });
			expect(runner(fixture, id).pid).not.toBe(original.pid);
			await pending;
		},
		TIMEOUT * 3,
	);

	it(
		"refuses force while the persisted controller is alive and leaves its turn running",
		async () => {
			const { fixture, browser, id, capture, streamGate, accountId } =
				await start("workspace-resume", { streamGate: true });
			const pending = browser
				.send(id, "Remember the code word marble7931. Say saved.", TIMEOUT)
				.catch(() => undefined);
			await vi.waitFor(
				() =>
					expect(
						persisted(fixture, id).events.some(
							({ type }) => type === "thinking.delta",
						),
					).toBe(true),
				{ timeout: TIMEOUT },
			);
			const live = runner(fixture, id);
			const other = await browser.createSession(
				"Copied live controller",
				accountId,
				"cursor",
				{ modelId: "composer-2.5", contextWindow: "", permissionMode: "full" },
			);
			cpSync(
				cursorSessionStorePath(fixture.configDir, id),
				cursorSessionStorePath(fixture.configDir, other),
				{ recursive: true },
			);
			contexts.push({
				fixture,
				id: other,
				capture,
				source: "workspace-resume:held-store-copy",
			});
			// This failure precedes intake, so it has no answered-input completion.
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: other,
					originId: browser.originId,
					inputId: randomUUID(),
					delivery: "queue",
					text: "What code word did I give you?",
				}),
			);
			await turns(fixture, other, ["error"]);
			expect(
				persisted(fixture, other).events.find(
					({ type }) => type === "turn.error",
				)?.data["error"],
			).toContain("has not exited; retry after it stops");
			expect(() => process.kill(live.pid, 0)).not.toThrow();
			expect(persisted(fixture, id).turns).toEqual(["running"]);
			expect(
				rows(capture).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(1);
			rmSync(streamGate);
			await pending;
			await turns(fixture, id, ["completed"]);
		},
		TIMEOUT * 3,
	);

	it(
		"sends a persisted never-sent queued run without force despite public running status",
		async () => {
			const { fixture, browser, id, capture } = await start("turn-never-sent");
			const response = await browser.send(id, "Say hi.", TIMEOUT);
			expect(response.chunks.join("")).toBe(
				"Hi David — good to meet you. What would you like to work on today?",
			);
			await turns(fixture, id, ["completed"]);
			expect(
				rows(capture).find(({ kind }) => kind === "store.active-run")?.data,
			).toMatchObject({ status: "queued", requestId: null, startedAt: null });
			expect(
				rows(capture).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(1);
			expect(
				rows(capture).find(({ kind }) => kind === "send.options")?.data,
			).not.toMatchObject({ options: { local: { force: true } } });
		},
		TIMEOUT * 2,
	);

	it(
		"prunes a recovered admission that the runner had never seen before daemon restart",
		async () => {
			const { fixture, browser, id, capture, restart } = await start("basic", {
				holdBeforeSend: true,
			});
			const pending = browser
				.send(id, "Say hi.", TIMEOUT)
				.catch(() => undefined);
			await vi.waitFor(
				() => {
					expect(rows(join(fixture.root, "sdk-proof.ndjson"))).toContainEqual(
						expect.objectContaining({ kind: "held-output", type: "send-turn" }),
					);
				},
				{ timeout: TIMEOUT },
			);
			expect(journal(fixture, id)).toEqual([]);
			expect(
				rows(capture).filter(({ kind }) => kind === "send.options"),
			).toEqual([]);
			const original = await vi.waitFor(() => runner(fixture, id), {
				timeout: TIMEOUT,
			});
			await fixture.kill();
			await restart();
			await turns(fixture, id, ["completed"]);
			await vi.waitFor(
				() => {
					expect(prunedJournal(fixture, id)).toMatchObject([
						{
							providerRunId: expect.any(String),
							completedAt: expect.any(Number),
						},
					]);
					expect(journal(fixture, id)).toEqual([]);
				},
				{ timeout: TIMEOUT },
			);
			expect(runner(fixture, id).pid).toBe(original.pid);
			expect(
				rows(capture).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(1);
			await pending;
		},
		TIMEOUT * 3,
	);

	it(
		"prunes terminal sends while retaining another session's running fence through deletion",
		async () => {
			const { fixture, browser, id, accountId, capture, streamGate } =
				await start();
			await browser.send(id, "Say hi.", TIMEOUT);
			await turns(fixture, id, ["completed"]);
			await vi.waitFor(
				() => {
					expect(prunedJournal(fixture, id)).toMatchObject([
						{ completedAt: expect.any(Number) },
					]);
					expect(journal(fixture, id)).toEqual([]);
				},
				{ timeout: TIMEOUT },
			);
			const other = await browser.createSession(
				"Still running",
				accountId,
				"cursor",
				{
					modelId: "composer-2.5",
					contextWindow: "",
					permissionMode: "full",
				},
			);
			contexts.push({ fixture, id: other, capture, source: "basic" });
			writeFileSync(streamGate, "hold");
			const pending = browser.send(other, "Say hi.", TIMEOUT);
			await vi.waitFor(
				() => {
					expect(journal(fixture, other)).toMatchObject([
						{ providerRunId: expect.any(String) },
					]);
					expect(
						persisted(fixture, other).commands.map(({ status }) => status),
					).toEqual(["running"]);
				},
				{ timeout: TIMEOUT },
			);
			const unfinished = journal(fixture, other);
			expect(unfinished[0]).toMatchObject({
				completedAt: expect.any(Number),
				result: { status: "accepted" },
			});
			await browser.deleteSession(id);
			await vi.waitFor(
				() => {
					expect(
						existsSync(
							join(dirname(runner(fixture, id).socketPath), "sends", id),
						),
					).toBe(false);
				},
				{ timeout: TIMEOUT },
			);
			expect(journal(fixture, other)).toEqual(unfinished);
			expect(existsSync(cursorSessionStorePath(fixture.configDir, other))).toBe(
				true,
			);
			expect(() => process.kill(runner(fixture, other).pid, 0)).not.toThrow();
			rmSync(streamGate);
			await pending;
			await turns(fixture, other, ["completed"]);
			await vi.waitFor(() => expect(journal(fixture, other)).toEqual([]), {
				timeout: TIMEOUT,
			});
			expect(
				rows(capture).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(2);
			expect(
				rows(capture).filter(({ kind }) => kind === "agent.delete"),
			).toHaveLength(1);
		},
		TIMEOUT * 3,
	);

	it(
		"resumes the owned agent after idle exit, leaves rename local and deletes its stored agent",
		async () => {
			const { fixture, browser, id, capture } = await start(
				"workspace-resume",
				{ idleMs: 500 },
			);
			await browser.send(
				id,
				"Remember the code word marble7931. Say saved.",
				TIMEOUT,
			);
			await turns(fixture, id, ["completed"]);
			const identity = readCursorSessionIdentity(fixture.configDir, id);
			const original = runner(fixture, id);
			await vi.waitFor(
				() => expect(() => process.kill(original.pid, 0)).toThrow(),
				{ timeout: TIMEOUT },
			);
			const followup = await browser.send(
				id,
				"What code word did I give you?",
				TIMEOUT,
			);
			expect(followup.chunks.join("")).toContain("marble7931");
			await turns(fixture, id, ["completed", "completed"]);
			expect(readCursorSessionIdentity(fixture.configDir, id)?.agentId).toBe(
				identity?.agentId,
			);
			expect(runner(fixture, id).pid).not.toBe(original.pid);
			expect(
				rows(capture).filter(({ kind }) => kind === "created"),
			).toHaveLength(1);
			expect(
				rows(capture)
					.filter(({ kind }) => kind === "send.options")
					.at(-1)?.data,
			).not.toMatchObject({ options: { local: { force: true } } });
			const beforeRename = rows(capture).length;
			await fixture.requestRpc({
				_tag: "RenameSession",
				sessionId: id,
				title: "Renamed locally",
				originId: browser.originId,
			});
			expect(
				rows(capture)
					.slice(beforeRename)
					.filter(({ kind }) => kind === "agent.delete"),
			).toEqual([]);
			const storePath = cursorSessionStorePath(fixture.configDir, id);
			const journalPath = join(dirname(original.socketPath), "sends", id);
			expect(existsSync(storePath)).toBe(true);
			expect(existsSync(journalPath)).toBe(true);
			await browser.deleteSession(id);
			await vi.waitFor(() => expect(existsSync(storePath)).toBe(false), {
				timeout: TIMEOUT,
			});
			await vi.waitFor(() => expect(existsSync(journalPath)).toBe(false), {
				timeout: TIMEOUT,
			});
			expect(persisted(fixture, id).sessions).toBe(0);
			expect(
				rows(capture).filter(({ kind }) => kind === "agent.delete"),
			).toHaveLength(1);
		},
		TIMEOUT * 3,
	);
});
