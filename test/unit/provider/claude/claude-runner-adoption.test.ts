import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Deferred, Effect, Either, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
	root: `/tmp/adopt-${process.pid}-${Date.now().toString(36)}`,
}));

vi.mock("../../../../src/lib/env.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../src/lib/env.js")>()),
	DEFAULT_CONFIG_DIR: config.root,
}));

import { BUILD_ID } from "../../../../src/lib/build-id.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { makeProcessClaudeSessionRunner } from "../../../../src/lib/provider/claude/claude-process-session-runner.js";
import * as runnerConnection from "../../../../src/lib/provider/claude/claude-runner-connection.js";
import {
	CLAUDE_RUNNER_PROTOCOL_VERSION,
	type ClaudeRunnerMessage,
	ClaudeRunnerSocket,
} from "../../../../src/lib/provider/claude/claude-runner-protocol.js";
import {
	claudeRunnerDirectory,
	discoverClaudeRunners,
	registerClaudeRunner,
	runnerPidAlive,
} from "../../../../src/lib/provider/claude/claude-runner-registry.js";
import type { ClaudeSessionOutput } from "../../../../src/lib/provider/claude/claude-session-runner.js";
import {
	makeMessageCreatedEvent,
	makeSessionCreatedEvent,
	makeTextDelta,
} from "../../../helpers/persistence-factories.js";

const observations: Record<string, unknown>[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const children: ChildProcess[] = [];
let cases = 0;

beforeEach(() => {
	vi.stubEnv("NODE_ENV", "development");
});

afterEach(async () => {
	const runnerPids = children.flatMap((child) =>
		child.pid === undefined ? [] : [child.pid],
	);
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.kill("SIGKILL");
		});
	}
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	const remainingPids = runnerPids.filter(runnerPidAlive);
	rmSync(config.root, { recursive: true, force: true });
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/85kb-9-adoption-regressions.json",
		JSON.stringify(
			{ finding: 1, observations, cleanup: { runnerPids, remainingPids } },
			null,
			2,
		),
	);
	expect(remainingPids).toEqual([]);
});

async function runnerSocket(options: {
	readonly rejections: number;
	readonly child?: ChildProcess;
	readonly onReject?: (socket: Socket) => void;
	readonly historyOnly?: boolean;
	readonly noBindings?: boolean;
}) {
	const workspaceRoot = join(config.root, `project-${++cases}`);
	const runnerId = "abcdefabcdef";
	const sessionId = "adoption-session";
	const directory = claudeRunnerDirectory(workspaceRoot);
	mkdirSync(directory, { recursive: true });
	const socketPath = join(directory, runnerId);
	const pid = options.child?.pid ?? process.pid;
	const spool = '{"sequence":1,"output":"pending approval"}\n';
	writeFileSync(`${socketPath}.spool`, spool);
	registerClaudeRunner({
		runnerId,
		sessionId,
		socketPath,
		buildId: BUILD_ID,
		pid,
	});
	const attempts: Array<{ at: number; filesIntact: boolean }> = [];
	const commands: ClaudeRunnerMessage[] = [];
	const historyReply = await Effect.runPromise(
		Deferred.make<Extract<ClaudeRunnerMessage, { type: "output-reply" }>>(),
	);
	let connection: ClaudeRunnerSocket | undefined;
	const pending: ClaudeSessionOutput = {
		type: "permission-request",
		sinkId: "adoption-sink",
		request: {
			requestId: "pending-approval",
			toolName: "Bash",
			toolInput: { command: "pwd" },
			sessionId,
			turnId: "adoption-turn",
			providerItemId: "adoption-tool",
		},
	};
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		attempts.push({
			at: Date.now(),
			filesIntact:
				existsSync(socketPath) &&
				existsSync(`${socketPath}.json`) &&
				existsSync(`${socketPath}.spool`) &&
				readFileSync(`${socketPath}.spool`, "utf8") === spool,
		});
		if (attempts.length <= options.rejections) {
			socket.once("data", () => {
				if (options.onReject) options.onReject(socket);
				else socket.destroy();
			});
			return;
		}
		const peer = new ClaudeRunnerSocket(
			socket,
			(message) => {
				if (message.type === "hello")
					peer.write({
						type: "hello",
						protocolVersion: CLAUDE_RUNNER_PROTOCOL_VERSION,
						buildId: BUILD_ID,
						runnerId,
						sessionId,
						pid,
						bindings: options.noBindings
							? []
							: [{ sinkId: "adoption-sink", sessionId }],
						pendingOutputs: options.historyOnly
							? []
							: [{ sequence: 0, output: pending }],
					});
				else if (message.type === "output-reply")
					Deferred.unsafeDone(historyReply, Effect.succeed(message));
				else if (message.type === "command") {
					commands.push(message);
					peer.write({
						type: "command-reply",
						commandId: message.commandId,
					});
				}
			},
			() => {},
		);
		connection = peer;
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return {
		workspaceRoot,
		socketPath,
		attempts,
		commands,
		pending,
		readHistory: (sinkId = "adoption-sink") =>
			Effect.sync(() => {
				if (!connection) throw new Error("Runner is not connected");
				connection.write({
					type: "output",
					outputId: "history-request",
					sequence: 1,
					output: { type: "read-turn-history", sinkId },
				});
			}).pipe(Effect.zipRight(Deferred.await(historyReply))),
	};
}

describe("Claude runner adoption", () => {
	it.each([
		"live",
		"restored",
		"recovered",
		"read failure",
		"conversion failure",
		"missing cutoff",
	] as const)("loads %s runner history without an outbox transcript", async (scenario) => {
		const fixture = await runnerSocket({
			rejections: 0,
			historyOnly: true,
			noBindings: scenario === "recovered",
		});
		const fullOutput = "untruncated tool output\n".repeat(4000);
		let emit: Parameters<
			typeof runnerConnection.connectClaudeRunner
		>[0]["emit"];
		const connect = runnerConnection.connectClaudeRunner;
		vi.spyOn(runnerConnection, "connectClaudeRunner").mockImplementation(
			(options) => {
				emit = options.emit;
				return connect(options);
			},
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const store = yield* EventStoreEffectTag;
					const projections = yield* ProjectionRunnerEffectTag;
					yield* projections.recover();
					const readQuery = yield* ReadQueryEffectTag;
					const sessionId = "adoption-session";
					const append = (events: Parameters<typeof store.appendBatch>[0]) =>
						store
							.appendBatch(events)
							.pipe(
								Effect.flatMap((stored) => projections.projectBatch(stored)),
							);
					yield* append([
						makeSessionCreatedEvent(sessionId, {
							provider: "claude",
							createdAt: 1,
						}),
						makeMessageCreatedEvent(sessionId, "prior-user", {
							role: "user",
							createdAt: 10,
						}),
						makeTextDelta(sessionId, "prior-user", "Earlier prompt", {
							createdAt: 10,
							partId: "prior-user-text",
						}),
						makeMessageCreatedEvent(sessionId, "prior-assistant", {
							createdAt: 20,
						}),
						canonicalEvent(
							"tool.started",
							sessionId,
							{
								messageId: "prior-assistant",
								partId: "prior-tool",
								toolName: "Bash",
								callId: "call-1",
								input: { tool: "Bash", command: "cat large-file" },
							},
							{ provider: "claude", createdAt: 20 },
						),
						canonicalEvent(
							"tool.completed",
							sessionId,
							{
								messageId: "prior-assistant",
								partId: "prior-tool",
								result: fullOutput,
								duration: 1,
							},
							{ provider: "claude", createdAt: 21 },
						),
					]);
					const historyRead = vi.spyOn(
						readQuery,
						"getSessionMessagesWithParts",
					);
					yield* append([
						makeMessageCreatedEvent(sessionId, "current-user", {
							role: "user",
							createdAt: 30,
						}),
						makeTextDelta(sessionId, "current-user", "Current prompt", {
							createdAt: 30,
							partId: "current-user-text",
						}),
						canonicalEvent(
							"message.created",
							sessionId,
							{
								sessionId,
								messageId: "current-assistant",
								role: "assistant",
								parentID: "current-user",
							},
							{ provider: "claude", createdAt: 31 },
						),
						makeTextDelta(
							sessionId,
							"current-assistant",
							"Exclude this reply",
							{ createdAt: 31, partId: "current-assistant-text" },
						),
						makeMessageCreatedEvent(sessionId, "aaa-later-user", {
							role: "user",
							createdAt: 32,
						}),
						makeTextDelta(
							sessionId,
							"aaa-later-user",
							"Exclude this later prompt",
							{ createdAt: 32, partId: "aaa-later-user-text" },
						),
						makeMessageCreatedEvent(sessionId, "later-assistant", {
							createdAt: 33,
						}),
					]);
					const input = {
						sessionId,
						turnId: "current-turn",
						userMessageId: "current-user",
						prompt: "Current prompt",
						history: [],
						providerState: {},
						workspaceRoot: fixture.workspaceRoot,
						extraFolders: [],
						model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
					};
					yield* sql`INSERT INTO provider_command_outbox (
						request_sequence, command_id, project_key, session_id, provider_id,
						effect_type, payload_json, status, requested_at, updated_at
					) VALUES (1, 'adoption-sink', 'project', ${sessionId}, 'claude',
						'send_turn', ${JSON.stringify({ ...input, history: undefined })}, ${scenario === "recovered" ? "running" : "completed"}, 30, 30)`;
					const runner = yield* makeProcessClaudeSessionRunner(
						{ workspaceRoot: fixture.workspaceRoot },
						() => Effect.succeed({}),
					);
					yield* runner.recoverEffect;
					if (scenario === "live")
						yield* runner.executeEffect({
							type: "send-turn",
							sinkId: "adoption-sink",
							aborted: false,
							input,
						});
					expect(historyRead).not.toHaveBeenCalled();
					if (scenario === "read failure") yield* sql`DROP TABLE message_parts`;
					if (scenario === "conversion failure")
						yield* sql`UPDATE messages SET rest_payload = '{' WHERE id = 'prior-assistant'`;
					if (scenario === "missing cutoff")
						yield* sql`DELETE FROM messages WHERE id = 'current-user'`;
					if (
						scenario !== "live" &&
						scenario !== "restored" &&
						scenario !== "recovered"
					) {
						if (!emit) throw new Error("Missing runner history handler");
						const failure = yield* Effect.either(
							emit(
								{ type: "read-turn-history", sinkId: "adoption-sink" },
								sessionId,
							),
						);
						expect(failure).toMatchObject({
							_tag: "Left",
							left: {
								operation: "read-turn-history",
								message: "Claude turn history is no longer available",
							},
						});
						return;
					}
					const reply = yield* fixture.readHistory(
						scenario === "recovered" ? "adoption-sink:0" : "adoption-sink",
					);
					expect(reply.failure).toBeUndefined();
					expect(reply.result?.history?.map((message) => message.id)).toEqual([
						"prior-user",
						"prior-assistant",
					]);
					expect(reply.result?.history?.[1]?.parts?.[0]).toMatchObject({
						state: { output: fullOutput },
					});
					observations.push({
						case: `${scenario} history`,
						messages: reply.result?.history?.map((message) => message.id),
						toolOutputBytes: fullOutput.length,
					});
				}).pipe(Effect.provide(makePersistenceEffectLayer(":memory:"))),
			),
		);
	});

	it.each([
		"EPERM",
		"EACCES",
	])("preserves unverified registration when the PID probe fails with %s", async (code) => {
		const fixture = await runnerSocket({
			rejections: Number.POSITIVE_INFINITY,
		});
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("PID probe denied"), { code });
		});
		expect(runnerPidAlive(process.pid)).toBe(true);
		expect(discoverClaudeRunners(fixture.workspaceRoot)).toHaveLength(1);
		for (const suffix of ["", ".json", ".spool"])
			expect(existsSync(`${fixture.socketPath}${suffix}`)).toBe(true);
		observations.push({ case: "unverifiable PID", code, filesPreserved: true });
	});

	it("reports an immediately rejected socket error without an uncaught readline exception", () => {
		const socket = new Socket();
		const onClose = vi.fn();
		new ClaudeRunnerSocket(socket, () => {}, onClose);
		expect(() => socket.emit("error", new Error("write EPIPE"))).not.toThrow();
		expect(onClose).toHaveBeenCalledOnce();
		socket.destroy();
		observations.push({
			case: "immediate socket rejection",
			error: "EPIPE",
			handled: true,
		});
	});

	it("retains a live runner's files through transient rejection and restores its pending approval", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" },
		);
		children.push(child);
		const fixture = await runnerSocket({ rejections: 2, child });
		const kill = vi.spyOn(process, "kill");
		const emitted: ClaudeSessionOutput[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeProcessClaudeSessionRunner(
						{ workspaceRoot: fixture.workspaceRoot },
						(output) =>
							Effect.sync(() => {
								emitted.push(output);
								return {};
							}),
					);
					yield* runner.recoverEffect;
					expect(fixture.attempts).toHaveLength(3);
					expect(fixture.attempts.every((attempt) => attempt.filesIntact)).toBe(
						true,
					);
					expect(emitted).toEqual([fixture.pending]);
					yield* runner.executeEffect({
						type: "answer-permission",
						sinkId: "adoption-sink",
						requestId: "pending-approval",
						response: { decision: "once" },
					});
					expect(fixture.commands).toMatchObject([
						{
							command: {
								type: "answer-permission",
								requestId: "pending-approval",
							},
						},
					]);
				}),
			),
		);
		expect(runnerPidAlive(child.pid ?? 0)).toBe(true);
		expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
		expect(
			fixture.commands.some(
				(message) =>
					message.type === "command" && message.command.type === "shutdown",
			),
		).toBe(false);
		for (const suffix of ["", ".json", ".spool"])
			expect(existsSync(`${fixture.socketPath}${suffix}`)).toBe(true);
		observations.push({
			case: "transient rejection",
			attempts: fixture.attempts,
			approvalsRestored: emitted.length,
		});
	});

	it("fails within bounded backoff without deleting or signalling a live unverified runner", async () => {
		const fixture = await runnerSocket({
			rejections: Number.POSITIVE_INFINITY,
		});
		const kill = vi.spyOn(process, "kill");
		const started = Date.now();
		const outcome = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeProcessClaudeSessionRunner(
						{ workspaceRoot: fixture.workspaceRoot },
						() => Effect.succeed({}),
					);
					return yield* Effect.either(runner.recoverEffect);
				}),
			),
		);
		const elapsed = Date.now() - started;
		expect(Either.isLeft(outcome)).toBe(true);
		expect(fixture.attempts.length).toBeGreaterThan(1);
		expect(fixture.attempts.length).toBeLessThanOrEqual(6);
		expect(elapsed).toBeLessThan(5000);
		for (const suffix of ["", ".json", ".spool"])
			expect(existsSync(`${fixture.socketPath}${suffix}`)).toBe(true);
		expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
		observations.push({
			case: "bounded rejection",
			attempts: fixture.attempts,
			elapsed,
			failedClosed: Either.isLeft(outcome),
			filesPreserved: true,
		});
	});

	it("keeps unverified live runner files when startup is interrupted", async () => {
		const rejected = await Effect.runPromise(Deferred.make<void>());
		const fixture = await runnerSocket({
			rejections: Number.POSITIVE_INFINITY,
			onReject: () => Deferred.unsafeDone(rejected, Effect.void),
		});
		const kill = vi.spyOn(process, "kill");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeProcessClaudeSessionRunner(
						{ workspaceRoot: fixture.workspaceRoot },
						() => Effect.succeed({}),
					);
					const recovery = yield* Effect.fork(runner.recoverEffect);
					yield* Deferred.await(rejected);
					yield* Fiber.interrupt(recovery);
				}),
			),
		);
		for (const suffix of ["", ".json", ".spool"])
			expect(existsSync(`${fixture.socketPath}${suffix}`)).toBe(true);
		expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
		observations.push({
			case: "interrupted adoption",
			filesPreserved: true,
			signalsSent: 0,
		});
	});

	it("removes registration and spool when the runner dies after rejecting adoption", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" },
		);
		children.push(child);
		const fixture = await runnerSocket({
			rejections: Number.POSITIVE_INFINITY,
			child,
			onReject: (socket) => {
				child.once("exit", () => socket.destroy());
				child.kill("SIGTERM");
			},
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeProcessClaudeSessionRunner(
						{ workspaceRoot: fixture.workspaceRoot },
						() => Effect.succeed({}),
					);
					yield* runner.recoverEffect;
				}),
			),
		);
		for (const suffix of ["", ".json", ".spool"])
			expect(existsSync(`${fixture.socketPath}${suffix}`)).toBe(false);
		observations.push({
			case: "dead runner",
			pid: child.pid,
			exited: child.exitCode !== null || child.signalCode !== null,
			filesRemoved: true,
		});
	});
});
