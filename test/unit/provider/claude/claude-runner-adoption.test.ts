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
import { makeProcessClaudeSessionRunner } from "../../../../src/lib/provider/claude/claude-process-session-runner.js";
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
import { setClaudeRunnerRestart } from "../../../../src/lib/provider/claude/claude-runner-shutdown.js";
import type { ClaudeSessionOutput } from "../../../../src/lib/provider/claude/claude-session-runner.js";

const observations: Record<string, unknown>[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const children: ChildProcess[] = [];
let cases = 0;

beforeEach(() => {
	// These sockets model live runners in this test process. Scope teardown must
	// disconnect them without signalling the process that owns the test suite.
	setClaudeRunnerRestart(true);
	vi.stubEnv("NODE_ENV", "development");
});

afterEach(async () => {
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
	setClaudeRunnerRestart(false);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(config.root, { recursive: true, force: true });
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/85kb-9-adoption-regressions.json",
		JSON.stringify({ finding: 1, observations }, null, 2),
	);
});

async function runnerSocket(options: {
	readonly rejections: number;
	readonly child?: ChildProcess;
	readonly onReject?: (socket: Socket) => void;
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
						bindings: [{ sinkId: "adoption-sink", sessionId }],
						pendingOutputs: [{ sequence: 0, output: pending }],
					});
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
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return { workspaceRoot, socketPath, attempts, commands, pending };
}

describe("Claude runner adoption", () => {
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
		const fixture = await runnerSocket({ rejections: 2 });
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
		setClaudeRunnerRestart(false);
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
