// Startup cleanup may run after a recovered ask commits but before its waiter
// registers, or after cleanup snapshots waiters and before registration finishes.
// Neither ordering may reject the live owner's ask or strand an answered waiter.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime, Result } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { resolveOrphanedClaudePermissions } from "../../../src/lib/domain/relay/Services/resolve-orphaned-claude-permissions.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { handlePermissionResponse } from "../../../src/lib/handlers/permissions.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../src/lib/provider/orchestration-read-model.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import { makeRecoveredEventSink } from "../../../src/lib/provider/runner/runner-event-sink.js";
import { makeRunnerProviderInstance } from "../../../src/lib/provider/runner/runner-provider-instance.js";
import {
	createRunnerPermissionReplies,
	currentRunnerOutput,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionRunner,
} from "../../../src/lib/provider/runner/session-runner.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";
import { PermissionId } from "../../../src/lib/shared-types.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

const sessionId = "recovered-session";
const processId = "live-recovered-runner";

describe("Claude permission ownership during startup cleanup", () => {
	it.each([
		"before-registration",
		"after-snapshot",
	] as const)("keeps a live ask answerable when cleanup runs %s", async (ordering) => {
		const root = mkdtempSync(join(tmpdir(), "phis-startup-race-"));
		const deliveredAnswers: Extract<
			SessionCommand,
			{ type: "resolve-permission" }
		>[] = [];
		let sink: ReturnType<typeof makeRecoveredEventSink>;
		function executeEffect(
			command: Extract<SessionCommand, { type: "send-turn" }>,
		): Effect.Effect<TurnResult, SessionFailure>;
		function executeEffect(
			command: Exclude<SessionCommand, { type: "send-turn" }>,
		): Effect.Effect<void, SessionFailure>;
		function executeEffect(
			command: SessionCommand,
		): Effect.Effect<TurnResult | undefined, SessionFailure>;
		function executeEffect(
			command: SessionCommand,
			// biome-ignore lint/suspicious/noConfusingVoidType: runner overloads return a turn result or a void control result.
		): Effect.Effect<TurnResult | void, SessionFailure> {
			if (command.type === "resolve-permission") {
				return Effect.gen(function* () {
					deliveredAnswers.push(command);
					// RunnerSinkBindings emits this callback before releasing its waiter.
					yield* sink
						.resolvePermission(
							command.requestId,
							command.control?.response ?? { decision: command.decision },
						)
						.pipe(
							Effect.mapError((cause) => ({
								operation: "resolvePermission",
								message: cause.message,
							})),
						);
				});
			}
			return command.type === "shutdown"
				? Effect.succeed(undefined)
				: Effect.die("This test does not execute runner commands");
		}
		// Process liveness and runner output delivery are simulated. The outbox,
		// recovered sink, pending service, cleanup and browser handler are real.
		const runner: SessionRunner = {
			getControlProcessIdEffect: (session) =>
				Effect.succeed(session === sessionId ? processId : undefined),
			hasLiveProcessEffect: (session, owner?: string) =>
				Effect.succeed(
					session === sessionId && (owner === undefined || owner === processId),
				),
			getSessionFailureEffect: () => Effect.succeed(undefined),
			executeEffect,
		};
		const registryLayer = Layer.effect(
			ProviderRegistryTag,
			Effect.gen(function* () {
				const owner = yield* makeRunnerProviderInstance(
					{
						accounts: Effect.die("This test does not resolve accounts"),
					},
					{
						driverKind: "claude",
						discoverEffect: () => Effect.die("Unexpected discovery"),
						generateTextEffect: () => Effect.die("Unexpected generation"),
						prepareTurnEffect: () => Effect.die("Unexpected turn"),
					},
					() => Effect.succeed(runner),
				);
				return new ProviderRegistry([owner]);
			}),
		);
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				makeProviderRuntimeIngestionLive().pipe(
					Layer.provideMerge(
						makePersistenceEffectLayer(join(root, "events.db"), "project"),
					),
				),
				makePendingInteractionServiceLive(),
				registryLayer,
			),
		);
		let finishRequests = async () => {};
		try {
			const state = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* createRunnerPermissionReplies(sql);
					const pending = yield* PendingInteractionServiceTag;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const registrationEntered = yield* Deferred.make<void>();
					const releaseRegistration = yield* Deferred.make<void>();
					const registered = yield* Deferred.make<void>();
					const snapshotCaptured = yield* Deferred.make<void>();
					const releaseSnapshot = yield* Deferred.make<void>();
					sink = makeRecoveredEventSink({
						sessionId,
						sql,
						ingestion,
						pending: {
							...pending,
							beginPermissionRequest: (request) =>
								Effect.gen(function* () {
									yield* Deferred.succeed(registrationEntered, undefined);
									yield* Deferred.await(releaseRegistration);
									return yield* pending.beginPermissionRequest(request);
								}),
						},
						onRegistered: () => Deferred.succeed(registered, undefined),
						timeoutHooks: {},
					});
					const cleanupPending = {
						...pending,
						listPendingPermissions: (session?: string) =>
							Effect.gen(function* () {
								const snapshot = yield* pending.listPendingPermissions(session);
								yield* Deferred.succeed(snapshotCaptured, undefined);
								if (ordering === "after-snapshot")
									yield* Deferred.await(releaseSnapshot);
								return snapshot;
							}),
					};
					yield* (yield* makeCommitAndSignal)([
						canonicalEvent(
							"session.created",
							sessionId,
							{ sessionId, title: "Startup permission", provider: "claude" },
							{ provider: "claude" },
						),
					]);
					const committed = yield* Deferred.make<void>();
					return {
						sql,
						pending,
						registrationEntered,
						releaseRegistration,
						registered,
						snapshotCaptured,
						releaseSnapshot,
						cleanup: resolveOrphanedClaudePermissions.pipe(
							Effect.provideService(
								PendingInteractionServiceTag,
								cleanupPending,
							),
						),
						ask: sink
							.requestPermission({
								requestId: "provider-request",
								sessionId,
								turnId: "recovered-turn",
								providerItemId: "provider-request",
								toolName: "Bash",
								toolInput: { command: "echo live" },
							})
							.pipe(
								Effect.provideService(currentRunnerOutput, {
									runnerId: processId,
									sequence: 1,
									attachmentId: "",
									committed,
									consumed: true,
								}),
							),
					};
				}),
			);
			finishRequests = async () => {
				await runtime.runPromise(
					Effect.gen(function* () {
						yield* Deferred.succeed(state.releaseRegistration, undefined);
						yield* Deferred.succeed(state.releaseSnapshot, undefined);
						yield* state.pending.cancelSessionInteractions(
							sessionId,
							"Test finished",
						);
					}),
				);
			};
			const asking = runtime.runPromise(Effect.result(state.ask));
			await runtime.runPromise(Deferred.await(state.registrationEntered));
			const readApproval = state.sql<{
				id: string;
				status: string;
				provider_process_id: string;
			}>`SELECT id, status, provider_process_id FROM pending_approvals`;
			const [approval] = await runtime.runPromise(readApproval);
			if (!approval) throw new Error("Permission ask was not persisted");
			expect(approval).toEqual({
				id: expect.any(String),
				status: "pending",
				provider_process_id: processId,
			});
			const cleaning = runtime.runPromise(state.cleanup);
			if (ordering === "after-snapshot") {
				await runtime.runPromise(Deferred.await(state.snapshotCaptured));
				await runtime.runPromise(
					Deferred.succeed(state.releaseRegistration, undefined),
				);
				await runtime.runPromise(Deferred.await(state.registered));
				await runtime.runPromise(
					Deferred.succeed(state.releaseSnapshot, undefined),
				);
			}
			const cleaned = await cleaning;
			await runtime.runPromise(
				Deferred.succeed(state.releaseRegistration, undefined),
			);
			await runtime.runPromise(Deferred.await(state.registered));
			expect.soft(cleaned).toBe(0);
			expect.soft(await runtime.runPromise(readApproval)).toEqual([approval]);
			const engine = await runtime.runPromise(
				Effect.gen(function* () {
					const registry = yield* ProviderRegistryTag;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const commit = yield* makeCommitAndSignal;
					const snapshot = yield* new CommandReadModelRepository(
						state.sql,
						"project",
					).bootstrap();
					return new OrchestrationEngine({
						registry,
						durableCommands: {
							sql: state.sql,
							ingestion,
							snapshot,
							projectKey: "project",
							now: Date.now,
							generateId: randomUUID,
							write: commit.write,
						},
					});
				}),
			);
			engine.bindSession(sessionId, "claude");
			const answer = handlePermissionResponse("browser", {
				requestId: PermissionId.make(approval.id),
				decision: "allow",
			}).pipe(
				Effect.provideService(
					WebSocketHandlerTag,
					makeMockWebSocketHandler({ getClientSession: () => sessionId }),
				),
				Effect.provideService(LoggerTag, makeMockLogger()),
				Effect.provideService(OrchestrationEngineTag, engine),
				Effect.provideService(
					ConfigTag,
					makeMockConfig({ projectDir: root, configDir: root }),
				),
				Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
			);
			await runtime.runPromise(answer);
			await runtime.runPromise(answer);
			await runtime.runPromise(engine.drainSideEffects());
			expect(await asking).toEqual(Result.succeed({ decision: "once" }));
			expect(
				await runtime.runPromise(state.pending.listPendingPermissions()),
			).toEqual([]);
			expect(await runtime.runPromise(readApproval)).toEqual([
				{ ...approval, status: "resolved" },
			]);
			expect(
				await runtime.runPromise(
					state.sql<{
						count: number;
					}>`SELECT COUNT(*) AS count FROM events WHERE type = 'permission.resolved'`,
				),
			).toEqual([{ count: 1 }]);
			expect(deliveredAnswers).toEqual([
				expect.objectContaining({
					type: "resolve-permission",
					sessionId,
					requestId: "provider-request",
					decision: "once",
					control: {
						commandId: expect.any(String),
						providerProcessId: processId,
						response: { decision: "once" },
					},
				}),
			]);
			expect(
				await runtime.runPromise(
					state.sql`SELECT effect_type, provider_process_id, status, attempt_count FROM provider_command_outbox`,
				),
			).toEqual([
				{
					effect_type: "resolve_permission",
					provider_process_id: processId,
					status: "completed",
					attempt_count: 1,
				},
			]);
		} finally {
			await finishRequests();
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
