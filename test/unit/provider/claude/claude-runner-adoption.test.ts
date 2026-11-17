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
import { Deferred, Effect, Result as Either, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProductionProcessTable } from "../../../../src/lib/provider/runner/process-table.js";

const config = vi.hoisted(() => ({
	root: `/tmp/adopt-${process.pid}-${Date.now().toString(36)}`,
}));

vi.mock("../../../../src/lib/env.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../src/lib/env.js")>()),
	DEFAULT_CONFIG_DIR: config.root,
}));

import { BUILD_ID } from "../../../../src/lib/build-id.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { makeProcessClaudeSessionRunner } from "../../../../src/lib/provider/claude/claude-process-session-runner.js";
import { ClaudeRunnerSocket } from "../../../../src/lib/provider/claude/claude-runner-protocol.js";
import {
	RUNNER_PROTOCOL_VERSION,
	type RunnerMessage,
} from "../../../../src/lib/provider/runner/runner-protocol.js";
import { makeRunnerReceiptStore } from "../../../../src/lib/provider/runner/runner-receipts.js";
import {
	discoverRunners,
	registerRunner,
	runnerDirectory,
	runnerPidAlive,
	runnerProcessTable,
} from "../../../../src/lib/provider/runner/runner-registry.js";
import type { SessionOutput } from "../../../../src/lib/provider/runner/session-runner.js";
import { ProviderRuntimeIngestionLive } from "../../../helpers/daemon-turns.js";
import { makeRunnerAdmission } from "../../../helpers/runner-provider-admission.js";

const observations: Record<string, unknown>[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const children = new Map<ChildProcess, string | undefined>();
let cases = 0;

function spawnRunnerChild() {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
		stdio: "ignore",
	});
	children.set(
		child,
		child.pid === undefined
			? undefined
			: runnerProcessTable.inspect(child.pid).startTime,
	);
	return child;
}

beforeEach(() => {
	vi.stubEnv("NODE_ENV", "development");
});

afterEach(async () => {
	const runnerPids = [...children.keys()].flatMap((child) =>
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
	for (const [child, startTime] of children) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			if (
				child.pid !== undefined &&
				startTime !== undefined &&
				runnerProcessTable.inspect(child.pid).startTime === startTime
			)
				child.kill("SIGKILL");
		});
	}
	children.clear();
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
}) {
	const workspaceRoot = join(config.root, `project-${++cases}`);
	const runnerId = "abcdefabcdef";
	const sessionId = "adoption-session";
	const directory = runnerDirectory(workspaceRoot);
	mkdirSync(directory, { recursive: true });
	const socketPath = join(directory, runnerId);
	const pid = options.child?.pid ?? process.pid;
	const native = makeProductionProcessTable();
	const processTable = {
		...native,
		identify: (pids: readonly number[]) =>
			new Map(
				[...native.identify(pids)].map(([target, seen]) => [
					target,
					target === process.pid ? { state: "unknown" as const } : seen,
				]),
			),
	};
	const persistence = makePersistenceEffectLayer(
		":memory:",
		"adoption-project",
	);
	const services = Layer.merge(
		persistence,
		ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
	);
	const registerServing = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
			VALUES (${sessionId}, 'adoption-project', 'claude', 1, 1)`;
		const receipts = yield* makeRunnerReceiptStore(sql);
		yield* receipts.register(
			runnerId,
			{
				sessionId,
				driverKind: "claude",
				pid,
				startTime: (() => {
					const seen = processTable.identify([pid]).get(pid);
					return seen && "startTime" in seen ? seen.startTime : undefined;
				})(),
			},
			"serving",
		);
	});
	const spool = '{"sequence":1,"output":"pending approval"}\n';
	writeFileSync(`${socketPath}.spool`, spool);
	registerRunner({
		runnerId,
		sessionId,
		socketPath,
		buildId: BUILD_ID,
		pid,
	});
	const attempts: Array<{ at: number; filesIntact: boolean }> = [];
	const commands: RunnerMessage[] = [];
	const pending: SessionOutput = {
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
						protocolVersion: RUNNER_PROTOCOL_VERSION,
						stampsRunIds: true,
						buildId: BUILD_ID,
						runnerId,
						sessionId,
						pid,
						bindings: [{ sinkId: "adoption-sink", sessionId, released: false }],
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
	return {
		workspaceRoot,
		socketPath,
		attempts,
		commands,
		pending,
		deps: {
			projectRootForSession: () => Effect.succeed(workspaceRoot),
			daemonConfigDir: config.root,
			processTable,
		},
		registerServing,
		services,
	};
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
		expect(discoverRunners(fixture.workspaceRoot)).toHaveLength(1);
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
		const child = spawnRunnerChild();
		const fixture = await runnerSocket({ rejections: 2, child });
		const kill = vi.spyOn(process, "kill");
		const emitted: SessionOutput[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.registerServing;
					const runner = yield* makeProcessClaudeSessionRunner(
						fixture.deps,
						(output) =>
							Effect.sync(() => {
								emitted.push(output);
								return {};
							}),
					);
					yield* makeRunnerAdmission(runner);
					yield* runner.recoverEffect;
					expect(
						yield* runner.hasLiveProcessEffect(
							"adoption-session",
							"abcdefabcdef",
						),
					).toBe(true);
					expect(
						yield* runner.hasLiveProcessEffect(
							"adoption-session",
							"replaced-process",
						),
					).toBe(false);
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
			).pipe(Effect.provide(fixture.services)),
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

	it("refuses stop-task for a runner whose hello predates it, since that runner acknowledges unknown commands", async () => {
		const child = spawnRunnerChild();
		const fixture = await runnerSocket({ rejections: 0, child });
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.registerServing;
					const runner = yield* makeProcessClaudeSessionRunner(
						fixture.deps,
						() => Effect.succeed({}),
					);
					yield* makeRunnerAdmission(runner);
					yield* runner.recoverEffect;
					return yield* Effect.result(
						runner.executeEffect({
							type: "stop-task",
							sessionId: "adoption-session",
							taskId: "background-task",
						}),
					);
				}),
			).pipe(Effect.provide(fixture.services)),
		);
		expect(Either.isFailure(result)).toBe(true);
		expect(
			fixture.commands.some(
				(message) =>
					message.type === "command" && message.command.type === "stop-task",
			),
		).toBe(false);
		observations.push({ case: "legacy stop-task", refused: true });
	});

	it("retires within bounded backoff without deleting or signalling a live unverified runner", async () => {
		const fixture = await runnerSocket({
			rejections: Number.POSITIVE_INFINITY,
		});
		const kill = vi.spyOn(process, "kill");
		const started = Date.now();
		const outcome = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.registerServing;
					const runner = yield* makeProcessClaudeSessionRunner(
						fixture.deps,
						() => Effect.succeed({}),
					);
					yield* makeRunnerAdmission(runner);
					const result = yield* Effect.result(runner.recoverEffect);
					expect(
						yield* runner.hasLiveProcessEffect(
							"adoption-session",
							"abcdefabcdef",
						),
					).toBe(false);
					expect(
						yield* runner.hasLiveProcessEffect(
							"adoption-session",
							"replaced-process",
						),
					).toBe(false);
					return result;
				}),
			).pipe(Effect.provide(fixture.services)),
		);
		const elapsed = Date.now() - started;
		expect(Either.isSuccess(outcome)).toBe(true);
		expect(fixture.attempts.length).toBeGreaterThan(1);
		// Recovery bounds reconnects by count (retry < 4), not by time, so the
		// attempt count is the bound; elapsed time only measures machine load.
		expect(fixture.attempts.length).toBeLessThanOrEqual(6);
		for (const suffix of ["", ".json", ".spool"])
			expect(existsSync(`${fixture.socketPath}${suffix}`)).toBe(true);
		expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
		observations.push({
			case: "bounded rejection",
			attempts: fixture.attempts,
			elapsed,
			recovered: Either.isSuccess(outcome),
			filesPreserved: true,
		});
	});

	it("keeps unverified live runner files when startup is interrupted", async () => {
		const rejected = await Effect.runPromise(Deferred.make<void>());
		const fixture = await runnerSocket({
			rejections: Number.POSITIVE_INFINITY,
			onReject: () => Deferred.doneUnsafe(rejected, Effect.void),
		});
		const kill = vi.spyOn(process, "kill");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.registerServing;
					const runner = yield* makeProcessClaudeSessionRunner(
						fixture.deps,
						() => Effect.succeed({}),
					);
					yield* makeRunnerAdmission(runner);
					const recovery = yield* Effect.forkChild(runner.recoverEffect);
					yield* Deferred.await(rejected);
					yield* Fiber.interrupt(recovery);
				}),
			).pipe(Effect.provide(fixture.services)),
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
		const child = spawnRunnerChild();
		const fixture = await runnerSocket({
			rejections: Number.POSITIVE_INFINITY,
			child,
			onReject: (socket) => {
				child.once("exit", () => socket.destroy());
				if (
					child.pid !== undefined &&
					children.get(child) !== undefined &&
					runnerProcessTable.inspect(child.pid).startTime ===
						children.get(child)
				)
					child.kill("SIGTERM");
			},
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.registerServing;
					const runner = yield* makeProcessClaudeSessionRunner(
						fixture.deps,
						() => Effect.succeed({}),
					);
					yield* makeRunnerAdmission(runner);
					yield* runner.recoverEffect;
				}),
			).pipe(Effect.provide(fixture.services)),
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
