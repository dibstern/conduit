import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	ManagedRuntime,
	Scope,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { ClaudeProviderInstance } from "../../../../src/lib/provider/claude/claude-provider-instance.js";
import {
	type ClaudeProviderInstanceDeps,
	makeClaudeProviderRuntime,
	makeClaudeSessionRunner,
} from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import { makeClaudeRunnerReceiptStore } from "../../../../src/lib/provider/claude/claude-runner-receipts.js";
import type {
	ClaudeSessionCommand,
	ClaudeSessionFailure,
} from "../../../../src/lib/provider/claude/claude-session-runner.js";
import type {
	PermissionResult,
	Options as SDKOptions,
} from "../../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../../src/lib/provider/event-sink-errors.js";
import { OrchestrationEngine } from "../../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";
import { createRelayEventSink } from "../../../../src/lib/provider/relay-event-sink.js";
import type {
	PermissionResponse,
	TurnResult,
} from "../../../../src/lib/provider/types.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

const capabilitiesService = {
	get: () =>
		Effect.fail(
			new ClaudeBoundaryError({
				operation: "probeCapabilities",
				cause: new Error("No live SDK in interaction tests"),
			}),
		),
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function persistentInteractions(permissionTimeoutMs?: number) {
	const dir = mkdtempSync(join(tmpdir(), "conduit-interaction-resolution-"));
	const persistenceLayer = makePersistenceEffectLayer(join(dir, "events.db"));
	const persistence = ManagedRuntime.make(
		Layer.merge(
			makeProviderRuntimeIngestionLive().pipe(
				Layer.provideMerge(persistenceLayer),
			),
			makePendingInteractionServiceLive(
				permissionTimeoutMs == null ? {} : { permissionTimeoutMs },
			),
		),
	);
	cleanups.push(async () => {
		await persistence.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
	return persistence.runPromise(
		Effect.gen(function* () {
			const eventStore = yield* EventStoreEffectTag;
			const runner = yield* ProjectionRunnerEffectTag;
			const readQuery = yield* ReadQueryEffectTag;
			const pending = yield* PendingInteractionServiceTag;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const sql = yield* SqlClient.SqlClient;
			yield* makeClaudeRunnerReceiptStore(sql);
			yield* runner.recover();
			const creation = yield* eventStore.append(
				canonicalEvent(
					"session.created",
					"session-1",
					{ sessionId: "session-1", title: "Interaction", provider: "claude" },
					{ provider: "claude" },
				),
			);
			yield* runner.projectEvent(creation);
			const send = vi.fn();
			const sink = createRelayEventSink({
				sessionId: "session-1",
				providerId: "claude",
				send,
				ingestion,
				pendingInteractions: {
					beginPermissionRequest: pending.beginPermissionRequest,
					resolvePermissionRequest: pending.resolvePermissionRequest,
					beginQuestionRequest: pending.beginQuestionRequest,
					resolveQuestionRequest: pending.resolveQuestionRequest,
					cancelSessionInteractions: (reason, options) =>
						pending.cancelSessionInteractions("session-1", reason, options),
				},
			});
			return {
				persistence,
				eventStore,
				readQuery,
				pending,
				ingestion,
				sql,
				sink,
				send,
			};
		}),
	);
}

function detachedRunnerFactory(
	started: Deferred.Deferred<string>,
): typeof makeClaudeSessionRunner {
	return () => {
		function executeEffect(
			command: Extract<ClaudeSessionCommand, { type: "send-turn" }>,
		): Effect.Effect<TurnResult, ClaudeSessionFailure>;
		function executeEffect(
			command: Exclude<ClaudeSessionCommand, { type: "send-turn" }>,
		): Effect.Effect<void, ClaudeSessionFailure>;
		function executeEffect(
			command: ClaudeSessionCommand,
		): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure>;
		function executeEffect(
			command: ClaudeSessionCommand,
		): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure> {
			return command.type === "send-turn"
				? Deferred.succeed(started, command.sinkId).pipe(
						Effect.andThen(Effect.never),
					)
				: Effect.succeed(undefined);
		}
		return Effect.succeed({ executeEffect });
	};
}

function toolQuery(run: (options: SDKOptions, turn: number) => Promise<void>) {
	const query = createMockQuery([]);
	const factory = vi.fn(
		({
			prompt,
			options,
		}: Parameters<
			NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>
		>[0]) => {
			const stream = (async function* () {
				let turn = 0;
				for await (const _message of prompt) {
					if (!options) throw new Error("Missing SDK options");
					await run(options, ++turn);
					yield makeSuccessResult();
				}
			})();
			return Object.assign(query, { [Symbol.asyncIterator]: () => stream });
		},
	);
	return { query, factory };
}

describe("Claude runner interaction transport", () => {
	it.each([
		"Bash",
		"AskUserQuestion",
	])("returns denial and completes the turn when the %s interaction dies", async (toolName) => {
		const permissions: Array<PermissionResult | null> = [];
		const { factory } = toolQuery(async (options) => {
			if (!options.canUseTool || !options.abortController)
				throw new Error("Missing SDK permission bridge");
			permissions.push(
				await options.canUseTool(
					toolName,
					{ command: "pwd", questions: [{ question: "Continue?" }] },
					{
						signal: options.abortController.signal,
						toolUseID: "tool-1",
						requestId: "request-1",
					},
				),
			);
		});
		const sink = createMockEventSink();
		sink.requestPermission = () => Effect.die(new Error("permission defect"));
		sink.requestQuestion = () => Effect.die(new Error("question defect"));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeClaudeProviderRuntime({
						runnerFactory: makeClaudeSessionRunner,
						workspaceRoot: "/tmp/ws",
						queryFactory: factory,
						capabilitiesService,
					});
					const turn = yield* Effect.fork(
						runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								eventSink: sink,
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						),
					);
					yield* Effect.promise(() =>
						vi.waitFor(() => expect(permissions).toHaveLength(1)),
					);
					expect(permissions[0]).toMatchObject({ behavior: "deny" });
					expect((yield* Fiber.join(turn)).status).toBe("completed");
				}),
			),
		);
	});

	it.each([
		"interrupt",
		"shutdown",
	])("continues %s teardown when the cancellation hook throws", async (operation) => {
		const requested = await Effect.runPromise(Deferred.make<void>());
		const { query, factory } = toolQuery(async (options) => {
			if (!options.canUseTool || !options.abortController)
				throw new Error("Missing SDK permission bridge");
			await options.canUseTool(
				"Bash",
				{ command: "pwd" },
				{
					signal: options.abortController.signal,
					toolUseID: "tool-1",
					requestId: "request-1",
				},
			);
		});
		const sink = createMockEventSink();
		sink.requestPermission = () =>
			Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never));
		sink.cancelSessionInteractions = () => {
			throw new Error("cancellation hook defect");
		};
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeClaudeProviderRuntime({
						runnerFactory: makeClaudeSessionRunner,
						workspaceRoot: "/tmp/ws",
						queryFactory: factory,
						capabilitiesService,
					});
					const turn = yield* Effect.fork(
						runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								eventSink: sink,
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						),
					);
					yield* Deferred.await(requested);
					yield* operation === "interrupt"
						? runtime.interruptTurnEffect("session-1")
						: runtime.shutdownEffect();
					expect(query.interrupt).toHaveBeenCalledOnce();
					if (operation === "interrupt") {
						expect((yield* Fiber.join(turn)).status).toBe("interrupted");
					} else {
						const exit = yield* Fiber.await(turn);
						expect(Exit.isFailure(exit)).toBe(true);
						if (Exit.isFailure(exit)) {
							expect(Cause.pretty(exit.cause)).toContain(
								"Provider instance shutting down",
							);
						}
					}
				}),
			),
		);
	});

	it.each([
		"Bash",
		"AskUserQuestion",
	])("cancels the relay's %s wait when the SDK aborts, before a warm retry", async (toolName) => {
		const requested = await Effect.runPromise(Deferred.make<void>());
		const abort = new AbortController();
		const finalized = vi.fn();
		const { factory } = toolQuery(async (options, turn) => {
			if (turn !== 1) return;
			if (!options.canUseTool) throw new Error("Missing SDK permission bridge");
			await options.canUseTool(
				toolName,
				{ command: "pwd", questions: [{ question: "Continue?" }] },
				{
					signal: abort.signal,
					toolUseID: "tool-1",
					requestId: "request-1",
				},
			);
		});
		const sink = createMockEventSink();
		const wait = () =>
			Deferred.succeed(requested, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Effect.sync(finalized)),
			);
		sink.requestPermission = wait;
		sink.requestQuestion = wait;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeClaudeProviderRuntime({
						runnerFactory: makeClaudeSessionRunner,
						workspaceRoot: "/tmp/ws",
						queryFactory: factory,
						capabilitiesService,
					});
					const turn = yield* Effect.fork(
						runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								eventSink: sink,
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						),
					);
					yield* Deferred.await(requested);
					abort.abort();
					expect((yield* Fiber.join(turn)).status).toBe("completed");
					expect(
						(yield* runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								inputId: "turn-2",
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						)).status,
					).toBe("completed");
					expect(factory).toHaveBeenCalledOnce();
					expect(finalized).toHaveBeenCalledOnce();
				}),
			),
		);
	});
});

describe("Claude durable interaction resolution", () => {
	const interactions = [
		{ toolName: "Bash", kind: "permission", message: "permission_request" },
		{ toolName: "AskUserQuestion", kind: "question", message: "ask_user" },
	] as const;

	it.each(
		interactions,
	)("resolves a $kind approval when cancel-interaction interrupts its waiter", async ({
		toolName,
		kind,
		message,
	}) => {
		const f = await persistentInteractions();
		const abort = new AbortController();
		const { factory } = toolQuery(async (options) => {
			if (!options.canUseTool) throw new Error("Missing permission bridge");
			await options.canUseTool(
				toolName,
				{ command: "pwd", questions: [{ question: "Continue?" }] },
				{ signal: abort.signal, toolUseID: "tool-1", requestId: "request-1" },
			);
		});
		await f.persistence.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeClaudeProviderRuntime({
						runnerFactory: makeClaudeSessionRunner,
						workspaceRoot: "/tmp/ws",
						queryFactory: factory,
						capabilitiesService,
					});
					const turn = yield* Effect.fork(
						runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								eventSink: f.sink,
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						),
					);
					yield* Effect.tryPromise(() =>
						vi.waitFor(() =>
							expect(f.send).toHaveBeenCalledWith(
								expect.objectContaining({ type: message }),
							),
						),
					);
					expect(yield* f.readQuery.countPendingApprovalsBySession()).toEqual([
						{ session_id: "session-1", type: kind, pending_count: 1 },
					]);
					const requests = yield* kind === "permission"
						? f.pending.listPendingPermissions("session-1")
						: f.pending.listPendingQuestions("session-1");
					const requestId = requests[0]?.requestId;
					expect(requestId).toBeTypeOf("string");
					abort.abort();
					expect((yield* Fiber.join(turn)).status).toBe("completed");
					const events = yield* f.eventStore.readAllBySession("session-1");
					expect(events.map((event) => event.type)).toContain(
						`${kind}.resolved`,
					);
					expect(
						events.find((event) => event.type === `${kind}.resolved`),
					).toMatchObject({
						type: `${kind}.resolved`,
						data:
							kind === "permission"
								? { id: requestId, decision: "reject" }
								: { id: requestId, answers: {} },
					});
					expect(yield* f.readQuery.countPendingApprovalsBySession()).toEqual(
						[],
					);
					expect(yield* f.pending.listPendingPermissions("session-1")).toEqual(
						[],
					);
					expect(yield* f.pending.listPendingQuestions("session-1")).toEqual(
						[],
					);
				}),
			),
		);
	});

	it.each(
		interactions.flatMap((interaction) => [
			{ ...interaction, shutdownPath: "runtime" as const },
			{ ...interaction, shutdownPath: "engine" as const },
		]),
	)("keeps a $kind approval pending when its $shutdownPath scope closes", async ({
		kind,
		message,
		shutdownPath,
	}) => {
		const f = await persistentInteractions();
		await f.persistence.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const relayScope = yield* Scope.make();
					yield* Effect.addFinalizer((exit) => Scope.close(relayScope, exit));
					const started = yield* Deferred.make<string>();
					const runtime = yield* makeClaudeProviderRuntime({
						runnerFactory: detachedRunnerFactory(started),
						workspaceRoot: "/tmp/ws",
						capabilitiesService,
					}).pipe(Scope.extend(relayScope));
					if (shutdownPath === "engine") {
						const engine = new OrchestrationEngine({
							registry: new ProviderRegistry([
								new ClaudeProviderInstance(runtime),
							]),
						});
						yield* Effect.addFinalizer(() => engine.shutdownEffect()).pipe(
							Scope.extend(relayScope),
						);
					}
					yield* Effect.fork(
						runtime.sendTurnEffect(
							makeBaseSendTurnInput({
								eventSink: f.sink,
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						),
					);
					const sinkId = yield* Deferred.await(started);
					yield* runtime.handleOutputEffect(
						kind === "permission"
							? {
									type: "permission-request",
									sinkId,
									request: {
										requestId: "request-1",
										sessionId: "session-1",
										turnId: "turn-1",
										providerItemId: "tool-1",
										toolName: "Bash",
										toolInput: { command: "pwd" },
									},
								}
							: {
									type: "question-request",
									sinkId,
									request: {
										requestId: "request-1",
										questions: [
											{ question: "Continue?", header: "Confirm", options: [] },
										],
									},
								},
					);
					yield* Effect.tryPromise(() =>
						vi.waitFor(() =>
							expect(f.send).toHaveBeenCalledWith(
								expect.objectContaining({ type: message }),
							),
						),
					);
					yield* Scope.close(relayScope, Exit.void);
				}),
			),
		);
		const events = await f.persistence.runPromise(
			f.eventStore.readAllBySession("session-1"),
		);
		expect(
			events
				.filter(
					(event) =>
						event.type === `${kind}.asked` || event.type === `${kind}.resolved`,
				)
				.map((event) => event.type),
		).toEqual([`${kind}.asked`]);
		expect(
			await f.persistence.runPromise(
				f.readQuery.countPendingApprovalsBySession(),
			),
		).toEqual([{ session_id: "session-1", type: kind, pending_count: 1 }]);
	});

	it.each(
		interactions,
	)("persists a completed $kind answer when detachment races its finalizer", async ({
		kind,
		message,
	}) => {
		const f = await persistentInteractions();
		const permissionReply: PermissionResponse = {
			decision: "always",
			permissionUpdates: [
				{
					type: "addRules",
					behavior: "allow",
					destination: "session",
					rules: [{ toolName: "Bash", ruleContent: "pwd" }],
				},
			],
		};
		const answers = { Confirm: ["Yes"] };
		await f.persistence.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const answerRead = yield* Deferred.make<void>();
					const finalize = yield* Deferred.make<void>();
					const sink = createRelayEventSink({
						sessionId: "session-1",
						providerId: "claude",
						send: f.send,
						ingestion: f.ingestion,
						pendingInteractions: {
							beginPermissionRequest: (entry) =>
								f.pending.beginPermissionRequest(entry).pipe(
									Effect.map((waiter) => ({
										awaitResponse: waiter.awaitResponse.pipe(
											Effect.tap(() => Deferred.succeed(answerRead, undefined)),
											Effect.zipLeft(Deferred.await(finalize)),
										),
									})),
								),
							resolvePermissionRequest: f.pending.resolvePermissionRequest,
							beginQuestionRequest: (entry) =>
								f.pending.beginQuestionRequest(entry).pipe(
									Effect.map((waiter) => ({
										awaitAnswers: waiter.awaitAnswers.pipe(
											Effect.tap(() => Deferred.succeed(answerRead, undefined)),
											Effect.zipLeft(Deferred.await(finalize)),
										),
									})),
								),
							resolveQuestionRequest: f.pending.resolveQuestionRequest,
						},
					});
					const request = yield* Effect.fork(
						kind === "permission"
							? sink
									.requestPermission({
										requestId: "request-1",
										sessionId: "session-1",
										turnId: "turn-1",
										providerItemId: "tool-1",
										toolName: "Bash",
										toolInput: { command: "pwd" },
									})
									.pipe(Effect.asVoid)
							: sink
									.requestQuestion({
										requestId: "request-1",
										questions: [
											{ question: "Continue?", header: "Confirm", options: [] },
										],
									})
									.pipe(Effect.asVoid),
					);
					yield* Effect.tryPromise(() =>
						vi.waitFor(() =>
							expect(f.send).toHaveBeenCalledWith(
								expect.objectContaining({ type: message }),
							),
						),
					);
					yield* kind === "permission"
						? sink.resolvePermission("request-1", permissionReply)
						: sink.resolveQuestion("request-1", answers);
					yield* Deferred.await(answerRead);
					yield* sink.detachInteractions?.() ?? Effect.void;
					yield* Deferred.succeed(finalize, undefined);
					yield* Fiber.join(request);
					const events = yield* f.eventStore.readAllBySession("session-1");
					expect(events.at(-1)).toMatchObject({
						type: `${kind}.resolved`,
						data:
							kind === "permission"
								? { id: "request-1", decision: "always" }
								: { id: "request-1", answers },
					});
					expect(yield* f.readQuery.countPendingApprovalsBySession()).toEqual(
						[],
					);
					if (kind === "permission") {
						expect(
							yield* f.sql<{
								response_json: string;
							}>`SELECT response_json FROM claude_runner_permission_replies WHERE session_id = 'session-1' AND request_id = 'request-1'`,
						).toEqual([{ response_json: JSON.stringify(permissionReply) }]);
					}
				}),
			),
		);
	});

	it.each(
		interactions,
	)("resolves a $kind approval when its live waiter fails", async ({
		kind,
		message,
	}) => {
		const f = await persistentInteractions();
		await f.persistence.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const request = yield* Effect.fork(
						kind === "permission"
							? f.sink
									.requestPermission({
										requestId: "request-1",
										sessionId: "session-1",
										turnId: "turn-1",
										providerItemId: "tool-1",
										toolName: "Bash",
										toolInput: { command: "pwd" },
									})
									.pipe(Effect.asVoid)
							: f.sink
									.requestQuestion({
										requestId: "request-1",
										questions: [
											{ question: "Continue?", header: "Confirm", options: [] },
										],
									})
									.pipe(Effect.asVoid),
					);
					yield* Effect.tryPromise(() =>
						vi.waitFor(() =>
							expect(f.send).toHaveBeenCalledWith(
								expect.objectContaining({ type: message }),
							),
						),
					);
					yield* f.pending.cancelSessionInteractions(
						"session-1",
						"live failure",
					);
					expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true);
					expect(
						(yield* f.eventStore.readAllBySession("session-1")).at(-1),
					).toMatchObject({
						type: `${kind}.resolved`,
						data:
							kind === "permission"
								? { id: "request-1", decision: "reject" }
								: { id: "request-1", answers: {} },
					});
					expect(yield* f.readQuery.countPendingApprovalsBySession()).toEqual(
						[],
					);
				}),
			),
		);
	});

	it("resolves a permission approval when its live waiter times out", async () => {
		const f = await persistentInteractions(0);
		await f.persistence.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const request = yield* Effect.fork(
						f.sink.requestPermission({
							requestId: "request-1",
							sessionId: "session-1",
							turnId: "turn-1",
							providerItemId: "tool-1",
							toolName: "Bash",
							toolInput: { command: "pwd" },
						}),
					);
					yield* Effect.tryPromise(() =>
						vi.waitFor(() =>
							expect(f.send).toHaveBeenCalledWith(
								expect.objectContaining({ type: "permission_request" }),
							),
						),
					);
					expect(yield* f.pending.takeTimedOutPermissions()).toHaveLength(1);
					expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true);
					expect(
						(yield* f.eventStore.readAllBySession("session-1")).at(-1),
					).toMatchObject({
						type: "permission.resolved",
						data: { id: "request-1", decision: "reject" },
					});
					expect(yield* f.readQuery.countPendingApprovalsBySession()).toEqual(
						[],
					);
				}),
			),
		);
	});
});
