import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeProcessSessionRunner } from "../../../src/lib/provider/runner/process-session-runner.js";
import { connectRunner } from "../../../src/lib/provider/runner/runner-connection.js";
import {
	RUNNER_PROTOCOL_VERSION,
	RunnerSocket,
	runnerBuildId,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import type { RunnerRecoveryDependencies } from "../../../src/lib/provider/runner/runner-provider-instance.js";
import {
	prepareRunnerDirectory,
	registerRunner,
} from "../../../src/lib/provider/runner/runner-registry.js";

// Services can disappear after recovery classifies the entry, before hello.
// Cache only a retirement that ran, including a successful zero-prompt result.
it("retries an unperformed prompt retirement and caches a successful zero result", async () => {
	const root = mkdtempSync("/tmp/runner-observation-");
	const runnerId = "123456789abc";
	const sessionId = "observation-session";
	const socketPath = join(prepareRunnerDirectory(root, root), runnerId);
	const sockets = new Set<Socket>();
	const retirements: (string | null)[] = [];
	const helloAvailability: boolean[] = [];
	let available = true;
	const kill = process.kill.bind(process);
	const killGuard = vi
		.spyOn(process, "kill")
		.mockImplementation((pid, signal) => {
			if (signal !== 0)
				throw new Error("Socket fixture permits PID probes only");
			return kill(pid, signal);
		});
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		const peer = new RunnerSocket(
			socket,
			(message) => {
				if (message.type === "hello") {
					// Classification already saw services; only observation loses them.
					if (helloAvailability.length === 0) available = false;
					helloAvailability.push(available);
					peer.write({
						type: "hello",
						driverKind: "claude",
						protocolVersion: RUNNER_PROTOCOL_VERSION,
						buildId: runnerBuildId(),
						stampsRunIds: true,
						runnerId,
						sessionId,
						pid: process.pid,
						bindings: [],
					});
				} else if (message.type === "replay") {
					peer.write({
						type: "upgrade-state",
						state: { quiescent: false, revision: 1 },
					});
				}
			},
			() => {},
		);
	});
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		registerRunner({
			socketPath,
			runnerId,
			sessionId,
			driverKind: "claude",
			pid: process.pid,
			buildId: runnerBuildId(),
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
						VALUES (${sessionId}, 'test-project', 'claude', 1, 1)`;
					const recovery: RunnerRecoveryDependencies = {
						projectId: "test-project",
						ingestion: yield* ProviderRuntimeIngestionTag,
						pending: yield* PendingInteractionServiceTag,
						persist: yield* ClaudeEventPersistEffectTag,
						timeoutHooks: {},
						resolveCallContext: () =>
							Effect.die("No turns in observation test"),
						retirePrompts: (processId) =>
							Effect.sync(() => {
								retirements.push(processId);
								return 0;
							}),
					};
					const runner = yield* makeProcessSessionRunner(
						{
							daemonConfigDir: root,
							projectRootForSession: () => Effect.succeed(root),
							recoveryForSession: () =>
								Effect.sync(() => (available ? recovery : undefined)),
						},
						() => Effect.die("No output in observation test"),
						{
							driverKind: "claude",
							connect: connectRunner,
							settingsDeferredCode: "unused",
							warmCommand: () => {
								throw new Error("No warm commands in observation test");
							},
							snapshotCommandSettings: () => ({}),
							loginChange: () => "None",
							recoverCommands: () => Effect.succeed([]),
						},
					);
					const detach = runner.detachSessionEffect?.bind(runner);
					const attach = runner.attachSessionsEffect?.bind(runner);
					if (!detach || !attach)
						throw new Error("Missing runner attachment API");
					yield* runner.recoverEffect;
					expect(helloAvailability).toEqual([false]);
					expect(retirements).toEqual([]);
					available = true;
					yield* detach(sessionId);
					yield* attach([sessionId]);
					expect(retirements).toEqual([runnerId]);
					yield* detach(sessionId);
					yield* attach([sessionId]);
					expect(helloAvailability).toEqual([false, true, true]);
					expect(retirements).toEqual([runnerId]);
					yield* detach(sessionId);
				}),
			).pipe(
				Effect.provide(
					Layer.mergeAll(
						persistence,
						ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
						makePendingInteractionServiceLive(),
					),
				),
			),
		);
	} finally {
		await Promise.all(
			[...sockets].map(
				(socket) =>
					new Promise<void>((resolve) => {
						socket.once("close", () => resolve());
						socket.destroy();
					}),
			),
		);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		killGuard.mockRestore();
		rmSync(root, { recursive: true, force: true });
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/m104-r1-observation-retirement.json",
			JSON.stringify({
				helloAvailability,
				retirements,
				cleanup: { openSockets: sockets.size, rootExists: existsSync(root) },
			}),
		);
	}
}, 15_000);
