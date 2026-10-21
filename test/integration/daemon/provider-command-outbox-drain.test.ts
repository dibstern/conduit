import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	OpenCodeInstancesTag,
	OpenCodeUnavailable,
} from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	OpenCodeApiError,
	OpenCodeConnectionError,
} from "../../../src/lib/errors.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	type CommitAndSignal,
	makeCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { SessionRollupProjects } from "../../../src/lib/persistence/effect/session-rollup-projects.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import {
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../src/lib/provider/orchestration-read-model.js";
import type { ProviderCommandStoreFailure } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type {
	ProviderInstance,
	TurnResult,
} from "../../../src/lib/provider/types.js";
import {
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { createMockEventSink } from "../../helpers/mock-sdk.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface OutboxState {
	status: string;
	attempt_count: number;
	next_attempt_at: number | null;
}

const artifactDirectory =
	process.env["CONDUIT_TEST_ARTIFACT_DIR"] ??
	join(tmpdir(), "conduit-integration-artifacts");

// These scheduling cases exercise the real engine, writer and SQLite store
// without starting a daemon or moving the legacy browser control callers.
describe("durable control outbox scheduling", () => {
	function controlApi(options: Partial<OpenCodeAPI>) {
		const api = makeMockOpenCodeAPI(options);
		vi.mocked(api.session.get).mockResolvedValue({
			id: "control-session",
			projectID: "control-project",
			title: "Control",
			version: "1",
			time: { created: 1, updated: 1 },
			directory: "/tmp/control-project",
		});
		return api;
	}

	function fixture() {
		const persistence = makePersistenceEffectLayer(
			":memory:",
			"control-project",
		);
		return Layer.merge(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		);
	}

	function engine(
		instance: ProviderInstance,
		now: () => number = () => 1000,
		projectId = "control-project",
		sessionId = "control-session",
		wrapWrite?: (write: CommitAndSignal["write"]) => CommitAndSignal["write"],
	) {
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const commit = yield* makeCommitAndSignal;
			yield* sql`INSERT OR IGNORE INTO sessions (id, project_id, provider, created_at, updated_at) VALUES (${sessionId}, ${projectId}, 'opencode', 1000, 1000)`;
			const snapshot = yield* new CommandReadModelRepository(
				sql,
				projectId,
			).bootstrap();
			const result = new OrchestrationEngine({
				registry: new ProviderRegistry([instance]),
				durableCommands: {
					sql,
					ingestion,
					snapshot,
					projectKey: projectId,
					now,
					generateId: () => "control-dispatch",
					write: wrapWrite ? wrapWrite(commit.write) : commit.write,
				},
			});
			result.bindSession(sessionId, "opencode");
			return result;
		});
	}

	function provider(
		send: ProviderInstance["sendTurnEffect"],
	): ProviderInstance {
		return {
			providerId: "opencode",
			discoverEffect: () => Effect.die("Not used by controls"),
			generateTextEffect: () => Effect.die("Not used by controls"),
			sendTurnEffect: send,
			interruptTurnEffect: vi.fn(() => Effect.void),
			resolvePermissionEffect: vi.fn(() => Effect.void),
			resolveQuestionEffect: vi.fn(() => Effect.void),
			endSessionEffect: vi.fn(() => Effect.void),
			shutdownEffect: () => Effect.void,
		};
	}

	function send(): SendTurnCommand {
		return {
			type: "send_turn",
			commandId: "blocked-send",
			providerId: "opencode",
			input: {
				sessionId: "control-session",
				inputId: "blocked-input",
				prompt: "Wait for a control",
				history: [],
				providerState: {},
				workspaceRoot: "/tmp/control-project",
				extraFolders: [],
				configDir: configuredClaudeConfigDir("/tmp/control-test-claude"),
				folderSource: "account",
				eventSink: createMockEventSink(),
				abortSignal: new AbortController().signal,
			},
		};
	}

	it("reserves a URL-only control before post-commit publication can drain it", async () => {
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: false,
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let accepting: OrchestrationEngine;
				const wrapWrite =
					(write: CommitAndSignal["write"]): CommitAndSignal["write"] =>
					(body, options) =>
						write(body, options).pipe(
							Effect.tap((result) =>
								result &&
								typeof result === "object" &&
								"newlyAccepted" in result &&
								result.newlyAccepted === true
									? accepting.drainSideEffects().pipe(Effect.orDie)
									: Effect.void,
							),
						);
				accepting = yield* engine(
					new OpenCodeProviderInstance({
						client: api,
						clientForSession: () => Effect.succeed(api),
						configDir: "/tmp/control-test-config",
					}),
					undefined,
					undefined,
					undefined,
					wrapWrite,
				);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('card', 'control-session', 'permission', 'pending', 'shared-process', 'native-answer', 1)`;
				const command = {
					type: "resolve_permission" as const,
					commandId: "publication-answer",
					sessionId: "control-session",
					requestId: "card",
					decision: "once" as const,
					providerProcessId: "shared-process",
				};
				expect(
					yield* Effect.result(accepting.dispatchEffect(command)),
				).toMatchObject({ _tag: "Success" });
				yield* accepting.dispatchEffect(command);
				expect(api.permission.reply).toHaveBeenCalledTimes(1);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "completed", attempt_count: 1 }]);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it("removes a live control reservation when its acceptance transaction rolls back", async () => {
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: false,
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = new OpenCodeProviderInstance({
					client: api,
					clientForSession: () => Effect.succeed(api),
					configDir: "/tmp/control-test-config",
				});
				const rollback =
					(write: CommitAndSignal["write"]): CommitAndSignal["write"] =>
					(body, options) =>
						write(
							(project, stamp) =>
								body(project, stamp).pipe(
									Effect.tap((result) =>
										result &&
										typeof result === "object" &&
										"newlyAccepted" in result &&
										result.newlyAccepted === true
											? sql.unsafe("SELECT * FROM force_acceptance_rollback")
											: Effect.void,
									),
								),
							options,
						);
				const accepting = yield* engine(
					instance,
					undefined,
					undefined,
					undefined,
					rollback,
				);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('card', 'control-session', 'permission', 'pending', 'shared-process', 'native-answer', 1)`;
				const command = {
					type: "resolve_permission" as const,
					commandId: "rolled-back-answer",
					sessionId: "control-session",
					requestId: "card",
					decision: "once" as const,
					providerProcessId: "shared-process",
				};
				expect(
					yield* Effect.result(accepting.dispatchEffect(command)),
				).toMatchObject({ _tag: "Failure" });
				expect(
					yield* sql`SELECT command_id FROM provider_command_outbox`,
				).toEqual([]);
				expect(yield* sql`SELECT command_id FROM command_receipts`).toEqual([]);
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: "pending" },
				]);
				// A different daemon commits that id and stops before delivery. The
				// rolled-back registration must not authorize its URL-only replay.
				const stopAfterCommit =
					(write: CommitAndSignal["write"]): CommitAndSignal["write"] =>
					(body, options) =>
						write(body, options).pipe(
							Effect.tap((result) =>
								result &&
								typeof result === "object" &&
								"newlyAccepted" in result &&
								result.newlyAccepted === true
									? Effect.die("stopped after commit")
									: Effect.void,
							),
						);
				const otherDaemon = yield* engine(
					instance,
					undefined,
					undefined,
					undefined,
					stopAfterCommit,
				);
				yield* Effect.exit(otherDaemon.dispatchEffect(command));
				yield* accepting.drainSideEffects();
				expect(api.permission.reply).not.toHaveBeenCalled();
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "cancelled", error_code: "provider_process_unavailable" },
				]);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it.each([
		[undefined, 2000],
		["3", 4000],
		[new Date(5000).toUTCString(), 5000],
		["invalid", 2000],
		["-1", 2000],
	] as const)("retries HTTP 429 with Retry-After %s at %s", async (retryAfter, deadline) => {
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: true,
		});
		const throttled = Object.assign(
			new OpenCodeApiError({
				message: "Too Many Requests",
				endpoint: "/permission/native-answer",
				responseStatus: 429,
			}),
			{ retryAfter },
		);
		vi.mocked(api.permission.reply)
			.mockRejectedValueOnce(throttled)
			.mockResolvedValue(undefined);
		vi.mocked(api.permission.list).mockRejectedValue(throttled);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let now = 1000;
				const instance = new OpenCodeProviderInstance({
					client: api,
					clientForSession: () => Effect.succeed(api),
					configDir: "/tmp/control-test-config",
				});
				const accepting = yield* engine(instance, () => now);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('card', 'control-session', 'permission', 'pending', 'shared-process', 'native-answer', 1)`;
				yield* Effect.result(
					accepting.dispatchEffect({
						type: "resolve_permission",
						commandId: "throttled-answer",
						sessionId: "control-session",
						requestId: "card",
						decision: "once",
						providerProcessId: "shared-process",
					}),
				);
				expect(
					yield* sql`SELECT status, attempt_count, next_attempt_at FROM provider_command_outbox`,
				).toEqual([
					{
						status: "retryable_failed",
						attempt_count: 1,
						next_attempt_at: deadline,
					},
				]);
				const restarted = yield* engine(instance, () => now);
				now = deadline - 1;
				yield* restarted.drainSideEffects();
				expect(api.permission.reply).toHaveBeenCalledTimes(1);
				now = deadline;
				yield* restarted.drainSideEffects();
				expect(api.permission.reply).toHaveBeenCalledTimes(2);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "completed", attempt_count: 2 }]);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	// A crash in attempt five, including a rolled-back reopen, cannot buy a
	// sixth delivery. Terminal outcome, receipt and reopen must commit together.
	it.each([
		"running",
		"pending",
		"retryable_failed",
		"reopen-rollback",
		"consumed",
	] as const)("enforces the persisted budget before replay of %s", async (state) => {
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: true,
		});
		const outage = new OpenCodeConnectionError({ message: "provider offline" });
		vi.mocked(api.permission.reply).mockRejectedValue(outage);
		vi.mocked(api.permission.list).mockRejectedValue(outage);
		if (state === "consumed") {
			vi.mocked(api.permission.list).mockResolvedValue([]);
			vi.mocked(api.session.get).mockResolvedValue({
				id: "control-session",
				projectID: "control-project",
				title: "Control",
				version: "1",
				time: { created: 1, updated: 1 },
				directory: "/tmp/control-project",
			});
		}
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = new OpenCodeProviderInstance({
					client: api,
					clientForSession: () => Effect.succeed(api),
					configDir: "/tmp/control-test-config",
				});
				const accepting = yield* engine(instance);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('card', 'control-session', 'permission', 'pending', 'shared-process', 'native-answer', 1)`;
				yield* Effect.result(
					accepting.dispatchEffect({
						type: "resolve_permission",
						commandId: "crashed-answer",
						sessionId: "control-session",
						requestId: "card",
						decision: "once",
						providerProcessId: "shared-process",
					}),
				);
				if (state === "reopen-rollback") {
					yield* sql`UPDATE provider_command_outbox SET attempt_count = 4, next_attempt_at = 0`;
					yield* sql.unsafe(
						`CREATE TRIGGER interrupt_reopen BEFORE UPDATE ON pending_approvals WHEN OLD.status = 'resolved' AND NEW.status = 'pending' BEGIN SELECT RAISE(ABORT, 'crash during reopen'); END`,
					);
					yield* accepting.drainSideEffects();
					expect(
						yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([{ status: "running", attempt_count: 5 }]);
					expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
						{ status: "side_effect_requested" },
					]);
					expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
						{ status: "resolved" },
					]);
					expect(
						yield* sql`SELECT type FROM events WHERE json_extract(metadata, '$.source') = 'conduit.control-reconciliation'`,
					).toEqual([]);
					yield* sql.unsafe("DROP TRIGGER interrupt_reopen");
				} else {
					yield* sql`UPDATE provider_command_outbox SET status = ${state === "consumed" ? "running" : state}, attempt_count = 5, next_attempt_at = 0`;
				}
				const delivered = vi.mocked(api.permission.reply).mock.calls.length;
				const restarted = yield* engine(instance);
				yield* restarted.drainSideEffects();
				yield* restarted.drainSideEffects();
				expect(api.permission.reply).toHaveBeenCalledTimes(delivered);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "failed", attempt_count: 5 }]);
				expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
					{ status: "side_effect_failed" },
				]);
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: state === "consumed" ? "resolved" : "pending" },
				]);
				expect(
					yield* sql`SELECT type FROM events WHERE json_extract(metadata, '$.source') = 'conduit.control-reconciliation'`,
				).toEqual(state === "consumed" ? [] : [{ type: "permission.asked" }]);
				yield* restarted.dispatchEffect({
					type: "interrupt_turn",
					commandId: "stop-after-crash",
					turnIds: ["in-flight-turn"],
					sessionId: "control-session",
					providerProcessId: "shared-process",
				});
				expect(api.session.abort).toHaveBeenCalledTimes(1);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it.each([
		{ origin: "current daemon", rollback: false },
		{ origin: "recovered", rollback: false },
		{ origin: "current daemon", rollback: true },
		{ origin: "recovered", rollback: true },
	])("protects a $origin fifth control delivery across sweeps (outcome rollback: $rollback)", async ({
		origin,
		rollback,
	}) => {
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: true,
		});
		let release: (() => void) | undefined;
		vi.mocked(api.permission.reply)
			.mockRejectedValueOnce(
				new OpenCodeConnectionError({ message: "connection reset" }),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = () => resolve(undefined);
					}),
			);
		vi.mocked(api.permission.list).mockRejectedValue(
			new OpenCodeConnectionError({ message: "reconciliation offline" }),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = new OpenCodeProviderInstance({
					client: api,
					clientForSession: () => Effect.succeed(api),
					configDir: "/tmp/control-test-config",
				});
				const accepting = yield* engine(instance);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('card', 'control-session', 'permission', 'pending', 'shared-process', 'native-answer', 1)`;
				const command = {
					type: "resolve_permission" as const,
					commandId: "live-fifth-answer",
					sessionId: "control-session",
					requestId: "card",
					decision: "once" as const,
					providerProcessId: "shared-process",
				};
				yield* Effect.result(accepting.dispatchEffect(command));
				yield* sql`UPDATE provider_command_outbox SET attempt_count = 4, next_attempt_at = 0`;
				const executor =
					origin === "recovered" ? yield* engine(instance) : accepting;
				const delivery = yield* Effect.forkChild(executor.drainSideEffects());
				while (!release) yield* Effect.sleep("1 millis");
				const stopping = yield* Effect.forkChild(
					executor.dispatchEffect({
						type: "interrupt_turn",
						commandId: "stop-behind-fifth-answer",
						turnIds: ["in-flight-turn"],
						sessionId: "control-session",
						providerProcessId: "shared-process",
					}),
				);
				while (
					!(yield* sql`SELECT command_id FROM provider_command_outbox WHERE command_id = 'stop-behind-fifth-answer'`)
						.length
				)
					yield* Effect.sleep("1 millis");
				yield* executor.drainSideEffects();
				yield* executor.drainSideEffects();
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = ${command.commandId}`,
				).toEqual([{ status: "running", attempt_count: 5 }]);
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: "resolved" },
				]);
				expect(api.session.abort).not.toHaveBeenCalled();
				if (rollback)
					yield* sql.unsafe(
						`CREATE TRIGGER interrupt_outcome BEFORE UPDATE ON command_receipts WHEN NEW.command_id = 'live-fifth-answer' AND NEW.status = 'side_effect_completed' BEGIN SELECT RAISE(ABORT, 'outcome rollback'); END`,
					);
				release();
				yield* Fiber.join(delivery);
				if (rollback) {
					expect(
						yield* sql`SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = ${command.commandId}`,
					).toEqual([{ status: "running", attempt_count: 5 }]);
					expect(
						yield* sql`SELECT status FROM command_receipts WHERE command_id = ${command.commandId}`,
					).toEqual([{ status: "side_effect_requested" }]);
					expect(api.session.abort).not.toHaveBeenCalled();
					yield* sql.unsafe("DROP TRIGGER interrupt_outcome");
					// The failed commit released execution ownership. Recover the
					// exhausted row in this process without a sixth provider call.
					yield* executor.drainSideEffects();
				} else yield* executor.dispatchEffect(command);
				yield* Fiber.join(stopping);
				yield* executor.drainSideEffects();
				expect(api.permission.reply).toHaveBeenCalledTimes(2);
				expect(api.session.abort).toHaveBeenCalledTimes(1);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([
					{ status: rollback ? "failed" : "completed", attempt_count: 5 },
					{ status: "completed", attempt_count: 1 },
				]);
				expect(
					yield* sql`SELECT status FROM command_receipts WHERE command_id = ${command.commandId}`,
				).toEqual([
					{ status: rollback ? "side_effect_failed" : "side_effect_completed" },
				]);
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: rollback ? "pending" : "resolved" },
				]);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
				Effect.timeout("5 seconds"),
			),
		);
	});

	// Failure modes: real adapter errors lack retryable flags; a rejected answer
	// can retain the process queue across projects/restart, or exhaust retries
	// without ending its receipt. A consumed prompt must never be resurrected.
	it.each([
		["permission", 400, false, false],
		["permission", 404, false, false],
		["question", 404, false, false],
		["reject", 400, false, false],
		["permission", 400, true, false],
		["question", 400, true, false],
		["reject", 400, true, false],
		["permission", 400, true, true],
		["question", 400, true, true],
	] as const)("terminalizes a permanent OpenCode %s %s, pending=%s, legacy=%s, and releases another project's Stop after restart", async (kind, responseStatus, stillPending, legacy) => {
		const nativeRequestId = legacy ? "bad-card" : "native-answer";
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: true,
		});
		const reply =
			kind === "permission"
				? api.permission.reply
				: kind === "question"
					? api.question.reply
					: api.question.reject;
		vi.mocked(api.session.get).mockResolvedValue({
			id: "control-session",
			projectID: "control-project",
			title: "Control",
			version: "1",
			time: { created: 1, updated: 1 },
			directory: "/tmp/control-project",
		});
		vi.mocked(api.permission.list).mockResolvedValue(
			stillPending
				? [
						{
							id: nativeRequestId,
							permission: "bash",
							patterns: [],
							sessionID: "control-session",
							metadata: {},
							always: [],
						},
					]
				: [],
		);
		vi.mocked(api.question.list).mockResolvedValue(
			stillPending ? [{ id: nativeRequestId }] : [],
		);
		vi.mocked(reply).mockRejectedValue(
			new OpenCodeApiError({
				message: "Request already consumed or unknown",
				endpoint: "/answer/native-answer",
				responseStatus,
			}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let now = 1000;
				const instance = new OpenCodeProviderInstance({
					client: api,
					clientForSession: () => Effect.succeed(api),
					configDir: "/tmp/control-test-config",
				});
				const accepting = yield* engine(instance, () => now);
				const other = yield* engine(
					instance,
					() => now,
					"other-project",
					"other-session",
				);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('bad-card', 'control-session', ${kind === "permission" ? "permission" : "question"}, 'pending', 'shared-process', ${legacy ? null : nativeRequestId}, 1), ('unrelated-card', 'control-session', 'question', 'pending', 'shared-process', 'native-other', 1)`;
				const command =
					kind === "permission"
						? {
								type: "resolve_permission" as const,
								commandId: "bad-answer",
								sessionId: "control-session",
								requestId: "bad-card",
								decision: "once" as const,
								providerProcessId: "shared-process",
							}
						: {
								type: "resolve_question" as const,
								commandId: "bad-answer",
								sessionId: "control-session",
								requestId: "bad-card",
								answers: {},
								operation:
									kind === "reject" ? ("reject" as const) : ("reply" as const),
								providerProcessId: "shared-process",
							};
				expect(
					yield* Effect.result(accepting.dispatchEffect(command)),
				).toMatchObject({ _tag: "Failure" });
				const stop = yield* Effect.forkChild(
					other.dispatchEffect({
						type: "interrupt_turn",
						commandId: "later-stop",
						turnIds: ["in-flight-turn"],
						sessionId: "other-session",
						providerProcessId: "shared-process",
					}),
				);
				yield* Effect.sleep("20 millis");
				const restarted = yield* engine(instance, () => now);
				const restartedOther = yield* engine(
					instance,
					() => now,
					"other-project",
					"other-session",
				);
				now = 100_000;
				yield* restarted.drainSideEffects();
				yield* restartedOther.drainSideEffects();
				expect(
					yield* sql`SELECT command_id, status, attempt_count, next_attempt_at FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{
						command_id: "bad-answer",
						status: "failed",
						attempt_count: 1,
						next_attempt_at: null,
					},
					{
						command_id: "later-stop",
						status: "completed",
						attempt_count: 1,
						next_attempt_at: null,
					},
				]);
				expect(
					yield* sql`SELECT status, error FROM command_receipts WHERE command_id = 'bad-answer'`,
				).toEqual([
					{
						status: "side_effect_failed",
						error: expect.stringContaining(
							"Request already consumed or unknown",
						),
					},
				]);
				expect(
					yield* sql`SELECT id, status FROM pending_approvals ORDER BY id`,
				).toEqual([
					{ id: "bad-card", status: stillPending ? "pending" : "resolved" },
					{ id: "unrelated-card", status: "pending" },
				]);
				expect(
					yield* Effect.result(restarted.dispatchEffect(command)),
				).toMatchObject({
					_tag: "Failure",
					failure: {
						cause: expect.objectContaining({
							message: expect.stringContaining(
								"Request already consumed or unknown",
							),
						}),
					},
				});
				expect(reply).toHaveBeenCalledTimes(1);
				expect(api.session.abort).toHaveBeenCalledTimes(1);
				yield* Fiber.join(stop);
				if (stillPending) {
					vi.mocked(reply).mockResolvedValue(undefined);
					yield* restarted.dispatchEffect({
						...command,
						commandId: "corrected-answer",
					});
					expect(reply).toHaveBeenCalledTimes(2);
					expect(
						yield* sql`SELECT status FROM pending_approvals WHERE id = 'bad-card'`,
					).toEqual([{ status: "resolved" }]);
					expect(
						yield* sql`SELECT status FROM command_receipts WHERE command_id = 'corrected-answer'`,
					).toEqual([{ status: "side_effect_completed" }]);
					expect(
						yield* sql`SELECT type FROM events WHERE json_extract(metadata, '$.source') = 'conduit.control-reconciliation'`,
					).toEqual([
						{
							type:
								kind === "permission" ? "permission.asked" : "question.asked",
						},
					]);
				}
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it.each([
		"permanent",
		"cap",
		"unknown",
	] as const)("bounds answer retries: %s, including restart mid-backoff", async (ending) => {
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: true,
		});
		let attempts = 0;
		vi.mocked(api.permission.reply).mockImplementation(async () => {
			attempts++;
			if (ending === "unknown")
				throw new Error("unclassified delivery failure");
			if (ending === "permanent" && attempts > 1)
				throw new OpenCodeApiError({
					message: "Request no longer exists",
					endpoint: "/permission/native-answer",
					responseStatus: 404,
				});
			throw new OpenCodeConnectionError({
				message: "Connection reset before delivery",
			});
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let now = 1000;
				const instance = new OpenCodeProviderInstance({
					client: api,
					clientForSession: () => Effect.succeed(api),
					configDir: "/tmp/control-test-config",
				});
				const accepting = yield* engine(instance, () => now);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('bad-card', 'control-session', 'permission', 'pending', 'shared-process', 'native-answer', 1)`;
				yield* Effect.result(
					accepting.dispatchEffect({
						type: "resolve_permission",
						commandId: "bounded-answer",
						sessionId: "control-session",
						requestId: "bad-card",
						decision: "once",
						providerProcessId: "shared-process",
					}),
				);
				const stop = yield* Effect.forkChild(
					accepting.dispatchEffect({
						type: "interrupt_turn",
						commandId: "later-stop",
						turnIds: ["in-flight-turn"],
						sessionId: "control-session",
						providerProcessId: "shared-process",
					}),
				);
				yield* Effect.sleep("20 millis");
				let restarted = yield* engine(instance, () => now);
				yield* restarted.drainSideEffects();
				expect(attempts).toBe(1);
				if (ending !== "unknown") {
					expect(
						yield* sql`SELECT status, next_attempt_at FROM provider_command_outbox WHERE command_id = 'bounded-answer'`,
					).toEqual([{ status: "retryable_failed", next_attempt_at: 2000 }]);
					expect(api.session.abort).not.toHaveBeenCalled();
				}
				const expectedAttempts =
					ending === "cap" ? 5 : ending === "permanent" ? 2 : 1;
				for (let attempt = 1; attempt < expectedAttempts; attempt++) {
					now += 100_000;
					restarted = yield* engine(instance, () => now);
					yield* restarted.drainSideEffects();
				}
				now += 100_000;
				yield* restarted.drainSideEffects();
				expect(
					yield* sql`SELECT command_id, status, attempt_count, next_attempt_at FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{
						command_id: "bounded-answer",
						status: "failed",
						attempt_count: expectedAttempts,
						next_attempt_at: null,
					},
					{
						command_id: "later-stop",
						status: "completed",
						attempt_count: 1,
						next_attempt_at: null,
					},
				]);
				expect(
					yield* sql`SELECT status, error FROM command_receipts WHERE command_id = 'bounded-answer'`,
				).toEqual([
					{
						status: "side_effect_failed",
						error: expect.stringContaining(
							ending === "cap"
								? "Connection reset"
								: ending === "permanent"
									? "Request no longer exists"
									: "unclassified delivery failure",
						),
					},
				]);
				expect(attempts).toBe(expectedAttempts);
				expect(api.session.abort).toHaveBeenCalledTimes(1);
				yield* Fiber.join(stop);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it.each([
		"unreachable",
		"stalled",
		"replaced",
		"newer-resolution",
	] as const)("reconciliation reopens unconfirmed answers without blocking controls or reviving stale prompts: %s", async (scenario) => {
		let processId = "shared-process";
		const api = controlApi({
			promptProcessId: processId,
			controlReplaySafe: true,
		});
		Object.defineProperty(api, "promptProcessId", { get: () => processId });
		vi.mocked(api.session.get).mockResolvedValue({
			id: "control-session",
			projectID: "control-project",
			title: "Control",
			version: "1",
			time: { created: 1, updated: 1 },
			directory: "/tmp/control-project",
		});
		vi.mocked(api.permission.reply).mockRejectedValue(
			new OpenCodeApiError({
				message: "Invalid answer",
				endpoint: "/permission/native-answer",
				responseStatus: 400,
			}),
		);
		let release:
			| ((pending: Awaited<ReturnType<typeof api.permission.list>>) => void)
			| undefined;
		vi.mocked(api.permission.list).mockImplementation(() =>
			scenario === "unreachable"
				? Promise.reject(
						new OpenCodeConnectionError({ message: "list unreachable" }),
					)
				: new Promise((resolve) => {
						release = resolve;
					}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const store = yield* EventStoreEffectTag;
				const instance = new OpenCodeProviderInstance({
					client: api,
					clientForSession: () => Effect.succeed(api),
					configDir: "/tmp/control-test-config",
				});
				const accepting = yield* engine(instance);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('bad-card', 'control-session', 'permission', 'pending', 'shared-process', 'native-answer', 1)`;
				const answering = yield* Effect.forkChild(
					Effect.result(
						accepting.dispatchEffect({
							type: "resolve_permission",
							commandId: "bad-answer",
							sessionId: "control-session",
							requestId: "bad-card",
							decision: "once",
							providerProcessId: "shared-process",
						}),
					),
				);
				if (scenario === "replaced" || scenario === "newer-resolution") {
					while (!release) yield* Effect.sleep("1 millis");
					if (scenario === "replaced") processId = "replacement-process";
					else
						yield* commit.write((project) =>
							store
								.append(
									canonicalEvent("permission.resolved", "control-session", {
										id: "bad-card",
										decision: "reject",
										providerProcessId: "shared-process",
										providerRequestId: "native-answer",
									}),
								)
								.pipe(Effect.flatMap((event) => project([event]))),
						);
					release([
						{
							id: "native-answer",
							permission: "bash",
							patterns: [],
							sessionID: "control-session",
							metadata: {},
							always: [],
						},
					]);
				}
				expect(yield* Fiber.join(answering)).toMatchObject({ _tag: "Failure" });
				expect(
					yield* sql`SELECT status FROM pending_approvals WHERE id = 'bad-card'`,
				).toEqual([
					{
						status:
							scenario === "unreachable" || scenario === "stalled"
								? "pending"
								: "resolved",
					},
				]);
				expect(
					yield* sql`SELECT status, error FROM command_receipts WHERE command_id = 'bad-answer'`,
				).toEqual([
					{
						status: "side_effect_failed",
						error: expect.stringContaining("Invalid answer"),
					},
				]);
				yield* accepting.dispatchEffect({
					type: "interrupt_turn",
					commandId: "later-stop",
					turnIds: ["in-flight-turn"],
					sessionId: "control-session",
					providerProcessId: processId,
				});
				expect(api.session.abort).toHaveBeenCalledTimes(1);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
				Effect.timeout("3 seconds"),
			),
		);
	});

	// Unconfirmed terminal answers must reopen durably, accept a provider re-ask,
	// and permit a fresh answer once, while releasing Stop/End behind the failure.
	it.each([
		"permission",
		"question",
		"reject",
	] as const)("reopens an exhausted %s answer through a durable ask and delivers its replacement once", async (kind) => {
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: true,
		});
		const reply =
			kind === "permission"
				? api.permission.reply
				: kind === "question"
					? api.question.reply
					: api.question.reject;
		const outage = new OpenCodeConnectionError({ message: "provider offline" });
		vi.mocked(reply).mockRejectedValue(outage);
		vi.mocked(api.permission.list).mockRejectedValue(outage);
		vi.mocked(api.question.list).mockRejectedValue(outage);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				let now = 1000;
				const instance = new OpenCodeProviderInstance({
					client: api,
					clientForSession: () => Effect.succeed(api),
					configDir: "/tmp/control-test-config",
				});
				const accepting = yield* engine(instance, () => now);
				const ask = {
					eventId: "original-ask",
					type:
						kind === "permission"
							? ("permission.asked" as const)
							: ("question.asked" as const),
					providerId: "opencode",
					sessionId: "control-session",
					providerRefs: {
						providerProcessId: "shared-process",
						providerRequestId: "native-answer",
					},
					rawSource: { kind: "test" },
					createdAt: now,
					data: {
						id: "native-answer",
						sessionId: "control-session",
						toolName: "bash",
						input: {},
						questions: [],
					},
				};
				yield* ingestion.ingest(ask);
				const [prompt] = yield* sql<{
					id: string;
				}>`SELECT id FROM pending_approvals`;
				if (!prompt) throw new Error("Missing ingested ask");
				const command =
					kind === "permission"
						? {
								type: "resolve_permission" as const,
								commandId: "exhausted-answer",
								sessionId: "control-session",
								requestId: prompt.id,
								decision: "once" as const,
								providerProcessId: "shared-process",
							}
						: {
								type: "resolve_question" as const,
								commandId: "exhausted-answer",
								sessionId: "control-session",
								requestId: prompt.id,
								answers: {},
								operation:
									kind === "reject" ? ("reject" as const) : ("reply" as const),
								providerProcessId: "shared-process",
							};
				yield* Effect.result(accepting.dispatchEffect(command));
				for (let attempt = 1; attempt < 5; attempt++) {
					now += 100_000;
					const restarted = yield* engine(instance, () => now);
					yield* restarted.drainSideEffects();
				}
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "failed", attempt_count: 5 }]);
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: "pending" },
				]);
				expect(
					yield* sql`SELECT type FROM events WHERE json_extract(metadata, '$.source') = 'conduit.control-reconciliation'`,
				).toEqual([{ type: ask.type }]);
				const restarted = yield* engine(instance, () => now);
				for (const type of ["interrupt_turn", "end_session"] as const) {
					yield* restarted.dispatchEffect({
						type,
						commandId: type,
						sessionId: "control-session",
						providerProcessId: "shared-process",
					});
				}
				yield* ingestion.ingest({
					...ask,
					eventId: "provider-reask",
					createdAt: ++now,
				});
				expect(yield* sql`SELECT id, status FROM pending_approvals`).toEqual([
					{ id: prompt.id, status: "pending" },
				]);
				vi.mocked(reply).mockResolvedValue(undefined);
				const replacement = { ...command, commandId: "replacement-answer" };
				yield* restarted.dispatchEffect(replacement);
				yield* restarted.dispatchEffect(replacement);
				const afterRestart = yield* engine(instance, () => now);
				yield* afterRestart.drainSideEffects();
				expect(reply).toHaveBeenCalledTimes(6);
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: "resolved" },
				]);
				expect(
					yield* sql`SELECT command_id, status FROM command_receipts ORDER BY command_id`,
				).toEqual([
					{ command_id: "end_session", status: "side_effect_completed" },
					{ command_id: "exhausted-answer", status: "side_effect_failed" },
					{ command_id: "interrupt_turn", status: "side_effect_completed" },
					{ command_id: "replacement-answer", status: "side_effect_completed" },
				]);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it("retries the production client acquisition's unreachable error before a permanent reply failure", async () => {
		const api = controlApi({
			promptProcessId: "shared-process",
			controlReplaySafe: true,
		});
		vi.mocked(api.permission.reply).mockRejectedValue(
			new OpenCodeApiError({
				message: "Unknown request",
				endpoint: "/permission/native-answer",
				responseStatus: 404,
			}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let now = 1000;
				let attempts = 0;
				const instance = new OpenCodeProviderInstance({
					client: api,
					configDir: "/tmp/control-test-config",
					clientForSession: () =>
						Effect.suspend(() =>
							++attempts === 1
								? Effect.fail(
										new OpenCodeUnavailable({
											instanceId: "opencode",
											reason: "unreachable",
											message: "Connection failed during client acquisition",
										}),
									)
								: Effect.succeed(api),
						),
				});
				const accepting = yield* engine(instance, () => now);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('bad-card', 'control-session', 'permission', 'pending', 'shared-process', 'native-answer', 1)`;
				yield* Effect.result(
					accepting.dispatchEffect({
						type: "resolve_permission",
						commandId: "unreachable-answer",
						sessionId: "control-session",
						requestId: "bad-card",
						decision: "once",
						providerProcessId: "shared-process",
					}),
				);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "retryable_failed", attempt_count: 1 }]);
				const stop = yield* Effect.forkChild(
					accepting.dispatchEffect({
						type: "interrupt_turn",
						commandId: "later-stop",
						turnIds: ["in-flight-turn"],
						sessionId: "control-session",
						providerProcessId: "shared-process",
					}),
				);
				yield* Effect.sleep("20 millis");
				now = 2000;
				const restarted = yield* engine(instance, () => now);
				yield* restarted.drainSideEffects();
				yield* restarted.drainSideEffects();
				expect(
					yield* sql`SELECT command_id, status, attempt_count FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{
						command_id: "unreachable-answer",
						status: "failed",
						attempt_count: 2,
					},
					{ command_id: "later-stop", status: "completed", attempt_count: 1 },
				]);
				expect(
					yield* sql`SELECT status, error FROM command_receipts WHERE command_id = 'unreachable-answer'`,
				).toEqual([
					{
						status: "side_effect_failed",
						error: expect.stringContaining("Unknown request"),
					},
				]);
				expect(api.permission.reply).toHaveBeenCalledTimes(1);
				expect(api.session.abort).toHaveBeenCalledTimes(1);
				yield* Fiber.join(stop);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it.each([
		"pending",
		"running",
		"retryable_failed",
	])("cancels an inactive project's %s head without blocking the shared process", async (status) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const registered = yield* Ref.make<readonly string[]>([
					"removed-project",
					"control-project",
				]);
				const instance = {
					...provider(() => Effect.die("No turn expected")),
					getControlProcessIdEffect: () => Effect.succeed("shared-process"),
				};
				const orchestration = yield* engine(instance);
				for (const [sequence, commandId, projectId, sessionId, state] of [
					[1, "inactive-head", "removed-project", "retained-session", status],
					[2, "active-stop", "control-project", "control-session", "pending"],
				] as const) {
					yield* sql`INSERT INTO command_receipts (command_id, command_type, project_key, session_id, status, fingerprint_hash, fingerprint_version, created_at, updated_at) VALUES (${commandId}, 'interrupt_turn', ${projectId}, ${sessionId}, 'side_effect_requested', 'fixture', 2, 1, 1)`;
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at) VALUES (${sequence}, ${commandId}, ${projectId}, ${sessionId}, 'opencode', 'interrupt_turn', ${JSON.stringify({ type: "interrupt_turn", sessionId, providerProcessId: "shared-process" })}, 'shared-process', ${state}, 1, 1)`;
				}
				const drain = orchestration
					.drainSideEffects()
					.pipe(Effect.provideService(SessionRollupProjects, registered));
				yield* drain;
				expect(instance.interruptTurnEffect).not.toHaveBeenCalled();
				yield* Ref.set(registered, ["control-project"]);
				yield* drain;
				expect(
					yield* sql`SELECT command_id, status, error_code FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{
						command_id: "inactive-head",
						status: "cancelled",
						error_code: "project_inactive",
					},
					{ command_id: "active-stop", status: "completed", error_code: null },
				]);
				expect(
					yield* sql`SELECT status, error_code FROM command_receipts WHERE command_id = 'inactive-head'`,
				).toEqual([
					{ status: "side_effect_failed", error_code: "project_inactive" },
				]);
				const restarted = yield* engine(instance);
				yield* restarted
					.drainSideEffects()
					.pipe(Effect.provideService(SessionRollupProjects, registered));
				expect(instance.interruptTurnEffect).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(fixture())),
		);
	});

	it.each([
		"permission",
		"question",
	] as const)("retries an undelivered %s answer with its stable command after restart", async (kind) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let now = 1000;
				let attempts = 0;
				const answer = () =>
					Effect.suspend(() =>
						++attempts === 1
							? Effect.fail(
									new ProviderInstanceFailure({
										providerId: "opencode",
										operation: `resolve_${kind}`,
										cause: new OpenCodeConnectionError({
											message: "connection reset before delivery",
										}),
									}),
								)
							: Effect.void,
					);
				const instance = {
					...provider(() => Effect.die("No turn expected")),
					getControlProcessIdEffect: () => Effect.succeed("answer-process"),
					resolvePermissionEffect: vi.fn(answer),
					resolveQuestionEffect: vi.fn(answer),
				};
				const orchestration = yield* engine(instance, () => now);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('answer-card', 'control-session', ${kind}, 'pending', 'answer-process', 'native-answer', 1)`;
				const response = {
					decision: "always" as const,
					permissionUpdates: [
						{
							type: "setMode" as const,
							mode: "acceptEdits" as const,
							destination: "session" as const,
						},
					],
				};
				const command =
					kind === "permission"
						? {
								type: "resolve_permission" as const,
								sessionId: "control-session",
								commandId: "automatic-or-browser-answer",
								requestId: "answer-card",
								providerProcessId: "answer-process",
								decision: "always" as const,
								response,
							}
						: {
								type: "resolve_question" as const,
								sessionId: "control-session",
								commandId: "automatic-or-browser-answer",
								requestId: "answer-card",
								providerProcessId: "answer-process",
								answers: {},
								operation: "reject" as const,
							};
				expect(
					yield* Effect.result(orchestration.dispatchEffect(command)),
				).toMatchObject({ _tag: "Failure" });
				expect(
					yield* sql`SELECT status, attempt_count, next_attempt_at FROM provider_command_outbox`,
				).toEqual([
					{
						status: "retryable_failed",
						attempt_count: 1,
						next_attempt_at: 2000,
					},
				]);
				expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
					{ status: "side_effect_requested" },
				]);
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: "resolved" },
				]);
				yield* orchestration.drainSideEffects();
				expect(attempts).toBe(1);
				now = 2000;
				const restarted = yield* engine(instance, () => now);
				yield* restarted.drainSideEffects();
				yield* restarted.drainSideEffects();
				expect(attempts).toBe(2);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "completed", attempt_count: 2 }]);
				expect(
					yield* sql`SELECT status, error_code FROM command_receipts`,
				).toEqual([{ status: "side_effect_completed", error_code: null }]);
				if (kind === "permission")
					expect(instance.resolvePermissionEffect.mock.calls[1]).toEqual([
						"control-session",
						"native-answer",
						"always",
						"answer-process",
						undefined,
						{
							commandId: command.commandId,
							providerProcessId: "answer-process",
							response,
						},
					]);
			}).pipe(Effect.provide(fixture())),
		);
	});

	it.each([
		false,
		true,
	])("keeps URL-only answer retries in their admitting runtime, restarted=%s", async (restart) => {
		const api = controlApi({
			promptProcessId: "url-process",
			controlReplaySafe: false,
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let now = 1000;
				let attempts = 0;
				const instance = {
					...provider(() => Effect.die("No turn expected")),
					resolvePermissionEffect: () =>
						Effect.suspend(() =>
							++attempts === 1
								? Effect.fail(
										new ProviderInstanceFailure({
											providerId: "opencode",
											operation: "resolve_permission",
											cause: new OpenCodeConnectionError({
												message: "connection refused",
											}),
										}),
									)
								: Effect.void,
						),
				};
				const admitted = yield* engine(instance, () => now);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES
				('answer', 'control-session', 'permission', 'pending', 'url-process', 'native-answer', 1),
				('unrelated', 'control-session', 'question', 'pending', 'url-process', 'native-unrelated', 1)`;
				yield* Effect.result(
					admitted.dispatchEffect({
						type: "resolve_permission",
						commandId: "url-answer",
						sessionId: "control-session",
						requestId: "answer",
						decision: "once",
						providerProcessId: "url-process",
					}),
				);
				expect(attempts).toBe(1);
				now = 2000;
				const draining = restart
					? yield* engine(instance, () => now)
					: admitted;
				yield* draining.drainSideEffects();
				yield* draining.drainSideEffects();
				expect(attempts).toBe(restart ? 1 : 2);
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'url-answer'`,
				).toEqual([
					{
						status: restart ? "cancelled" : "completed",
						error_code: restart ? "provider_process_unavailable" : null,
					},
				]);
				expect(
					yield* sql`SELECT status FROM pending_approvals WHERE id = 'unrelated'`,
				).toEqual([{ status: "pending" }]);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it("cancels controls when no projects remain registered and retains pending sends", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const registered = yield* Ref.make<readonly string[]>([]);
				const instance = provider(() => Effect.die("No turn expected"));
				const orchestration = yield* engine(instance);
				for (const [sequence, commandId, effectType] of [
					[1, "removed-stop", "interrupt_turn"],
					[2, "retained-send", "send_turn"],
				] as const) {
					yield* sql`INSERT INTO command_receipts (command_id, command_type, project_key, session_id, status, fingerprint_hash, fingerprint_version, created_at, updated_at) VALUES (${commandId}, ${effectType}, 'removed-project', 'retained-session', 'side_effect_requested', 'fixture', 2, 1, 1)`;
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at) VALUES (${sequence}, ${commandId}, 'removed-project', 'retained-session', 'opencode', ${effectType}, '{}', 'shared-process', 'pending', 1, 1)`;
				}
				yield* orchestration
					.drainSideEffects()
					.pipe(Effect.provideService(SessionRollupProjects, registered));
				expect(
					yield* sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{ command_id: "removed-stop", status: "cancelled" },
					{ command_id: "retained-send", status: "pending" },
				]);
				expect(instance.interruptTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(fixture())),
		);
	});

	it("captures the process for an unqualified Stop and replays its original target", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				let processId = "original-process";
				const instance = {
					...provider(() => Effect.die("No turn expected")),
					getControlProcessIdEffect: () => Effect.sync(() => processId),
				};
				const orchestration = yield* engine(instance);
				const command = {
					type: "interrupt_turn" as const,
					commandId: "unqualified-stop",
					sessionId: "control-session",
				};
				yield* orchestration.dispatchEffect(command);
				expect(
					yield* sql`SELECT provider_process_id, status FROM provider_command_outbox WHERE command_id = 'unqualified-stop'`,
				).toEqual([
					{ provider_process_id: "original-process", status: "completed" },
				]);
				processId = "replacement-process";
				yield* orchestration.dispatchEffect(command);
				expect(instance.interruptTurnEffect).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(fixture())),
		);
	});

	it.each([
		true,
		false,
	])("retires prompts only with confirmed process loss, alive=%s", async (alive) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = {
					...provider(() => Effect.die("No turn expected")),
					getControlProcessIdEffect: () => Effect.succeed(undefined),
					hasLiveProcessEffect: () => Effect.succeed(alive),
				};
				const orchestration = yield* engine(instance);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('answer-card', 'control-session', 'permission', 'pending', 'original-process', 'native-answer', 1), ('other-prompt', 'control-session', 'question', 'pending', 'original-process', 'native-question', 1)`;
				yield* Effect.result(
					orchestration.dispatchEffect({
						type: "resolve_permission",
						commandId: "unavailable-answer",
						sessionId: "control-session",
						requestId: "answer-card",
						decision: "once",
						providerProcessId: "original-process",
					}),
				);
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{
						status: "cancelled",
						error_code: alive
							? "provider_process_unavailable"
							: "provider_process_gone",
					},
				]);
				expect(
					yield* sql`SELECT status FROM pending_approvals WHERE id = 'other-prompt'`,
				).toEqual([{ status: alive ? "pending" : "resolved" }]);
				expect(instance.resolvePermissionEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(fixture())),
		);
	});

	it("ending an already gone process records cancellation and lets cleanup continue", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = {
					...provider(() => Effect.die("No turn expected")),
					getControlProcessIdEffect: () => Effect.succeed(undefined),
					hasLiveProcessEffect: () => Effect.succeed(false),
				};
				const orchestration = yield* engine(instance);
				yield* orchestration.dispatchEffect({
					type: "end_session",
					commandId: "end-gone",
					sessionId: "control-session",
				});
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'end-gone'`,
				).toEqual([
					{ status: "cancelled", error_code: "provider_process_gone" },
				]);
				expect(instance.endSessionEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(fixture())),
		);
	});

	it("delivers targeted deletion cleanup after its own session tombstone without recreating it", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const commit = yield* makeCommitAndSignal;
				const instance = {
					...provider(() => Effect.die("No turn expected")),
					getControlProcessIdEffect: () =>
						Effect.succeed("deleted-session-process"),
				};
				const orchestration = yield* engine(instance);
				yield* commit.write((project) =>
					store
						.append(
							canonicalEvent("session.deleted", "control-session", {
								sessionId: "control-session",
							}),
						)
						.pipe(Effect.flatMap((event) => project([event]))),
				);
				yield* orchestration.dispatchEffect({
					type: "end_session",
					commandId: "delete-cleanup",
					sessionId: "control-session",
					targetProviderId: "opencode",
					unbind: true,
				});
				expect(instance.endSessionEffect).toHaveBeenCalledExactlyOnceWith(
					"control-session",
					undefined,
					{
						commandId: "delete-cleanup",
						providerProcessId: "deleted-session-process",
					},
				);
				expect(
					yield* sql`SELECT id FROM sessions WHERE id = 'control-session'`,
				).toEqual([]);
				expect(
					yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'delete-cleanup'`,
				).toEqual([{ status: "completed" }]);
			}).pipe(Effect.provide(fixture())),
		);
	});

	it.each([
		null,
		"url-process",
	])("cancels replay without a verifiable process identity: %s", async (processId) => {
		const api = controlApi({
			promptProcessId: "url-process",
			controlReplaySafe: false,
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = provider(() => Effect.die("No turn expected"));
				const orchestration = yield* engine(instance);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('unrelated-live-prompt', 'control-session', 'permission', 'pending', 'another-live-process', '0', 1)`;
				yield* sql`INSERT INTO command_receipts (command_id, command_type, project_key, session_id, status, fingerprint_hash, fingerprint_version, created_at, updated_at) VALUES ('old-stop', 'interrupt_turn', 'control-project', 'control-session', 'side_effect_requested', 'legacy', 2, 1, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at) VALUES (1, 'old-stop', 'control-project', 'control-session', 'opencode', 'interrupt_turn', ${JSON.stringify({ type: "interrupt_turn", sessionId: "control-session", providerProcessId: processId })}, ${processId}, 'pending', 1, 1)`;
				yield* orchestration.drainSideEffects();
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'old-stop'`,
				).toEqual([
					{
						status: "cancelled",
						error_code:
							processId === null
								? "provider_process_gone"
								: "provider_process_unavailable",
					},
				]);
				expect(instance.interruptTurnEffect).not.toHaveBeenCalled();
				expect(
					yield* sql`SELECT status FROM pending_approvals WHERE id = 'unrelated-live-prompt'`,
				).toEqual([{ status: "pending" }]);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	it("delivers question rejection through the outbox to the fenced OpenCode client", async () => {
		const api = controlApi({
			promptProcessId: "question-process",
			controlReplaySafe: true,
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const instance = provider(() => Effect.die("No turn expected"));
				const orchestration = yield* engine(instance);
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at) VALUES ('question-card', 'control-session', 'question', 'pending', 'question-process', 'native-question', 1)`;
				yield* orchestration.dispatchEffect({
					type: "resolve_question",
					commandId: "reject-question",
					sessionId: "control-session",
					requestId: "question-card",
					answers: {},
					operation: "reject",
					providerProcessId: "question-process",
				});
				expect(api.question.reject).toHaveBeenCalledExactlyOnceWith(
					"native-question",
					undefined,
				);
				expect(instance.resolveQuestionEffect).not.toHaveBeenCalled();
				expect(
					yield* sql`SELECT status FROM pending_approvals WHERE id = 'question-card'`,
				).toEqual([{ status: "resolved" }]);
				expect(
					yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'reject-question'`,
				).toEqual([{ status: "completed" }]);
			}).pipe(
				Effect.provide(fixture()),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		);
	});

	for (const background of [false, true]) {
		it(`delivers a control while a blocked ${background ? "background send holds the session drain lease" : "foreground send still runs"}`, async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const sendStarted = yield* Deferred.make<void>();
					const sendRelease = yield* Deferred.make<void>();
					const accepted = yield* Deferred.make<void>();
					const allowForeground = yield* Deferred.make<void>();
					const instance = provider(() =>
						Deferred.succeed(sendStarted, undefined).pipe(
							Effect.andThen(Deferred.await(sendRelease)),
							Effect.as({
								status: "completed",
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							} satisfies TurnResult),
						),
					);
					const foreground = yield* engine(instance);
					const draining = background ? yield* engine(instance) : foreground;
					const runningSend = yield* Effect.forkChild(
						foreground.dispatchEffect({
							...send(),
							...(background
								? {
										onAccepted: Deferred.succeed(accepted, undefined).pipe(
											Effect.andThen(Deferred.await(allowForeground)),
										),
									}
								: {}),
						}),
					);
					let drain: Fiber.Fiber<void, ProviderCommandStoreFailure> | undefined;
					if (background) {
						yield* Deferred.await(accepted);
						drain = yield* Effect.forkChild(draining.drainSideEffects());
					}
					yield* Deferred.await(sendStarted);
					const control = {
						type: "interrupt_turn" as const,
						commandId: "control-behind-send",
						sessionId: "control-session",
						providerProcessId: "process-1",
						turnIds: ["blocked-input"],
					};
					yield* draining
						.dispatchEffect(control)
						.pipe(Effect.timeout("2 seconds"));
					expect(runningSend.pollUnsafe()).toBeUndefined();
					expect(
						vi.mocked(instance.interruptTurnEffect),
					).toHaveBeenCalledExactlyOnceWith(
						"control-session",
						["blocked-input"],
						undefined,
						{
							commandId: "control-behind-send",
							providerProcessId: "process-1",
						},
					);
					expect(
						yield* sql`SELECT effect_type, status FROM provider_command_outbox WHERE command_id = 'control-behind-send'`,
					).toEqual([{ effect_type: "interrupt_turn", status: "completed" }]);
					expect(yield* sql`SELECT id FROM provider_runs`).toHaveLength(1);
					const proof = {
						case: background
							? "control-passes-drain-lease"
							: "control-passes-live-send",
						controlId: control.commandId,
						providerProcessId: control.providerProcessId,
						sendStillRunning: runningSend.pollUnsafe() === undefined,
						outbox:
							yield* sql`SELECT command_id, effect_type, status, run_id FROM provider_command_outbox ORDER BY request_sequence`,
					};
					mkdirSync(artifactDirectory, { recursive: true });
					writeFileSync(
						join(artifactDirectory, `${proof.case}.json`),
						`${JSON.stringify(proof, null, 2)}\n`,
					);
					if (drain) yield* Fiber.interrupt(drain);
					yield* Fiber.interrupt(runningSend);
				}).pipe(Effect.provide(fixture())),
			);
		});
	}

	it.each([
		"interrupt_turn",
		"end_session",
	] as const)("replaying %s preserves pre-warm preparation started after the original control", async (type) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const instance = provider(() => Effect.die("No turn expected"));
				const orchestration = yield* engine(instance);
				const command = {
					type,
					commandId: "old-control",
					sessionId: "control-session",
					providerProcessId: "process-1",
				};
				yield* orchestration.dispatchEffect(command);
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const preparation = yield* Effect.forkChild(
					orchestration.preparePreWarmSessionEffect(
						command.sessionId,
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					),
				);
				yield* Deferred.await(entered);
				yield* orchestration.dispatchEffect(command);
				const changed = yield* Effect.result(
					orchestration.dispatchEffect({
						...command,
						providerProcessId: "other-process",
					}),
				);
				expect(changed).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "CommandFingerprintMismatch" },
				});
				expect(preparation.pollUnsafe()).toBeUndefined();
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(preparation);
				expect(instance.interruptTurnEffect).toHaveBeenCalledTimes(
					type === "interrupt_turn" ? 1 : 0,
				);
				expect(instance.endSessionEffect).toHaveBeenCalledTimes(
					type === "end_session" ? 1 : 0,
				);
			}).pipe(Effect.provide(fixture())),
		);
	});

	it("delivers competing controls for one process in acceptance order", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const calls: string[] = [];
				const instance = provider(() =>
					Effect.die("A control must not send a turn"),
				);
				vi.mocked(instance.interruptTurnEffect).mockImplementation(() =>
					Effect.sync(() => calls.push("interrupt")).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Deferred.await(release)),
					),
				);
				vi.mocked(instance.endSessionEffect).mockImplementation(() =>
					Effect.sync(() => {
						calls.push("end");
					}),
				);
				const orchestration = yield* engine(instance);
				const first = yield* Effect.forkChild(
					orchestration.dispatchEffect({
						type: "interrupt_turn",
						commandId: "control-first",
						sessionId: "control-session",
						providerProcessId: "process-1",
					}),
				);
				yield* Deferred.await(entered);
				const second = yield* Effect.forkChild(
					orchestration.dispatchEffect({
						type: "end_session",
						commandId: "control-second",
						sessionId: "control-session",
						providerProcessId: "process-1",
						targetProviderId: "opencode",
					}),
				);
				yield* Effect.sleep("20 millis");
				expect(calls).toEqual(["interrupt"]);
				expect(second.pollUnsafe()).toBeUndefined();
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(second);
				expect(calls).toEqual(["interrupt", "end"]);
				expect(
					yield* sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{ command_id: "control-first", status: "completed" },
					{ command_id: "control-second", status: "completed" },
				]);
				expect(yield* sql`SELECT id FROM provider_runs`).toEqual([]);
			}).pipe(Effect.provide(fixture())),
		);
	});

	it("contains a control claim store failure without interrupting a sibling background send", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const accepted = yield* Deferred.make<void>();
				const holdForeground = yield* Deferred.make<void>();
				const releaseSend = yield* Deferred.make<void>();
				let sendEntered = false;
				let sendInterrupted = false;
				const instance = provider(() =>
					Effect.sync(() => {
						sendEntered = true;
					}).pipe(
						Effect.andThen(Deferred.await(releaseSend)),
						Effect.as({
							status: "completed",
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						} satisfies TurnResult),
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								sendInterrupted = true;
							}),
						),
					),
				);
				const accepting = yield* engine(instance);
				const draining = yield* engine(instance);
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('fault-session', 'control-project', 'opencode', 1000, 1000)`;
				accepting.bindSession("fault-session", "opencode");
				yield* sql`CREATE TRIGGER hold_control_claim BEFORE UPDATE OF status ON provider_command_outbox WHEN NEW.command_id = 'fault-control' AND NEW.status = 'running' BEGIN SELECT RAISE(IGNORE); END`;
				const original = yield* Effect.forkChild(
					accepting.dispatchEffect({
						...send(),
						onAccepted: Deferred.succeed(accepted, undefined).pipe(
							Effect.andThen(Deferred.await(holdForeground)),
						),
					}),
				);
				yield* Deferred.await(accepted);
				const control = {
					type: "interrupt_turn" as const,
					commandId: "fault-control",
					sessionId: "fault-session",
					providerProcessId: "fault-process",
				};
				const waiting = yield* Effect.forkChild(
					accepting.dispatchEffect(control),
				);
				yield* Effect.sleep("20 millis");
				expect(
					yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'fault-control'`,
				).toEqual([{ status: "pending" }]);
				yield* sql`DROP TRIGGER hold_control_claim`;
				yield* sql`CREATE TRIGGER fail_control_claim BEFORE UPDATE OF status ON provider_command_outbox WHEN NEW.command_id = 'fault-control' AND NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'injected control claim store failure'); END`;
				const drain = yield* Effect.forkChild(
					Effect.result(draining.drainSideEffects()),
				);
				yield* Effect.sleep("30 millis");
				const beforeRelease = drain.pollUnsafe();
				yield* Deferred.succeed(releaseSend, undefined);
				const result = yield* Fiber.join(drain);
				yield* sql`DROP TRIGGER fail_control_claim`;
				yield* Fiber.interrupt(waiting);
				yield* Fiber.interrupt(original);
				expect(result._tag).toBe("Success");
				expect(beforeRelease).toBeUndefined();
				expect(sendEntered).toBe(true);
				expect(sendInterrupted).toBe(false);
				expect(instance.interruptTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(fixture())),
		);
	});

	it("canceling a duplicate waiter cannot release the background executor's process order", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const calls: string[] = [];
				const instance = provider(() =>
					Effect.die("Controls cannot create sends"),
				);
				vi.mocked(instance.interruptTurnEffect).mockImplementation(() =>
					Effect.sync(() => {
						calls.push("interrupt");
					}).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Deferred.await(release)),
					),
				);
				vi.mocked(instance.endSessionEffect).mockImplementation(() =>
					Effect.sync(() => {
						calls.push("end");
					}),
				);
				const accepting = yield* engine(instance);
				const background = yield* engine(instance);
				const replaying = yield* engine(instance);
				yield* sql`CREATE TRIGGER hold_first_control BEFORE UPDATE OF status ON provider_command_outbox WHEN NEW.command_id = 'background-owned-control' AND NEW.status = 'running' BEGIN SELECT RAISE(IGNORE); END`;
				const command = {
					type: "interrupt_turn" as const,
					commandId: "background-owned-control",
					sessionId: "control-session",
					providerProcessId: "process-1",
				};
				const firstWaiter = yield* Effect.forkChild(
					Effect.result(accepting.dispatchEffect(command)),
				);
				yield* Effect.sleep("20 millis");
				expect(
					yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'background-owned-control'`,
				).toEqual([{ status: "pending" }]);
				yield* sql`DROP TRIGGER hold_first_control`;
				const drain = yield* Effect.forkChild(background.drainSideEffects());
				yield* Deferred.await(entered);
				const duplicate = yield* Effect.forkChild(
					replaying.dispatchEffect(command),
				);
				yield* Effect.sleep("20 millis");
				yield* Fiber.interrupt(duplicate);
				const second = yield* Effect.forkChild(
					replaying.dispatchEffect({
						type: "end_session",
						commandId: "after-background-control",
						sessionId: "control-session",
						providerProcessId: "process-1",
						targetProviderId: "opencode",
					}),
				);
				yield* Effect.sleep("20 millis");
				const callsBeforeRelease = [...calls];
				const secondBeforeRelease = second.pollUnsafe();
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(drain);
				yield* Fiber.join(second);
				const outcome = yield* Effect.result(replaying.dispatchEffect(command));
				yield* Fiber.interrupt(firstWaiter);
				expect(callsBeforeRelease).toEqual(["interrupt"]);
				expect(secondBeforeRelease).toBeUndefined();
				expect(outcome._tag).toBe("Success");
				expect(calls).toEqual(["interrupt", "end"]);
				expect(
					yield* sql`SELECT status FROM command_receipts WHERE command_id = 'background-owned-control'`,
				).toEqual([{ status: "side_effect_completed" }]);
			}).pipe(Effect.provide(fixture())),
		);
	});
});

// Failure modes: no startup drain, an early retry, duplicate execution while
// immediate dispatch overlaps polling, a store error kills or hot-loops the
// schedule, or shutdown leaves a background fiber accessing a closed store.
describe("provider command outbox drain", () => {
	let harness: ProcessHarness | undefined;
	const cases: Array<Record<string, unknown>> = [];

	function state(fixture: ProcessHarness, inputId: string) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare(
					"SELECT status, attempt_count, next_attempt_at FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(inputId) as OutboxState | undefined;
		} finally {
			db.close();
		}
	}

	function dispatches(fixture: ProcessHarness, prompt: string) {
		const path = join(fixture.root, "sdk-proof.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { kind: string; request?: string })
					.filter((mark) => mark.kind === "enqueue" && mark.request === prompt)
					.length
			: 0;
	}

	async function leavePending(
		prefix = "outbox",
		options: {
			stop?: boolean;
			extraSession?: boolean;
			holdClaim?: boolean;
		} = {},
	) {
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			restartProof: true,
		});
		harness = fixture;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Outbox restart");
		const extraSessionId = options.extraSession
			? await browser.createSession("Independent outbox session")
			: undefined;
		const inputId = randomUUID();
		const prompt = `${prefix}-${inputId}`;
		const db = new Database(fixture.daemonStorePath());
		try {
			// Pause after the daemon's durable commit, before a provider can run.
			// Killing this process leaves its real receipt and payload pending.
			db.exec(`CREATE TRIGGER hold_outbox_claim BEFORE UPDATE OF status
				ON provider_command_outbox WHEN NEW.command_id = '${inputId}'
				AND NEW.status = 'running' BEGIN SELECT RAISE(IGNORE); END`);
		} finally {
			db.close();
		}
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: prompt,
			}),
		);
		await vi.waitFor(() =>
			expect(state(fixture, inputId)).toMatchObject({
				status: "pending",
				attempt_count: 0,
			}),
		);
		expect(dispatches(fixture, prompt)).toBe(0);
		if (options.stop !== false) await fixture.kill();
		const releaseClaim = () => {
			const stopped = new Database(fixture.daemonStorePath());
			try {
				stopped.exec("DROP TRIGGER hold_outbox_claim");
			} finally {
				stopped.close();
			}
		};
		if (!options.holdClaim) releaseClaim();
		return {
			fixture,
			sessionId,
			extraSessionId,
			inputId,
			prompt,
			releaseClaim,
		};
	}

	afterEach(async ({ task }) => {
		mkdirSync(artifactDirectory, { recursive: true });
		try {
			if (task.result?.errors?.length && harness) {
				writeFileSync(
					`/tmp/82tn24-outbox-drain-${cases.length}.log`,
					harness.logTail,
				);
				const db = new Database(harness.daemonStorePath(), { readonly: true });
				try {
					writeFileSync(
						join(artifactDirectory, "review5-stop-ledger.json"),
						JSON.stringify(
							{
								runs: db.prepare("SELECT * FROM provider_runs").all(),
								outbox: db
									.prepare(
										"SELECT command_id, request_sequence, status, run_id, error_code, attempt_count FROM provider_command_outbox",
									)
									.all(),
								pending: db
									.prepare(
										"SELECT input_id, state, admitted_at FROM pending_inputs",
									)
									.all(),
								events: db
									.prepare(
										"SELECT sequence, type, json_extract(data, '$.inputId') AS input, json_extract(metadata, '$.runId') AS run, json_extract(data, '$.reason') AS reason FROM events ORDER BY sequence DESC LIMIT 45",
									)
									.all(),
								sdk: existsSync(join(harness.root, "sdk-proof.ndjson"))
									? readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
									: "",
								runnerLog: existsSync(join(harness.configDir, "runners.log"))
									? readFileSync(join(harness.configDir, "runners.log"), "utf8")
									: "",
							},
							null,
							2,
						),
					);
				} finally {
					db.close();
				}
			}
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			harness = undefined;
			writeFileSync(
				join(artifactDirectory, "review5-provider-command-outbox-drain.json"),
				`${JSON.stringify(cases, null, 2)}\n`,
			);
		}
	});

	it("dispatches a previous process's pending row once immediately after recovery", async () => {
		const proof = {
			case: "pending-after-restart",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, inputId, prompt } = await leavePending();
		// A long interval distinguishes the startup drain from the periodic one.
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "60000" },
		});
		await vi.waitFor(
			() => expect(state(fixture, inputId)?.status).toBe("completed"),
			{
				timeout: 10_000,
			},
		);
		// Restart again: completed work must never be dispatched a second time.
		await fixture.signal("SIGINT");
		await fixture.restart();
		expect(state(fixture, inputId)?.attempt_count).toBe(1);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		proof.outcome = "passed";
	});

	it("waits until a retryable row's next_attempt_at before dispatching once", async () => {
		const proof = {
			case: "retry-after-deadline",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, inputId, prompt } = await leavePending();
		const db = new Database(fixture.daemonStorePath());
		try {
			db.prepare(`UPDATE provider_command_outbox SET status = 'retryable_failed',
				attempt_count = 1, next_attempt_at = ? WHERE command_id = ?`).run(
				Date.now() + 60_000,
				inputId,
			);
		} finally {
			db.close();
		}
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "50" },
		});
		await new Promise<void>((done) => setTimeout(done, 200));
		expect(dispatches(fixture, prompt)).toBe(0);
		expect(state(fixture, inputId)?.status).toBe("retryable_failed");
		// Arm a near deadline after startup, avoiding machine-dependent startup time.
		const nextAttemptAt = Date.now() + 500;
		const live = new Database(fixture.daemonStorePath());
		try {
			live
				.prepare(
					"UPDATE provider_command_outbox SET next_attempt_at = ? WHERE command_id = ?",
				)
				.run(nextAttemptAt, inputId);
		} finally {
			live.close();
		}
		await new Promise<void>((done) => setTimeout(done, 200));
		expect(dispatches(fixture, prompt)).toBe(0);
		await vi.waitFor(
			() => expect(state(fixture, inputId)?.status).toBe("completed"),
			{
				timeout: 10_000,
			},
		);
		expect(Date.now()).toBeGreaterThanOrEqual(nextAttemptAt);
		await new Promise<void>((done) => setTimeout(done, 200));
		expect(state(fixture, inputId)?.attempt_count).toBe(2);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		proof.outcome = "passed";
	});

	it("logs a drain store failure and keeps polling after it clears", async () => {
		const proof = {
			case: "drain-failure-survives",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, inputId, prompt } = await leavePending();
		const db = new Database(fixture.daemonStorePath());
		try {
			db.exec(`CREATE TRIGGER fail_outbox_claim BEFORE UPDATE OF status
				ON provider_command_outbox WHEN NEW.command_id = '${inputId}'
				AND NEW.status = 'running'
				BEGIN SELECT RAISE(FAIL, 'injected outbox store failure'); END`);
		} finally {
			db.close();
		}
		const logFile = join(fixture.root, "outbox-drain.log");
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "50" },
			logFile,
		});
		await vi.waitFor(() =>
			expect(readFileSync(logFile, "utf8")).toContain(
				"Provider command outbox drain failed",
			),
		);
		expect(dispatches(fixture, prompt)).toBe(0);
		const live = new Database(fixture.daemonStorePath());
		try {
			live.exec("DROP TRIGGER fail_outbox_claim");
		} finally {
			live.close();
		}
		await vi.waitFor(
			() => expect(state(fixture, inputId)?.status).toBe("completed"),
			{
				timeout: 10_000,
			},
		);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		proof.outcome = "passed";
	});

	it("routes a restarted pending turn's approval through the relay", async () => {
		const proof = {
			case: "restarted-approval",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, sessionId, inputId, prompt } =
			await leavePending("approval-outbox");
		await fixture.restart();
		const browser = await fixture.connect(sessionId);
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		await browser.answerApproval(approval, "allow");
		await vi.waitFor(
			() => expect(state(fixture, inputId)?.status).toBe("completed"),
			{
				timeout: 10_000,
			},
		);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		proof.outcome = "passed";
	});

	it("Stop returns an unclaimed handoff to the paused queue; Resume sends it first and exactly once", async () => {
		const proof = {
			case: "stop-unclaimed-handoff",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, sessionId, inputId, prompt, releaseClaim } =
			await leavePending("owned-outbox", { stop: false, holdClaim: true });
		const browser = await fixture.connect(sessionId);
		const later = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: later,
				delivery: "queue",
				text: `later-${later}`,
			}),
		);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
		);
		releaseClaim();
		const queue = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db
					.prepare(
						"SELECT input_id FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at, rowid",
					)
					.all(sessionId);
			} finally {
				db.close();
			}
		};
		await vi.waitFor(() =>
			expect(queue()).toEqual([{ input_id: inputId }, { input_id: later }]),
		);
		expect(state(fixture, inputId)).toMatchObject({
			status: "failed",
			attempt_count: 0,
		});
		expect(dispatches(fixture, prompt)).toBe(0);
		// Let the original foreground receipt waiter finish before restarting.
		await new Promise<void>((done) => setTimeout(done, 1250));
		expect(queue()).toEqual([{ input_id: inputId }, { input_id: later }]);
		await fixture.kill();
		await fixture.restart();
		await new Promise<void>((done) => setTimeout(done, 1250));
		expect(queue()).toEqual([{ input_id: inputId }, { input_id: later }]);
		expect(dispatches(fixture, prompt)).toBe(0);
		await (await fixture.connect(sessionId)).sendNow(sessionId, inputId);
		await vi.waitFor(
			() => {
				expect(state(fixture, later)?.status).toBe("completed");
				expect(queue()).toEqual([]);
			},
			{ timeout: 10_000 },
		);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		expect(dispatches(fixture, `later-${later}`)).toBe(1);
		expect(
			readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; request?: string })
				.filter((mark) => mark.kind === "enqueue")
				.map((mark) => mark.request),
		).toEqual([prompt, `later-${later}`]);
		proof.outcome = "passed";
	}, 90_000);

	it("drains another session's newly due retry while preserving a held session's order", async () => {
		const proof = {
			case: "independent-session-drains",
			outcome: "failed",
			dispatches: [] as number[],
		};
		cases.push(proof);
		const { fixture, sessionId, extraSessionId, inputId, prompt } =
			await leavePending("approval-outbox", { extraSession: true });
		if (!extraSessionId) throw new Error("Missing second session");
		const secondId = randomUUID();
		const otherId = randomUUID();
		const secondPrompt = `ordered-outbox-${secondId}`;
		const otherPrompt = `independent-outbox-${otherId}`;
		const db = new Database(fixture.daemonStorePath());
		try {
			const source = db
				.prepare(
					"SELECT payload_json FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(inputId) as { payload_json: string };
			for (const [id, targetSession, text, retry] of [
				[secondId, sessionId, secondPrompt, false],
				[otherId, extraSessionId, otherPrompt, true],
			] as const) {
				const runId = randomUUID();
				db.prepare(`INSERT INTO provider_runs (id, session_id, status, requested_at)
					VALUES (?, ?, 'pending', ?)`).run(runId, targetSession, Date.now());
				db.prepare(`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, updated_at)
					SELECT ?, ?, 'side_effect_requested', created_at, command_type, project_key, updated_at
					FROM command_receipts WHERE command_id = ?`).run(
					id,
					targetSession,
					inputId,
				);
				db.prepare(`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json,
					status, attempt_count, next_attempt_at, requested_at, updated_at)
					SELECT (SELECT MAX(request_sequence) + 1 FROM provider_command_outbox), ?, project_key, ?, provider_id,
					effect_type, ?, ?, ?, ?, ?, requested_at, updated_at FROM provider_command_outbox WHERE command_id = ?`).run(
					id,
					targetSession,
					runId,
					JSON.stringify({
						...JSON.parse(source.payload_json),
						sessionId: targetSession,
						inputId: id,
						prompt: text,
					}),
					retry ? "retryable_failed" : "pending",
					retry ? 1 : 0,
					retry ? Date.now() + 60_000 : null,
					inputId,
				);
			}
		} finally {
			db.close();
		}
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "25" },
		});
		const browser = await fixture.connect(sessionId);
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		expect(state(fixture, inputId)?.status).toBe("running");
		expect(dispatches(fixture, secondPrompt)).toBe(0);
		const live = new Database(fixture.daemonStorePath());
		try {
			live
				.prepare(
					"UPDATE provider_command_outbox SET next_attempt_at = ? WHERE command_id = ?",
				)
				.run(Date.now(), otherId);
		} finally {
			live.close();
		}
		await vi.waitFor(
			() => expect(state(fixture, otherId)?.status).toBe("completed"),
			{ timeout: 10_000 },
		);
		// Many scheduled ticks have overlapped the held turn by this point.
		expect(state(fixture, inputId)).toMatchObject({
			status: "running",
			attempt_count: 1,
		});
		expect(state(fixture, secondId)).toMatchObject({
			status: "pending",
			attempt_count: 0,
		});
		expect(state(fixture, otherId)?.attempt_count).toBe(2);
		await browser.answerApproval(approval, "allow");
		await vi.waitFor(
			() => {
				expect(state(fixture, inputId)?.status).toBe("completed");
				expect(state(fixture, secondId)).toMatchObject({
					status: "completed",
					attempt_count: 1,
				});
			},
			{ timeout: 10_000 },
		);
		proof.dispatches = [prompt, secondPrompt, otherPrompt].map((text) =>
			dispatches(fixture, text),
		);
		expect(proof.dispatches).toEqual([1, 1, 1]);
		proof.outcome = "passed";
	});

	it("dispatches once when immediate sends overlap the scheduled drain", async () => {
		const proof = {
			case: "immediate-dispatch-overlap",
			outcome: "failed",
			dispatches: [] as number[],
		};
		cases.push(proof);
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			restartProof: true,
		});
		await harness.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "1" },
		});
		const fixture = harness;
		const browser = await fixture.connect();
		const sends = await Promise.all(
			Array.from({ length: 3 }, async (_, index) => {
				const sessionId = await browser.createSession(
					`Outbox overlap ${index}`,
				);
				const inputId = randomUUID();
				const prompt = `outbox-overlap-${inputId}`;
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId,
						delivery: "queue",
						text: prompt,
					}),
				);
				return { inputId, prompt };
			}),
		);
		await vi.waitFor(
			() => {
				for (const { inputId } of sends) {
					expect(state(fixture, inputId)).toMatchObject({
						status: "completed",
						attempt_count: 1,
					});
				}
			},
			{ timeout: 15_000 },
		);
		proof.dispatches = sends.map(({ prompt }) => dispatches(fixture, prompt));
		expect(proof.dispatches).toEqual([1, 1, 1]);
		proof.outcome = "passed";
	});
});
