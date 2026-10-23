import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Cause, Deferred, Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunnerSocket } from "../../../src/lib/provider/claude/claude-runner-protocol.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	RUNNER_PROTOCOL_VERSION,
	runnerIdleFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	discoverRunners,
	registerRunner,
	runnerDirectory,
} from "../../../src/lib/provider/runner/runner-registry.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { isRecord } from "../../../src/lib/utils.js";
import {
	cleanupTestClaudeRunners,
	testRunnerAlive,
} from "../../helpers/claude-runner-cleanup.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function snapshot(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), {
		readonly: true,
	});
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId),
			turns: db
				.prepare(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at",
				)
				.all(sessionId),
			commands: db
				.prepare(
					"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
			ends: db
				.prepare(
					"SELECT outbox.command_id, outbox.provider_process_id, outbox.status, outbox.attempt_count, receipt.status AS receipt_status FROM provider_command_outbox outbox JOIN command_receipts receipt ON receipt.command_id = outbox.command_id AND receipt.project_key = outbox.project_key WHERE outbox.session_id = ? AND outbox.effect_type = 'end_session' ORDER BY outbox.request_sequence",
				)
				.all(sessionId) as Array<{
				command_id: string;
				provider_process_id: string;
				status: string;
				attempt_count: number;
				receipt_status: string;
			}>,
			runReservations: (
				db
					.prepare(
						"SELECT run_id FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
					)
					.all(sessionId) as Array<{ run_id: string }>
			).map((row) => row.run_id),
			errorOwners: (
				db
					.prepare(
						"SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE session_id = ? AND type = 'turn.error' ORDER BY sequence",
					)
					.all(sessionId) as Array<{ run_id: string }>
			).map((row) => row.run_id),
			receipts: db
				.prepare(
					"SELECT receipt.status FROM command_receipts receipt JOIN provider_command_outbox outbox ON outbox.command_id = receipt.command_id WHERE outbox.session_id = ? AND outbox.effect_type = 'send_turn' ORDER BY outbox.request_sequence",
				)
				.all(sessionId),
			approvals: db
				.prepare(
					"SELECT id, type, status, decision, provider_process_id FROM pending_approvals WHERE session_id = ?",
				)
				.all(sessionId),
			promptResolutions: db
				.prepare(
					"SELECT type, json_extract(data, '$.id') AS id, json_extract(metadata, '$.source') AS source FROM events WHERE session_id = ? AND type IN ('permission.resolved', 'question.resolved') ORDER BY sequence",
				)
				.all(sessionId),
			queued: db
				.prepare(
					"SELECT input_id AS inputId FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at",
				)
				.all(sessionId) as Array<{ inputId: string }>,
			events: (
				db
					.prepare(
						"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId) as Array<{ type: string; data: string }>
			).map((event) => ({ ...event, data: JSON.parse(event.data) as unknown })),
		};
	} finally {
		db.close();
	}
}

function started(harness: ProcessHarness) {
	const runner = harness.marks
		.filter((mark) => mark.kind === "runner-started")
		.at(-1);
	if (runner?.kind !== "runner-started")
		throw new Error("Missing runner proof");
	return runner;
}

describe("Claude runner admission socket probes", () => {
	const probes: Array<Awaited<ReturnType<typeof probe>>> = [];

	async function probe(mode: "idle" | "reject" | "delayed", orphan = false) {
		// Runner test marks are plain IPC objects; Vitest's fork uses encoded IPC.
		const send = process.send;
		if (send)
			vi.spyOn(
				process as { send(message: unknown, ...args: unknown[]): boolean },
				"send",
			).mockImplementation((message, ...args) =>
				isRecord(message) && message["channel"] === "conduit-process-test"
					? true
					: Reflect.apply(send, process, [message, ...args]),
			);
		const root = mkdtempSync("/tmp/cw3-");
		const workspaceRoot = join(root, "project");
		const configDir = join(root, "config");
		for (const directory of [workspaceRoot, configDir, join(root, "home")])
			mkdirSync(directory, { recursive: true });
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
		vi.stubEnv("CONDUIT_CONFIG_DIR", configDir);
		// No build step emits dist/test, so spawned runners load the fake SDK
		// from source through tsx, as the process harness's runners do.
		vi.stubEnv(
			"NODE_OPTIONS",
			`--import ${pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href}`,
		);
		vi.stubEnv(
			"CONDUIT_TEST_CLAUDE_QUERY_MODULE",
			pathToFileURL(resolve("test/helpers/fake-claude-process-sdk.ts")).href,
		);
		const { BUILD_ID }: typeof import("../../../src/lib/build-id.js") =
			await import(pathToFileURL(resolve("dist/src/lib/build-id.js")).href);
		const {
			makeProcessClaudeSessionRunner,
		}: typeof import("../../../src/lib/provider/claude/claude-process-session-runner.js") =
			await import(
				pathToFileURL(
					resolve(
						"dist/src/lib/provider/claude/claude-process-session-runner.js",
					),
				).href
			);
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" },
		);
		const pid = child.pid;
		if (!pid) throw new Error("Missing probe process PID");
		const exited = new Promise<void>((done) =>
			child.once("exit", () => done()),
		);
		const sessionId = "socket-probe-session";
		const runnerId = "abcdefabcdef";
		const directory = runnerDirectory(workspaceRoot, configDir);
		mkdirSync(directory, { recursive: true });
		const socketPath = join(directory, runnerId);
		const sockets = new Set<Socket>();
		const commands: string[] = [];
		const helloRoots: Array<string | undefined> = [];
		const outputs: import("../../../src/lib/provider/runner/session-runner.js").SessionOutput[] =
			[];
		const received = await Effect.runPromise(Deferred.make<void>());
		const released = await Effect.runPromise(Deferred.make<void>());
		let attempts = 0;
		let rejecting = mode === "reject";
		let delayedPeer: ClaudeRunnerSocket | undefined;
		let activePeer: ClaudeRunnerSocket | undefined;
		const replyHello = (peer: ClaudeRunnerSocket) =>
			peer.write({
				type: "hello",
				protocolVersion: RUNNER_PROTOCOL_VERSION,
				buildId: BUILD_ID,
				stampsRunIds: true,
				runnerId,
				sessionId,
				pid,
			});
		let pending:
			| Extract<
					import("../../../src/lib/provider/runner/runner-protocol.js").RunnerMessage,
					{ type: "command" }
			  >
			| undefined;
		const server = createServer((socket) => {
			attempts++;
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			if (rejecting) {
				socket.once("data", () => {
					Deferred.doneUnsafe(received, Effect.void);
					socket.destroy();
				});
				return;
			}
			const peer = new ClaudeRunnerSocket(
				socket,
				(message) => {
					if (message.type === "output-reply")
						Deferred.doneUnsafe(released, Effect.void);
					if (message.type === "hello") {
						helloRoots.push(message.config?.workspaceRoot);
						if (mode === "delayed") {
							delayedPeer = peer;
							Deferred.doneUnsafe(received, Effect.void);
						} else replyHello(peer);
					}
					if (message.type !== "command") return;
					commands.push(message.command.type);
					if (message.command.type === "send-turn") {
						pending = message;
						Deferred.doneUnsafe(received, Effect.void);
					} else if (message.command.type === "end-session") {
						peer.write({ type: "idle-exit" });
						if (pending)
							peer.write({
								type: "command-reply",
								commandId: pending.commandId,
								failure: runnerIdleFailure(),
							});
						peer.write({
							type: "command-reply",
							commandId: message.commandId,
							failure: runnerIdleFailure(),
						});
					} else if (message.command.type === "shutdown") {
						void exited.then(() =>
							peer.write({
								type: "command-reply",
								commandId: message.commandId,
							}),
						);
						child.kill("SIGTERM");
					} else
						peer.write({ type: "command-reply", commandId: message.commandId });
				},
				() => {},
			);
			activePeer = peer;
		});
		await new Promise<void>((done, fail) => {
			server.once("error", fail);
			server.listen(socketPath, done);
		});
		registerRunner({
			runnerId,
			sessionId,
			socketPath,
			buildId: BUILD_ID,
			pid,
			...(orphan ? { role: "candidate" as const } : {}),
		});
		const runnerPids = new Set([pid]);
		const fixture = {
			root,
			workspaceRoot,
			configDir,
			child,
			exited,
			server,
			sockets,
			commands,
			helloRoots,
			outputs,
			received,
			released,
			runnerPids,
			releaseSink() {
				activePeer?.write({
					type: "output",
					outputId: "probe-release",
					sequence: 1,
					output: { type: "release-sink", sinkId: "probe-send" },
				});
			},
			get attempts() {
				return attempts;
			},
			allowHello() {
				rejecting = false;
				if (delayedPeer) replyHello(delayedPeer);
			},
			make: makeProcessClaudeSessionRunner(
				{
					projectRootForSession: () =>
						Effect.succeed(orphan ? undefined : workspaceRoot),
					daemonConfigDir: configDir,
				},
				(output) =>
					Effect.sync(() => {
						outputs.push(output);
						return {};
					}),
			),
			send: {
				type: "send-turn" as const,
				sinkId: "probe-send",
				aborted: false,
				input: {
					sessionId,
					inputId: "probe-user",
					prompt: "admission-respawn",
					history: [],
					providerState: {},
					workspaceRoot,
					configDir: configuredClaudeConfigDir(join(root, "claude")),
					folderSource: "account" as const,
					extraFolders: [],
					model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
				},
			},
			preWarm: {
				type: "pre-warm" as const,
				sessionId,
				input: {
					sessionId,
					workspaceRoot,
					configDir: configuredClaudeConfigDir(join(root, "claude")),
					folderSource: "account" as const,
					extraFolders: [],
					providerState: {},
				},
			},
			recordPids() {
				for (const entry of discoverRunners(workspaceRoot, configDir))
					runnerPids.add(entry.pid);
			},
		};
		return fixture;
	}

	afterEach(async (context) => {
		for (const fixture of probes.splice(0)) {
			if (testRunnerAlive(fixture.child.pid ?? 0))
				fixture.child.kill("SIGKILL");
			await fixture.exited;
			for (const socket of fixture.sockets) socket.destroy();
			await new Promise<void>((done) => fixture.server.close(() => done()));
			const cleanup = await cleanupTestClaudeRunners(
				fixture.root,
				[...fixture.runnerPids],
				fixture.configDir,
			);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/85kb-w3fix-${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify(
					{
						result: context.task.result?.state,
						attempts: fixture.attempts,
						commands: fixture.commands,
						helloRoots: fixture.helloRoots,
						outputs: fixture.outputs,
						cleanup,
					},
					null,
					2,
				),
			);
			for (const pid of fixture.runnerPids)
				expect(testRunnerAlive(pid)).toBe(false);
			rmSync(fixture.root, { recursive: true, force: true });
		}
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("retires an orphan candidate through an identity hello without starting provider work", async () => {
		const fixture = await probe("idle", true);
		probes.push(fixture);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* fixture.make;
					yield* runner.recoverEffect;
					expect(fixture.helloRoots).toEqual([fixture.configDir]);
					expect(fixture.commands).toEqual(["shutdown"]);
					expect(testRunnerAlive(fixture.child.pid ?? 0)).toBe(false);
				}),
			),
		);
	}, 15_000);

	it("releases a pending send's retained sink when its caller is cancelled", async () => {
		const fixture = await probe("idle");
		probes.push(fixture);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* fixture.make;
					yield* runner.recoverEffect;
					const send = yield* Effect.forkChild(
						runner.executeEffect(fixture.send),
					);
					yield* Deferred.await(fixture.received);
					fixture.releaseSink();
					yield* Deferred.await(fixture.released).pipe(
						Effect.timeout("2 seconds"),
					);
					expect(fixture.outputs).not.toContainEqual({
						type: "release-sink",
						sinkId: "probe-send",
					});
					yield* Fiber.interrupt(send);
					expect(fixture.outputs).toContainEqual({
						type: "release-sink",
						sinkId: "probe-send",
					});
				}),
			),
		);
	}, 15_000);

	it("settles end-session and respawns an unaccepted send refused by idle exit", async () => {
		const fixture = await probe("idle");
		probes.push(fixture);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* fixture.make;
					yield* runner.recoverEffect;
					const send = yield* Effect.forkChild(
						runner.executeEffect(fixture.send),
					);
					yield* Deferred.await(fixture.received);
					const end = yield* Effect.forkChild(
						Effect.result(
							runner.executeEffect({
								type: "end-session",
								sessionId: fixture.send.input.sessionId,
							}),
						),
					);
					const ended = yield* Fiber.join(end).pipe(
						Effect.timeout("6 seconds"),
					);
					expect(ended).toMatchObject({
						_tag: "Success",
					});
					// End succeeds only after the old process has actually stopped.
					expect(testRunnerAlive(fixture.child.pid ?? 0)).toBe(false);
					expect(fixture.commands).toEqual([
						"send-turn",
						"end-session",
						"shutdown",
					]);
					expect(
						(yield* Fiber.join(send).pipe(Effect.timeout("10 seconds"))).status,
					).toBe("accepted");
					fixture.recordPids();
					expect([...fixture.runnerPids]).toHaveLength(2);
					expect(
						fixture.outputs.some(
							(output) =>
								output.type === "event" && output.event.type === "turn.error",
						),
					).toBe(false);
				}),
			),
		);
	}, 30_000);

	it.each([
		"abort",
		"already-aborted",
		"interrupt",
		"continuation-interrupt",
	])("cancels an undelivered send during adoption via %s", async (mode) => {
		const fixture = await probe("delayed");
		probes.push(fixture);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* fixture.make;
					const recovery = yield* Effect.forkChild(runner.recoverEffect);
					yield* Deferred.await(fixture.received);
					const send = yield* Effect.forkChild(
						runner.executeEffect({
							...fixture.send,
							aborted: mode === "already-aborted",
							input: {
								...fixture.send.input,
								...(mode === "continuation-interrupt"
									? { continuation: { cutOffMessageId: "original-user" } }
									: {}),
							},
						}),
					);
					if (mode !== "already-aborted") {
						yield* Effect.sleep("20 millis");
						if (mode === "abort")
							yield* runner.executeEffect({
								type: "abort",
								sinkId: fixture.send.sinkId,
							});
						else {
							yield* Effect.forkChild(
								runner.executeEffect({
									type: "interrupt",
									sessionId: fixture.send.input.sessionId,
									turnIds: ["unrelated-input"],
								}),
							);
							yield* Effect.sleep("20 millis");
							expect(fixture.outputs).not.toContainEqual({
								type: "release-sink",
								sinkId: fixture.send.sinkId,
							});
							yield* Effect.forkChild(
								runner.executeEffect({
									type: "interrupt",
									sessionId: fixture.send.input.sessionId,
									turnIds: [
										mode === "continuation-interrupt"
											? "original-user"
											: fixture.send.input.inputId,
									],
								}),
							);
						}
					}
					expect(
						yield* Fiber.join(send).pipe(Effect.timeout("2 seconds")),
					).toMatchObject({ status: "cancelled" });
					expect(fixture.commands).not.toContain("send-turn");
					expect(fixture.outputs).toContainEqual({
						type: "release-sink",
						sinkId: fixture.send.sinkId,
					});
					fixture.allowHello();
					yield* Fiber.join(recovery);
					expect(fixture.commands).not.toContain("send-turn");
				}),
			),
		);
	}, 15_000);

	it("makes pre-warm a no-op while adoption is retrying", async () => {
		const fixture = await probe("reject");
		probes.push(fixture);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* fixture.make;
					const recovery = yield* Effect.forkChild(runner.recoverEffect);
					yield* Deferred.await(fixture.received);
					yield* runner
						.executeEffect(fixture.preWarm)
						.pipe(Effect.timeout("250 millis"));
					expect(fixture.commands).toEqual([]);
					fixture.child.kill("SIGTERM");
					yield* Effect.tryPromise(() => fixture.exited);
					yield* Fiber.join(recovery);
				}),
			),
		);
	}, 15_000);

	it("detaches a retrying adoption when its relay is disposed", async () => {
		const fixture = await probe("reject");
		probes.push(fixture);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* fixture.make;
					const recovery = yield* Effect.forkChild(
						Effect.exit(runner.recoverEffect),
					);
					yield* Deferred.await(fixture.received);
					yield* runner
						.executeEffect({ type: "shutdown" })
						.pipe(Effect.timeout("6 seconds"));
					const attempts = fixture.attempts;
					fixture.allowHello();
					yield* Fiber.join(recovery).pipe(Effect.timeout("4 seconds"));
					expect(fixture.attempts).toBe(attempts);
					expect(fixture.commands).toEqual([]);
					expect(testRunnerAlive(fixture.child.pid ?? 0)).toBe(true);
					expect(
						discoverRunners(fixture.workspaceRoot, fixture.configDir),
					).toHaveLength(1);
				}),
			),
		);
	}, 15_000);

	it("detaches a late verified adoption when its relay is disposed", async () => {
		const fixture = await probe("delayed");
		probes.push(fixture);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* fixture.make;
					const recovery = yield* Effect.forkChild(
						Effect.exit(runner.recoverEffect),
					);
					yield* Deferred.await(fixture.received);
					const disposal = yield* Effect.forkChild(
						runner
							.executeEffect({ type: "shutdown" })
							.pipe(Effect.timeout("6 seconds")),
					);
					yield* Effect.yieldNow;
					fixture.allowHello();
					yield* Fiber.join(disposal);
					yield* Fiber.join(recovery).pipe(Effect.timeout("6 seconds"));
					expect(fixture.commands).toEqual([]);
					expect(testRunnerAlive(fixture.child.pid ?? 0)).toBe(true);
					expect(
						discoverRunners(fixture.workspaceRoot, fixture.configDir),
					).toHaveLength(1);
				}),
			),
		);
	}, 15_000);

	it.each([
		"dead",
		"live",
		"interrupted",
	] as const)("settles a waiting send after %s adoption is abandoned", async (phase) => {
		const fixture = await probe("reject");
		probes.push(fixture);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* fixture.make;
					const recovery = yield* Effect.forkChild(
						Effect.result(runner.recoverEffect),
					);
					yield* Deferred.await(fixture.received);
					const send = yield* Effect.forkChild(
						Effect.exit(runner.executeEffect(fixture.send)),
					);
					yield* Effect.sleep("25 millis");
					if (phase === "dead") {
						fixture.child.kill("SIGTERM");
						yield* Effect.tryPromise(() => fixture.exited);
					} else if (phase === "interrupted") yield* Fiber.interrupt(recovery);
					if (phase !== "interrupted")
						yield* Fiber.join(recovery).pipe(Effect.timeout("4 seconds"));
					const result = yield* Fiber.join(send).pipe(
						Effect.timeout("10 seconds"),
					);
					fixture.recordPids();
					if (phase === "dead") {
						expect(result).toMatchObject({
							_tag: "Success",
							value: { status: "accepted" },
						});
						expect([...fixture.runnerPids]).toHaveLength(2);
					} else {
						expect(result._tag).toBe("Failure");
						if (phase === "interrupted" && result._tag === "Failure")
							expect(Cause.hasInterruptsOnly(result.cause)).toBe(true);
						expect([...fixture.runnerPids]).toHaveLength(1);
						expect(testRunnerAlive(fixture.child.pid ?? 0)).toBe(true);
					}
				}),
			),
		);
	}, 30_000);
});

// Adoption boots two daemons and two runners. Cold daemon loads have taken
// 22.9s under load, before cleanup or RPC work. All event waits share this budget.
const LIFECYCLE_TIMEOUT_MS = 120_000;

describe("built-dist Claude runner lifecycle", () => {
	const fixtures: Array<{ harness: ProcessHarness; sessionId?: string }> = [];
	afterEach(async (context) => {
		const evidence = fixtures.map(({ harness, sessionId }) => ({
			proof: harness.proof(),
			...(sessionId ? snapshot(harness, sessionId) : {}),
		}));
		for (const { harness } of fixtures) await harness.dispose();
		const runnerCleanup = fixtures.flatMap(({ harness }) =>
			[
				...new Set(
					harness.marks.flatMap((mark) =>
						mark.kind === "runner-spawned" || mark.kind === "runner-started"
							? [mark.pid]
							: [],
					),
				),
			].map((pid) => {
				let exited = false;
				try {
					process.kill(pid, 0);
				} catch (cause) {
					exited = isRecord(cause) && cause["code"] === "ESRCH";
				}
				expect(exited).toBe(true);
				return { pid, exited };
			}),
		);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/85kb-10-${context.task.name.replace(/\W+/g, "-")}.json`,
			JSON.stringify(
				{ result: context.task.result?.state, evidence, runnerCleanup },
				null,
				2,
			),
		);
		fixtures.length = 0;
	});

	function waitFor(
		harness: ProcessHarness,
		assertion: () => unknown,
		options: { timeout?: number } = {},
	) {
		return vi.waitFor(assertion, {
			timeout: harness.remainingTimeMs(options.timeout ?? 1000),
		});
	}

	async function start(
		runnerLifecycle?: NonNullable<
			Parameters<typeof ProcessHarness.start>[0]
		>["runnerLifecycle"],
	) {
		expect(existsSync("dist/src/bin/claude-session-runner.js")).toBe(true);
		const harness = ProcessHarness.create({
			dist: resolve("dist"),
			deadline: performance.now() + LIFECYCLE_TIMEOUT_MS,
			...(runnerLifecycle ? { runnerLifecycle } : {}),
		});
		const fixture: { harness: ProcessHarness; sessionId?: string } = {
			harness,
		};
		fixtures.push(fixture);
		await harness.restart();
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Runner lifecycle");
		fixture.sessionId = sessionId;
		return { harness, browser, sessionId };
	}

	it("settles the reservation and receipt when the SDK iterator fails before intake", async () => {
		const { harness, browser, sessionId } = await start();
		const sent = browser.send(sessionId, "fail-before-intake");
		void sent.catch(() => undefined);
		await sent;
		await waitFor(
			harness,
			() => {
				const state = snapshot(harness, sessionId);
				expect(state.commands).toEqual([{ status: "failed" }]);
				expect(state.receipts).toEqual([{ status: "side_effect_failed" }]);
				expect(state.turns).toEqual([{ state: "error" }]);
				expect(state.errorOwners).toEqual(state.runReservations);
				expect(state.events).toEqual(
					expect.arrayContaining([
						{
							type: "turn.error",
							data: expect.objectContaining({
								error: expect.stringContaining(
									"Harness SDK iterator failed before intake",
								),
							}),
						},
					]),
				);
				const db = new Database(harness.daemonStorePath(), {
					readonly: true,
				});
				try {
					expect(
						db
							.prepare(
								"SELECT status, started_at FROM provider_runs WHERE session_id = ?",
							)
							.all(sessionId),
					).toEqual([{ status: "error", started_at: null }]);
					expect(
						db
							.prepare("SELECT started_at FROM turns WHERE session_id = ?")
							.all(sessionId),
					).toEqual([{ started_at: null }]);
				} finally {
					db.close();
				}
			},
			{ timeout: 25_000 },
		);
	});

	it("reclaims a pre-warmed runner through the idle policy without a send", async () => {
		const { harness, browser, sessionId } = await start({
			idleTimeoutMs: 500,
		});
		await browser.preWarmSession(sessionId);
		await harness.waitForMark((mark) => mark.kind === "runner-started");
		const runner = started(harness);
		const query = harness.marks.find((mark) => mark.kind === "query");
		if (query?.kind !== "query")
			throw new Error("Missing pre-warm query proof");
		expect(query.pid).toBe(runner.pid);
		expect(
			harness.marks.some(
				(mark) =>
					mark.kind === "initialization-ready" &&
					mark.queryId === query.queryId,
			),
		).toBe(true);
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		await harness.waitForMark(
			(mark) =>
				mark.kind === "runner-idle-exit-started" && mark.pid === runner.pid,
		);
		await waitFor(
			harness,
			() => {
				expect(
					harness.marks.some(
						(mark) =>
							mark.kind === "runner-idle-exit-started" &&
							mark.pid === runner.pid,
					),
				).toBe(true);
				expect(() => process.kill(runner.pid, 0)).toThrow();
				expect(existsSync(runner.socketPath)).toBe(false);
				expect(
					harness.marks.some(
						(mark) =>
							mark.kind === "query-closed" && mark.queryId === query.queryId,
					),
				).toBe(true);
			},
			{ timeout: 5000 },
		);
		expect(harness.marks.some((mark) => mark.kind === "enqueue")).toBe(false);
		const state = snapshot(harness, sessionId);
		expect(state.turns).toEqual([]);
		expect(state.commands).toEqual([]);
		expect(state.events.some((event) => event.type === "turn.error")).toBe(
			false,
		);
	});

	it("exits after the idle window, resets it on activity, and respawns on send", async () => {
		const idleTimeoutMs = 1200;
		const { harness, browser, sessionId } = await start({ idleTimeoutMs });
		await browser.send(sessionId, "idle-first");
		const first = started(harness);
		await new Promise<void>((done) => setTimeout(done, 700));
		await browser.send(sessionId, "ambient-idle");
		expect(started(harness).pid).toBe(first.pid);
		await new Promise<void>((done) => setTimeout(done, 700));
		expect(() => process.kill(first.pid, 0)).not.toThrow();
		await waitFor(
			harness,
			() => {
				expect(() => process.kill(first.pid, 0)).toThrow();
				expect(existsSync(first.socketPath)).toBe(false);
			},
			{ timeout: 5000 },
		);
		expect(
			snapshot(harness, sessionId).events.some(
				(event) => event.type === "turn.error",
			),
		).toBe(false);
		const next = await browser.send(sessionId, "idle-restart");
		expect(next.chunks.join("")).toBe(responseChunks("idle-restart").join(""));
		expect(next.done["status"]).toBe("idle");
		expect(started(harness).pid).not.toBe(first.pid);
		await waitFor(harness, () =>
			expect(snapshot(harness, sessionId).commands).toEqual([
				{ status: "completed" },
				{ status: "completed" },
				{ status: "completed" },
			]),
		);
	});

	it("releases end-session admission when interrupted before runner readiness", async () => {
		const { harness, browser, sessionId } = await start({
			helloDelayMs: 3000,
		});
		const first = browser.send(sessionId, "before-interrupted-end");
		void first.catch(() => undefined);
		const hello = await harness.waitForMark(
			(mark) => mark.kind === "runner-hello-pending",
		);
		if (hello.kind !== "runner-hello-pending") throw new Error("Missing hello");
		// Keep readiness blocked while the RPC abort and durable reads run,
		// independent of how long this loaded machine takes to schedule them.
		process.kill(hello.pid, "SIGSTOP");
		let ends: ReturnType<typeof snapshot>["ends"];
		try {
			const controller = new AbortController();
			const reload = browser.reloadSession(sessionId, controller.signal).then(
				() => "completed",
				() => "interrupted",
			);
			await harness.waitForMark(
				(mark) =>
					mark.kind === "runner-end-selected" && mark.sessionId === sessionId,
			);
			controller.abort();
			expect(await reload).toBe("interrupted");
			// Interrupting the RPC detaches its waiter; the accepted End still owns
			// admission while it waits for this runner's hello.
			ends = snapshot(harness, sessionId).ends;
			expect(ends).toEqual([
				{
					command_id: expect.any(String),
					provider_process_id: expect.any(String),
					status: "running",
					attempt_count: 1,
					receipt_status: "side_effect_requested",
				},
			]);
			expect(
				harness.marks.filter(
					(mark) =>
						mark.kind === "runner-command" && mark.type === "end-session",
				),
			).toEqual([]);
		} finally {
			process.kill(hello.pid, "SIGCONT");
		}
		expect((await first).done["status"]).toBe("idle");
		const firstCompleted = snapshot(harness, sessionId).events.some(
			(event) => event.type === "turn.completed",
		);
		const runner = started(harness);
		expect(runner.socketPath.endsWith(`/${ends[0]?.provider_process_id}`)).toBe(
			true,
		);
		const next = await browser.send(sessionId, "after-interrupted-end");
		expect(next.done["status"]).toBe("idle");
		expect(next.chunks.join("")).toBe(
			responseChunks("after-interrupted-end").join(""),
		);
		expect(started(harness).pid).not.toBe(runner.pid);
		expect(() => process.kill(runner.pid, 0)).toThrow();
		expect(existsSync(runner.socketPath)).toBe(false);
		expect(() => process.kill(started(harness).pid, 0)).not.toThrow();
		await waitFor(harness, () => {
			const state = snapshot(harness, sessionId);
			expect(state.ends).toEqual([
				{
					...ends[0],
					status: "completed",
					receipt_status: "side_effect_completed",
				},
			]);
			expect(state.commands).toEqual([
				{ status: firstCompleted ? "completed" : "failed" },
				{ status: "completed" },
			]);
			expect(state.receipts).toEqual([
				{
					status: firstCompleted
						? "side_effect_completed"
						: "side_effect_failed",
				},
				{ status: "side_effect_completed" },
			]);
			expect(state.turns).toEqual([
				{ state: firstCompleted ? "completed" : "error" },
				{ state: "completed" },
			]);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.queued).toEqual([]);
		});
		expect(
			harness.marks.filter(
				(mark) => mark.kind === "runner-command" && mark.type === "end-session",
			),
		).toEqual([expect.objectContaining({ commandId: ends[0]?.command_id })]);
		expect(
			snapshot(harness, sessionId).events.filter(
				(event) => event.type === "session.end_requested",
			),
		).toEqual([
			{
				type: "session.end_requested",
				data: { providerProcessId: ends[0]?.provider_process_id },
			},
		]);
	});

	it("respawns transparently for a send racing idle exit admission", async () => {
		const { harness, browser, sessionId } = await start({
			idleTimeoutMs: 300,
			idleExitDelayMs: 1000,
		});
		await browser.send(sessionId, "before-idle-race");
		const first = started(harness);
		await harness.waitForMark(
			(mark) =>
				mark.kind === "runner-idle-exit-started" && mark.pid === first.pid,
		);
		await waitFor(
			harness,
			() =>
				expect(
					harness.marks.some(
						(mark) =>
							mark.kind === "runner-idle-exit-started" &&
							mark.pid === first.pid,
					),
				).toBe(true),
			{ timeout: 5000 },
		);
		expect(existsSync(first.socketPath)).toBe(true);
		const cursor = browser.frames.length;
		const turn = browser.send(sessionId, "approval-idle-race");
		void turn.catch(() => {});
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
			cursor,
		);
		expect(started(harness).pid).not.toBe(first.pid);
		await browser.answerApproval(approval, "allow");
		expect((await turn).done["status"]).toBe("idle");
		await waitFor(harness, () =>
			expect(snapshot(harness, sessionId).commands).toEqual([
				{ status: "completed" },
				{ status: "completed" },
			]),
		);
		expect(
			browser.frames
				.slice(cursor)
				.some(
					({ message }) =>
						message["type"] === "transcript_message" &&
						(message["parts"] as HistoryMessage["parts"])?.some(
							(part) => part.type === "error",
						) === true,
				),
		).toBe(false);
		expect(
			snapshot(harness, sessionId).events.some(
				(event) => event.type === "turn.error",
			),
		).toBe(false);
	});

	it("uses the active daemon config directory for idle policy and sockets", async () => {
		const { harness, browser, sessionId } = await start({
			nonDefaultConfigDir: true,
			idleDayMs: 100,
		});
		const activeDir = join(harness.root, "active-config");
		const path = join(activeDir, "daemon.json");
		await browser.setAutoSettle(null);
		await waitFor(harness, () =>
			expect(
				(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[
					"autoSettleAfterDays"
				],
			).toBe(null),
		);
		const config = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		writeFileSync(
			join(harness.root, "config", "daemon.json"),
			JSON.stringify({ ...config, autoSettleAfterDays: 1 }),
		);
		await browser.send(sessionId, "active-config-idle");
		const first = started(harness);
		expect(first.socketPath.startsWith(`${join(activeDir, "r")}/`)).toBe(true);
		await new Promise<void>((done) => setTimeout(done, 500));
		expect(() => process.kill(first.pid, 0)).not.toThrow();
		await browser.setAutoSettle(1);
		await browser.send(sessionId, "admit-active-config-idle-policy");
		await waitFor(
			harness,
			() => {
				expect(() => process.kill(first.pid, 0)).toThrow();
				expect(existsSync(first.socketPath)).toBe(false);
			},
			{ timeout: 5000 },
		);
		expect(
			(await browser.send(sessionId, "active-config-restart")).done["status"],
		).toBe("idle");
		expect(started(harness).pid).not.toBe(first.pid);
	});

	it("keeps a pending approval alive beyond the idle window", async () => {
		const { harness, browser, sessionId } = await start({
			idleTimeoutMs: 100,
		});
		const pending = browser.send(sessionId, "approval-idle");
		const request = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		const runner = started(harness);
		await new Promise<void>((done) => setTimeout(done, 400));
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		await browser.answerApproval(request, "allow");
		expect((await pending).done["status"]).toBe("idle");
		await waitFor(harness, () =>
			expect(snapshot(harness, sessionId).session).toEqual({
				status: "idle",
			}),
		);
	});

	it("honors a disabled idle policy", async () => {
		const { harness, browser, sessionId } = await start({
			idleTimeoutMs: null,
		});
		await browser.send(sessionId, "idle-disabled");
		const runner = started(harness);
		await new Promise<void>((done) => setTimeout(done, 400));
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
	});

	it.each([
		"stall",
		"approval",
		"question",
	])("persists a crash during %s and clears replayed interactions", async (phase) => {
		const { harness, browser, sessionId } = await start();
		const pending = browser.send(sessionId, `${phase}-crash`);
		await browser.waitFor((message) =>
			phase === "approval"
				? message["type"] === "permission_pending"
				: phase === "question"
					? message["type"] === "question_pending"
					: message["type"] === "transcript_message" &&
						message["role"] === "assistant" &&
						(message["parts"] as HistoryMessage["parts"])?.some(
							(part) => part.type === "text" && Boolean(part.text),
						) === true,
		);
		const runner = started(harness);
		process.kill(runner.pid, "SIGKILL");
		const { done } = await pending;
		expect(done["lastTurnEndVersion"]).toEqual(expect.any(Number));
		await waitFor(
			harness,
			() => {
				const state = snapshot(harness, sessionId);
				expect(state.session).toEqual({ status: "idle" });
				expect(state.turns).toEqual([{ state: "error" }]);
				expect(state.commands).toEqual([{ status: "failed" }]);
				expect(
					state.events.filter((event) => event.type === "turn.error"),
				).toEqual([
					expect.objectContaining({
						data: expect.objectContaining({ error: expect.any(String) }),
					}),
				]);
				expect(state.approvals).toHaveLength(phase === "stall" ? 0 : 1);
				for (const approval of state.approvals)
					expect(approval).toMatchObject({ status: "resolved" });
			},
			{ timeout: 5000 },
		);
		await browser.close();
		const reconnect = await harness.connect(sessionId);
		await reconnect.view(sessionId);
		const recovered = await reconnect.send(sessionId, "after-crash");
		expect(recovered.done["status"]).toBe("idle");
		expect(recovered.chunks.join("")).toBe(
			responseChunks("after-crash").join(""),
		);
		expect(started(harness).pid).not.toBe(runner.pid);
		await waitFor(harness, () =>
			expect(snapshot(harness, sessionId).session).toEqual({
				status: "idle",
			}),
		);
		expect(
			reconnect.frames.some(
				({ message }) =>
					message["type"] === "permission_pending" ||
					message["type"] === "question_pending",
			),
		).toBe(false);
	});

	it.each([
		"crash",
		"reload",
	])("finishes %s cleanup before starting a replacement turn", async (phase) => {
		const { harness, browser, sessionId } = await start({
			failureCleanupDelayMs: 5000,
		});
		const failed = browser.send(sessionId, "approval-overlap-crash");
		await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		if (phase === "crash") {
			process.kill(started(harness).pid, "SIGKILL");
			await waitFor(harness, () =>
				expect(JSON.stringify(harness.proof())).toContain(
					"Claude runner failed",
				),
			);
		} else {
			await browser.reloadSession(sessionId);
			// The reload interrupts the turn, and an interrupted turn advances no
			// turn-end version, so this send never settles; the ledger shows it.
			failed.catch(() => undefined);
		}
		let cursor = browser.frames.length;
		const replacement = browser.send(sessionId, "approval-overlap-recovery");
		if (phase === "crash") {
			// The crashed turn stays open until its cleanup ends it, so the send
			// queues behind it and the turn's failure pauses the queue. Resume
			// is what starts the replacement, once that cleanup has finished.
			await failed;
			const paused = snapshot(harness, sessionId);
			expect(paused.session).toEqual({ status: "idle" });
			expect(paused.turns).toEqual([{ state: "error" }]);
			expect(paused.queued).toHaveLength(1);
			const [queued] = paused.queued;
			if (!queued) throw new Error("Missing the queued replacement");
			cursor = browser.frames.length;
			await browser.sendNow(sessionId, queued.inputId);
		}
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
			cursor,
		);
		const enqueue = harness.marks.find(
			(mark) =>
				mark.kind === "enqueue" &&
				mark.prompt.endsWith(
					"[End conduit context handoff]\n\napproval-overlap-recovery",
				),
		);
		expect(enqueue?.kind).toBe("enqueue");
		if (enqueue?.kind !== "enqueue")
			throw new Error("Missing replacement SDK prompt");
		expect(enqueue.prompt).toContain("approval-overlap-crash");
		const query = harness.marks.find(
			(mark) => mark.kind === "query" && mark.queryId === enqueue.queryId,
		);
		if (query?.kind !== "query")
			throw new Error("Missing replacement SDK query");
		const queryOptions: unknown = JSON.parse(query.optionsJson);
		expect(queryOptions).not.toHaveProperty("resume");
		const active = snapshot(harness, sessionId);
		expect(active.session).toEqual({ status: "busy" });
		expect(
			active.approvals.filter(
				(approval) => isRecord(approval) && approval["status"] === "pending",
			),
		).toHaveLength(1);
		await browser.answerApproval(approval, "allow");
		await browser.waitForTurnEnd(sessionId, cursor);
		await replacement;
		await waitFor(harness, () => {
			const state = snapshot(harness, sessionId);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.turns).toEqual([
				{
					state:
						phase === "crash"
							? "error"
							: expect.stringMatching(/^(completed|interrupted)$/),
				},
				{ state: "completed" },
			]);
			expect(state.commands).toEqual([
				{ status: "failed" },
				{ status: "completed" },
			]);
			for (const approval of state.approvals)
				expect(approval).toMatchObject({ status: "resolved" });
		});
	});

	it.each([
		"server",
		"runner",
	])("refuses the %s protocol version and shows the session error", async (side) => {
		const { harness, browser, sessionId } = await start(
			side === "server"
				? { serverProtocolVersion: 999 }
				: { runnerHelloProtocolVersion: 999 },
		);
		const turn = await browser.send(sessionId, "protocol-refusal");
		expect(turn.done["lastTurnEndVersion"]).toEqual(expect.any(Number));
		await waitFor(harness, () => {
			const state = snapshot(harness, sessionId);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.turns).toEqual([{ state: "error" }]);
			expect(state.commands).toEqual([{ status: "failed" }]);
			expect(
				state.events.some(
					(event) =>
						event.type === "turn.error" &&
						isRecord(event.data) &&
						/protocol.*mismatch.*999/i.test(String(event.data["error"])),
				),
			).toBe(true);
			expect(JSON.stringify(harness.proof())).toMatch(
				/protocol.*mismatch.*999/i,
			);
		});
		expect(harness.marks.some((mark) => mark.kind === "query")).toBe(false);
	});

	it.each([
		["protocol version", "permission"],
		["run ownership", "permission"],
		["protocol version", "question"],
		["run ownership", "question"],
	] as const)("settles a live runner refused at adoption for %s with a pending %s and sends again", async (reason, prompt) => {
		const { harness, browser, sessionId } = await start({
			runnerHelloAfterFirst: true,
			...(reason === "protocol version"
				? { runnerHelloProtocolVersion: 999 }
				: { runnerHelloWithoutRunIds: true }),
		});
		const pending = browser.send(
			sessionId,
			`${prompt === "permission" ? "approval" : "question"}-adoption-refusal`,
		);
		void pending.catch(() => undefined);
		await browser.waitFor((frame) => frame["type"] === `${prompt}_pending`);
		const runner = started(harness);
		expect(testRunnerAlive(runner.pid)).toBe(true);
		const before = snapshot(harness, sessionId);
		expect(before.turns).toEqual([{ state: "running" }]);
		expect(before.approvals).toEqual([
			expect.objectContaining({
				type: prompt,
				status: "pending",
				provider_process_id: discoverRunners(
					harness.projectDir,
					harness.configDir,
				).find((entry) => entry.pid === runner.pid)?.runnerId,
			}),
		]);
		await harness.kill();
		expect(testRunnerAlive(runner.pid)).toBe(true);
		// Migration 0063 leaves legacy prompts without a provider process owner.
		const legacyPromptId = `legacy-${prompt}`;
		const db = new Database(harness.daemonStorePath());
		try {
			db.prepare(
				`INSERT INTO pending_approvals (id, session_id, turn_id, type, tool_name, input, created_at)
					 SELECT ?, session_id, turn_id, type, tool_name, input, created_at
					 FROM pending_approvals WHERE session_id = ? AND status = 'pending'`,
			).run(legacyPromptId, sessionId);
		} finally {
			db.close();
		}
		expect(snapshot(harness, sessionId).approvals).toContainEqual(
			expect.objectContaining({
				id: legacyPromptId,
				status: "pending",
				provider_process_id: null,
			}),
		);
		await harness.restart();
		const restored = await harness.connect(sessionId);
		await restored.view(sessionId);
		await waitFor(
			harness,
			() => {
				const state = snapshot(harness, sessionId);
				expect(state.session).toEqual({ status: "idle" });
				expect(state.turns).toEqual([{ state: "error" }]);
				expect(state.commands).toEqual([{ status: "failed" }]);
				expect(state.receipts).toEqual([{ status: "side_effect_failed" }]);
				expect(state.errorOwners).toEqual(state.runReservations);
				expect(state.approvals).toEqual([
					expect.objectContaining({ status: "resolved" }),
					expect.objectContaining({
						id: legacyPromptId,
						status: "resolved",
						provider_process_id: null,
					}),
				]);
				expect(state.promptResolutions).toEqual(
					expect.arrayContaining([
						{
							type: `${prompt}.resolved`,
							id: expect.not.stringMatching(/^legacy-/),
							source: "provider-process-expired",
						},
						{
							type: `${prompt}.resolved`,
							id: legacyPromptId,
							source: "provider-process-expired",
						},
					]),
				);
				expect(state.promptResolutions).toHaveLength(2);
				expect(
					state.events.filter((event) =>
						/^turn\.(error|completed|interrupted)$/.test(event.type),
					),
				).toHaveLength(1);
				expect(testRunnerAlive(runner.pid)).toBe(false);
			},
			{ timeout: 10_000 },
		);
		const failure =
			reason === "protocol version"
				? /protocol.*mismatch.*999/i
				: /predates run ownership.*build/i;
		expect(JSON.stringify(harness.proof())).toMatch(failure);
		expect(harness.logTail).not.toMatch(/Failed to create relay/);
		const state = snapshot(harness, sessionId);
		expect(
			JSON.stringify(
				state.events.filter((event) => event.type === "turn.error"),
			),
		).toMatch(failure);
		const reply = await restored.send(sessionId, "after-adoption-refusal");
		expect(reply.done["status"]).toBe("idle");
		expect(reply.chunks.join("")).toBe(
			responseChunks("after-adoption-refusal").join(""),
		);
		expect(started(harness).pid).not.toBe(runner.pid);
		await waitFor(harness, () => {
			const after = snapshot(harness, sessionId);
			expect(after.queued).toEqual([]);
			expect(after.turns).toEqual([{ state: "error" }, { state: "completed" }]);
			expect(after.commands).toEqual([
				{ status: "failed" },
				{ status: "completed" },
			]);
			expect(
				after.events.filter((event) =>
					/^turn\.(error|completed|interrupted)$/.test(event.type),
				),
			).toHaveLength(2);
		});
	});

	it("fails the owning turn and requeues its unstarted steer when startup refuses the protocol", async () => {
		const { harness, browser, sessionId } = await start({
			serverProtocolVersion: 999,
		});
		const first = browser.send(sessionId, "protocol-queued-first");
		await waitFor(harness, () =>
			expect(snapshot(harness, sessionId).commands).toHaveLength(1),
		);
		const steerId = randomUUID();
		const submitted = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				inputId: steerId,
				originId: browser.originId,
				delivery: "steer",
				text: "protocol-steered-second",
			}).pipe(Effect.timeout(harness.remainingTimeMs())),
		);
		expect(submitted.ok).toBe(true);
		const turn = await first;
		expect(turn.done["lastTurnEndVersion"]).toEqual(expect.any(Number));
		await waitFor(harness, () => {
			const state = snapshot(harness, sessionId);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.turns).toEqual([{ state: "error" }]);
			expect(state.commands).toEqual([
				{ status: "failed" },
				{ status: "failed" },
			]);
			expect(state.receipts).toEqual([
				{ status: "side_effect_failed" },
				{ status: "side_effect_failed" },
			]);
			expect([...state.errorOwners].sort()).toEqual(
				[...state.runReservations].sort(),
			);
			expect(new Set(state.errorOwners).size).toBe(2);
			expect(state.queued).toEqual([{ inputId: steerId }]);
			expect(
				state.events.filter((event) => event.type === "input.requeued"),
			).toEqual([
				{
					type: "input.requeued",
					data: {
						sessionId,
						inputId: steerId,
						sentSequence: expect.any(Number),
						reason: "failed",
					},
				},
			]);
			const userMessages = state.events.filter(
				(event) =>
					event.type === "message.created" &&
					isRecord(event.data) &&
					event.data["role"] === "user",
			);
			expect(userMessages).toHaveLength(1);
			expect(userMessages[0]?.data).not.toMatchObject({ inputId: steerId });
		});
	});

	it("persists the adapter failure once and requeues its unstarted steer without a user message", async () => {
		// Hold initialization until the steer reaches the runner, before an
		// approval can refuse it.
		expect(existsSync("dist/src/bin/claude-session-runner.js")).toBe(true);
		const harness = await ProcessHarness.start({
			dist: resolve("dist"),
			restartProof: true,
			deadline: performance.now() + LIFECYCLE_TIMEOUT_MS,
		});
		const fixture: { harness: ProcessHarness; sessionId?: string } = {
			harness,
		};
		fixtures.push(fixture);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Adapter failure with steer");
		fixture.sessionId = sessionId;
		writeFileSync(join(harness.root, "hold-next-initialization"), "hold once");
		const first = browser.send(sessionId, "approval-failure-queued-first");
		void first.catch(() => undefined);
		await harness.waitForMark((mark) => mark.kind === "initialization-held");
		expect(
			harness.marks.filter((mark) => mark.kind === "initialization-held"),
		).toHaveLength(1);
		const steerId = randomUUID();
		const submitted = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				inputId: steerId,
				originId: browser.originId,
				delivery: "steer",
				text: "stall-steered-second",
			}).pipe(Effect.timeout(harness.remainingTimeMs())),
		);
		expect(submitted.ok).toBe(true);
		await harness.waitForMark(
			(mark) =>
				mark.kind === "runner-command" &&
				mark.type === "send-turn" &&
				harness.marks.filter(
					(item) => item.kind === "runner-command" && item.type === "send-turn",
				).length >= 2,
		);
		expect(
			harness.marks.filter(
				(mark) => mark.kind === "runner-command" && mark.type === "send-turn",
			),
		).toHaveLength(2);
		writeFileSync(join(harness.root, "release-held-initialization"), "release");
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		await browser.answerApproval(approval, "allow");
		await first;
		await waitFor(harness, () => {
			const state = snapshot(harness, sessionId);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.turns).toEqual([{ state: "error" }]);
			expect(state.commands).toEqual([
				{ status: "failed" },
				{ status: "failed" },
			]);
			expect(state.receipts).toEqual([
				{ status: "side_effect_failed" },
				{ status: "side_effect_failed" },
			]);
			expect([...state.errorOwners].sort()).toEqual(
				[...state.runReservations].sort(),
			);
			expect(new Set(state.errorOwners).size).toBe(2);
			expect(state.queued).toEqual([{ inputId: steerId }]);
			expect(
				state.events.filter((event) => event.type === "input.requeued"),
			).toEqual([
				{
					type: "input.requeued",
					data: {
						sessionId,
						inputId: steerId,
						sentSequence: expect.any(Number),
						reason: "failed",
					},
				},
			]);
			const userMessages = state.events.filter(
				(event) =>
					event.type === "message.created" &&
					isRecord(event.data) &&
					event.data["role"] === "user",
			);
			expect(userMessages).toHaveLength(1);
			expect(userMessages[0]?.data).not.toMatchObject({ inputId: steerId });
		});
	});
}, 125_000);
