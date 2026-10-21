import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it, vi } from "vitest";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { setLogFile } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import {
	prepareRunnerDirectory,
	registerRunner,
} from "../../../src/lib/provider/runner/runner-registry.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";

const transport = vi.hoisted(() => ({
	spawn: vi.fn(),
	discover: vi.fn<
		() => import("../../../src/lib/provider/runner/runner-registry.js").RunnerRegistration[]
	>(() => []),
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: transport.spawn,
}));

vi.mock(
	"../../../src/lib/provider/runner/runner-registry.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/provider/runner/runner-registry.js")
		>()),
		discoverRunners: transport.discover,
	}),
);

import {
	makeProcessSessionRunner,
	type ProcessRunnerDriver,
} from "../../../src/lib/provider/runner/process-session-runner.js";
import {
	RunnerSocket,
	runnerBuildId,
	runnerFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import type { RunnerUpgradeState } from "../../../src/lib/provider/runner/runner-upgrade.js";
import type {
	SessionCommand,
	SessionOutput,
} from "../../../src/lib/provider/runner/session-runner.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	setLogFile("");
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

// Failure modes: sending to a held runner, losing a waiting send at retirement,
// attempting a warm swap, and leaving admission closed after restart failure.
for (const mode of [
	"settings-snapshot",
	"adoption-race",
	"restart-stalls",
	"restart-rejects",
	"same-build-id",
	"restart-spawn-fails",
	"stop-bound",
	"racing-folders",
	"no-journal",
	"no-journal-marked",
	"no-journal-marked-retained",
	"no-journal-death",
] as const) {
	it(`legacy input admission: ${mode}; controls reach the old runner and inputs wait for retirement`, async () => {
		if (mode === "restart-stalls")
			vi.stubEnv("CONDUIT_TEST_RUNNER_STARTUP_TIMEOUT_MS", "50");
		transport.discover.mockReturnValue([]);
		const root = mkdtempSync(join(tmpdir(), "legacy-input-hold-"));
		roots.push(root);
		const logFile = join(root, "daemon.log");
		setLogFile(logFile);
		const recovered = mode.startsWith("no-journal");
		let recoveryVersion = 0;
		let spawned = recovered ? 1 : 0;
		transport.spawn.mockImplementation(() => {
			if (mode === "restart-spawn-fails" && spawned === 1)
				throw new Error("Replacement startup rejected");
			const child = Object.assign(new EventEmitter(), {
				pid: 99_999_999 - spawned++,
				exitCode: null,
				signalCode: null,
				connected: false,
				unref() {},
				disconnect() {},
			});
			queueMicrotask(() =>
				child.emit("message", {
					channel: "conduit-claude-runner",
					type: "listening",
				}),
			);
			return child;
		});
		const outputs: SessionOutput[] = [];
		const delivered: Array<{ build: string; type: SessionCommand["type"] }> =
			[];
		let closeLegacy: (() => void) | undefined;
		let boundary: ((state: RunnerUpgradeState) => void) | undefined;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const input = {
						sessionId: "s",
						workspaceRoot: root,
						extraFolders: [],
						providerState: {},
						configDir: configuredClaudeConfigDir(root),
						folderSource: "account" as const,
					};
					const driver: ProcessRunnerDriver = {
						driverKind: "claude",
						coldUpgrade: true,
						connect: (options) =>
							Effect.gen(function* () {
								const old = options.pid === 99_999_999;
								const build = old ? "main-without-run-ids" : runnerBuildId();
								if (old) {
									boundary = options.onUpgradeState;
									closeLegacy = () =>
										options.onClose(runnerFailure("native exit", "gone"));
								}
								const socket = new Socket();
								const connection = new RunnerSocket(
									socket,
									() => {},
									() => {},
								);
								vi.spyOn(connection, "retireEffect").mockReturnValue(
									Effect.succeed(true),
								);
								vi.spyOn(connection, "write").mockImplementation(() => {});
								vi.spyOn(connection, "commandEffect").mockImplementation(
									(_id, command) =>
										Effect.gen(function* () {
											delivered.push({ build, type: command.type });
											if (!old && command.type === "pre-warm")
												return yield* Effect.fail(
													runnerFailure("warm", "Legacy runners must restart"),
												);
											if (command.type === "send-turn")
												return {
													status: "completed" as const,
													cost: 0,
													tokens: { input: 0, output: 0 },
													durationMs: 0,
													providerStateUpdates: [],
												};
											if (command.type === "end-session") {
												if (mode === "restart-stalls")
													return yield* Effect.never;
												if (mode === "restart-rejects")
													return yield* Effect.fail(
														runnerFailure("end-session", "Restart rejected"),
													);
											}
											return undefined;
										}),
								);
								yield* options.onHello(
									{
										type: "hello",
										protocolVersion: 1,
										buildId:
											old && mode === "same-build-id" ? runnerBuildId() : build,
										runnerId: options.runnerId,
										sessionId: "s",
										...(options.pid !== undefined ? { pid: options.pid } : {}),
										...(old ? {} : { stampsRunIds: true }),
										stopsTasks: true,
										bindings: [],
										...(old &&
										recovered &&
										mode !== "no-journal-marked-retained"
											? {}
											: {
													sendCommands:
														mode === "no-journal-marked-retained"
															? [{ commandId: "unknown", attempt: 1 }]
															: [],
												}),
										upgradeState: {
											quiescent: false,
											revision: 1,
											snapshot: { input, options: {} },
										},
									},
									connection,
								);
								return connection;
							}),
						settingsDeferredCode: "settings-deferred",
						warmCommand: () => ({ type: "pre-warm", sessionId: "s", input }),
						snapshotCommandSettings: () => ({}),
						sameAccountLogin: () => true,
						recoverCommands: (sql) =>
							Effect.gen(function* () {
								if (recovered) {
									const [session] = yield* sql<{
										version: number;
									}>`SELECT version FROM sessions WHERE id = 's'`;
									expect(session?.version).toBeGreaterThan(recoveryVersion);
									expect(
										yield* sql`SELECT status, error_code, run_id FROM provider_command_outbox`,
									).toEqual([
										{
											status: "running",
											error_code: "delivery_indeterminate",
											run_id: "unknown-run",
										},
									]);
									expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
										{ status: "pending" },
									]);
								}
								return [];
							}),
					};
					const runner = yield* makeProcessSessionRunner(
						{ workspaceRoot: root, daemonConfigDir: root },
						(output) => {
							outputs.push(output);
							return Effect.succeed({});
						},
						driver,
					);
					if (recovered) {
						const store = yield* Effect.serviceOption(SqlClient.SqlClient);
						if (store._tag === "None")
							return yield* Effect.die("Missing test store");
						const sql = store.value;
						yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 1, 1)`;
						const commit = yield* makeCommitAndSignal;
						yield* commit([
							canonicalEvent(
								"run.requested",
								"s",
								{ runId: "unknown-run", inputId: "unknown" },
								{ provider: "claude" },
							),
							canonicalEvent(
								"message.created",
								"s",
								{ sessionId: "s", messageId: "unknown", role: "user" },
								{ provider: "claude", metadata: { runId: "unknown-run" } },
							),
						]);
						yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, command_type, status, created_at, updated_at) VALUES ('unknown', 's', 'test-project', 'send_turn', 'side_effect_requested', 1, 1)`;
						yield* sql`INSERT INTO provider_command_outbox (command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at, error_code) VALUES ('unknown', 'test-project', 's', 'claude', 'send_turn', 'unknown-run', '{}', 'running', 1, 1, 1, ${mode === "no-journal-marked" || mode === "no-journal-marked-retained" ? "delivery_indeterminate" : null})`;
						const directory = prepareRunnerDirectory(root, root);
						const registration = {
							runnerId: "abcdef123456",
							sessionId: "s",
							socketPath: join(directory, "abcdef123456"),
							buildId: "main-without-run-ids",
							pid: 99_999_999,
						};
						registerRunner(registration);
						transport.discover.mockReturnValue([registration]);
						recoveryVersion =
							(yield* sql<{
								version: number;
							}>`SELECT version FROM sessions WHERE id = 's'`)[0]?.version ?? 0;
						yield* runner.recoverEffect;
					} else {
						yield* runner.executeEffect({
							type: "pre-warm",
							sessionId: "s",
							input,
						});
					}
					expect(runner.inputAdmission.isHeld("s")).toBe(true);
					if (mode === "racing-folders") {
						const refused = yield* Effect.result(
							runner
								.executeEffect({
									type: "send-turn",
									sinkId: "B:1",
									aborted: false,
									input: {
										...input,
										inputId: "B",
										runId: "run-B",
										prompt: "B",
										history: [],
										extraFolders: [join(root, "extra")],
									},
								})
								.pipe(Effect.timeout("100 millis")),
						);
						expect(refused._tag).toBe("Failure");
						if (refused._tag === "Failure")
							expect(refused.failure).toMatchObject({
								code: "runner_input_held",
							});
						expect(outputs).toEqual([{ type: "release-sink", sinkId: "B:1" }]);
					}
					for (const command of [
						{ type: "interrupt", sessionId: "s" },
						{
							type: "resolve-permission",
							sessionId: "s",
							requestId: "approval",
							decision: "once",
						},
						{
							type: "resolve-question",
							sessionId: "s",
							requestId: "question",
							answers: {},
						},
						{ type: "stop-task", sessionId: "s", taskId: "task" },
					] satisfies SessionCommand[])
						yield* runner.executeEffect(command);
					expect(
						delivered
							.filter(({ build }) => build === "main-without-run-ids")
							.map(({ type }) => type),
					).toEqual([
						...(recovered ? [] : ["pre-warm"]),
						"interrupt",
						"resolve-permission",
						"resolve-question",
						"stop-task",
					]);
					const parked =
						mode === "settings-snapshot" ||
						mode === "adoption-race" ||
						recovered
							? yield* Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient;
									const ingestion = yield* ProviderRuntimeIngestionTag;
									const commit = yield* makeCommitAndSignal;
									if (!recovered)
										yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 1, 1)`;
									yield* commit([
										canonicalEvent(
											"run.requested",
											"s",
											{ runId: "run-B", inputId: "B" },
											{ provider: "claude" },
										),
										canonicalEvent(
											"message.created",
											"s",
											{ sessionId: "s", messageId: "B", role: "user" },
											{ provider: "claude", metadata: { runId: "run-B" } },
										),
									]);
									yield* sql`INSERT INTO provider_command_outbox (command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at) VALUES ('B', 'test-project', 's', 'test', 'send_turn', 'run-B', ${JSON.stringify({ ...input, inputId: "B", prompt: "B", history: [] })}, 'pending', 0, 1, 1)`;
									yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, command_type, status, created_at, updated_at) VALUES ('B', 's', 'test-project', 'send_turn', 'side_effect_requested', 1, 1)`;
									let admissionChecked = false;
									const provider: ProviderInstance = {
										providerId: "test",
										inputAdmission: {
											...runner.inputAdmission,
											isHeld: (sessionId) => {
												// Hello establishes the hold after this admission read.
												if (mode === "adoption-race" && !admissionChecked) {
													admissionChecked = true;
													return false;
												}
												return runner.inputAdmission.isHeld(sessionId);
											},
										},
										discoverEffect: () => Effect.die("unused discovery"),
										interruptTurnEffect: () => Effect.void,
										resolvePermissionEffect: () => Effect.void,
										resolveQuestionEffect: () => Effect.void,
										endSessionEffect: () => Effect.void,
										shutdownEffect: () => Effect.void,
										sendTurnEffect: (input) =>
											runner
												.executeEffect({
													type: "send-turn",
													input,
													sinkId: "B:1",
													aborted: false,
												})
												.pipe(
													Effect.tap(() =>
														input.eventSink.push({
															eventId: "B-terminal",
															providerId: "claude",
															sessionId: "s",
															runId: "run-B",
															type: "turn.completed",
															providerRefs: {},
															rawSource: { kind: "test.native-result" },
															createdAt: Date.now(),
															data: { messageId: "" },
														}),
													),
													Effect.mapError(
														(cause) =>
															new ProviderInstanceFailure({
																providerId: "test",
																operation: "send-turn",
																cause,
															}),
													),
												),
									};
									const reactor = new ProviderSideEffectReactor({
										projectId: "test-project",
										sql,
										write: commit.write,
										ingestion,
										registry: new ProviderRegistry([provider]),
										outcomePollInterval: "1 millis",
									});
									const waiting = yield* Effect.forkChild(
										reactor.runCommand("B"),
									);
									yield* Effect.sleep("10 millis");
									expect(
										yield* sql`SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = 'B'`,
									).toEqual([
										{
											status: "pending",
											attempt_count: mode === "adoption-race" ? 1 : 0,
										},
									]);
									expect(
										delivered.some(({ type }) => type === "send-turn"),
									).toBe(false);
									return waiting;
								})
							: undefined;
					const lift = yield* runner.inputAdmission.changes;
					const opened = yield* Effect.forkChild(Stream.runHead(lift));
					if (mode === "stop-bound") {
						// Stop has durably retired A while the native reply never ends.
						yield* runner.inputAdmission.afterStop?.("s") ?? Effect.void;
					} else if (mode === "no-journal-death") closeLegacy?.();
					else boundary?.({ quiescent: true, revision: 2 });
					yield* Fiber.join(opened).pipe(Effect.timeout("3 seconds"));
					expect(runner.inputAdmission.isHeld("s")).toBe(false);
					if (recovered) {
						const sql = yield* SqlClient.SqlClient;
						expect(
							yield* sql`SELECT state, run_id, started_at FROM turns WHERE id = 'unknown'`,
						).toEqual([
							{ state: "error", run_id: "unknown-run", started_at: null },
						]);
						expect(
							yield* sql`SELECT status FROM provider_runs WHERE id = 'unknown-run'`,
						).toEqual([{ status: "error" }]);
						expect(
							yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'unknown'`,
						).toEqual([{ status: "failed" }]);
						expect(
							yield* sql`SELECT status FROM command_receipts WHERE command_id = 'unknown'`,
						).toEqual([{ status: "side_effect_failed" }]);
						expect(
							yield* sql`SELECT type, json_extract(data, '$.error') AS reason FROM events WHERE json_extract(metadata, '$.runId') = 'unknown-run' AND type = 'turn.error'`,
						).toEqual([
							{
								type: "turn.error",
								reason: "Delivery could not be confirmed across the upgrade",
							},
						]);
					}
					if (mode === "restart-rejects" || mode === "restart-stalls") {
						yield* Effect.tryPromise(() =>
							vi.waitFor(
								() => {
									const warnings = readFileSync(logFile, "utf8")
										.split("\n")
										.filter(
											(line) =>
												line.includes('"level":40') &&
												line.includes("Legacy runner restart failed:"),
										);
									expect(warnings).toHaveLength(1);
									expect(warnings[0]).toMatch(
										/session=s runner=[a-f0-9]+ build=main-without-run-ids:/,
									);
									expect(warnings[0]).toContain(
										mode === "restart-rejects"
											? "Restart rejected"
											: "Runner restart timed out",
									);
								},
								{ timeout: 1000, interval: 10 },
							),
						);
					}
					// Even a legacy runner with a settings snapshot retires by restart.
					expect(
						delivered.filter(({ type }) => type === "end-session"),
					).toEqual(
						mode === "no-journal-death"
							? []
							: [{ build: "main-without-run-ids", type: "end-session" }],
					);
					expect(
						delivered.filter(
							({ build, type }) =>
								build === runnerBuildId() && type === "pre-warm",
						),
					).toEqual([]);
					const sent = parked
						? yield* Effect.result(Fiber.join(parked))
						: yield* Effect.result(
								runner.executeEffect({
									type: "send-turn",
									sinkId: "B:1",
									aborted: false,
									input: {
										...input,
										inputId: "B",
										runId: "run-B",
										prompt: "B",
										history: [],
									},
								}),
							);
					if (parked) {
						const sql = yield* SqlClient.SqlClient;
						expect(
							yield* sql`SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = 'B'`,
						).toEqual([
							{
								status: "completed",
								attempt_count: mode === "adoption-race" ? 2 : 1,
							},
						]);
						expect(
							yield* sql`SELECT status FROM command_receipts WHERE command_id = 'B'`,
						).toEqual([{ status: "side_effect_completed" }]);
					}
					if (mode === "restart-spawn-fails") {
						expect(sent._tag).toBe("Failure");
						if (sent._tag === "Failure")
							expect(sent.failure.message).toContain(
								"Replacement startup rejected",
							);
					} else expect(sent._tag).toBe("Success");
					expect(delivered.filter(({ type }) => type === "send-turn")).toEqual(
						mode === "restart-spawn-fails"
							? []
							: [{ build: runnerBuildId(), type: "send-turn" }],
					);
				}),
			).pipe(
				Effect.timeout("6 seconds"),
				Effect.provide(
					Layer.provideMerge(
						makeProviderRuntimeIngestionLive(),
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
			),
		);
	});
}
