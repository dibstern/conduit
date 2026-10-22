import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	type ProviderAdapterProjectContext,
	ProviderAdapters,
} from "../../../src/lib/domain/daemon/Services/provider-adapters.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import {
	ContinuationTag,
	makeContinuation,
} from "../../../src/lib/domain/relay/Services/continuation.js";
import { makeEffectOpenCodeRuntimeIngress } from "../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	ProviderTurnServiceLive,
	ProviderTurnServiceTag,
	STOP_ABORT_WAIT_MS,
} from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
} from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeClaudeSessionRunner } from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { SDKMessage } from "../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../src/lib/provider/event-sink-errors.js";
import { getOrchestrationLayer } from "../../../src/lib/provider/orchestration-wiring.js";
import type { SSEEvent } from "../../../src/lib/relay/opencode-events.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	MOCK_OPENCODE_GPT4_CATALOG,
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockOpenCodeModelService,
	makeOpenCodeInstancesStub,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import {
	createMockQuery,
	makeErrorResult,
	makeSuccessResult,
} from "../../helpers/mock-sdk.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";
import { makeTestOrchestrationRuntimeLayer as makeOrchestrationRuntimeLayer } from "../../helpers/provider-adapters.js";
import { writeProviderCommandOutboxProof } from "../../helpers/provider-command-outbox-proof.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

const commandOutboxEvidence: Record<string, unknown>[] = [];

afterAll(() =>
	writeProviderCommandOutboxProof(import.meta.url, commandOutboxEvidence),
);

function signal<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Failure modes: the selected input steers instead of starting a new turn;
// natural completion races the interrupt; concurrent clients interrupt twice;
// the selected input's images or the remaining queue order are lost.
// Stop hardening failure modes: an abort arrives after the old five-second cap;
// a never-settling abort blocks Remove/Edit, another session, or owner teardown;
// request cancellation separates the durable reservation from its Stop;
// a reservation stored before a restart is never stopped;
// the old turn ending before the abort lands lets a concurrent input start;
// owner replacement retains an abandoned fence;
// a rejected abort permanently blocks the next send.
// A continuation waiting for prewarm must not stall another session's queue
// on the inbox's shared advance consumer.
describe("Run now through RPC, inbox, durable orchestration and provider adapters", () => {
	for (const provider of ["claude", "opencode"] as const) {
		it.each([
			"normal",
			"natural-completion-race",
			"double-run-now",
			"slow-run-now",
			"manual-stop-send",
			"never-settling",
			"cancel-after-reservation",
			"owner-rebuild",
			"abort-rejected",
			"timeout-recovery",
			"recover-unregistered-reservation",
			"recover-registration-race",
			...(provider === "claude"
				? ([
						"run-now-during-continuation",
						"other-queue-during-continuation",
						"manual-stop-steer",
						"question-replacement-session-lock",
					] as const)
				: []),
		] as const)(`${provider}: %s runs the selected input next after Stop`, async (scenario) => {
			const evidence: Record<string, unknown> = {};
			if (scenario === "question-replacement-session-lock") {
				Object.assign(evidence, { scenario, passed: false });
				commandOutboxEvidence.push(evidence);
			}
			const scratch = mkdtempSync(join(tmpdir(), "conduit-run-now-"));
			const sessionId = `run-now-${provider}-${scenario}`;
			const image =
				"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6L8AAAAASUVORK5CYII=";
			const sent: string[] = [];
			const providerInputs: { inputId: string; images: readonly string[] }[] =
				[];
			const stopRequests: string[] = [];
			const abortedAtRelease: string[] = [];
			const naturalResults: string[] = [];
			let disposing = false;
			let originalOwnerGone = false;
			const releaseStop = signal<void>();
			const registrationStarted = signal<void>();
			const releaseRegistration = signal<void>();
			const continuationEnding = signal<void>();
			const releaseContinuation = signal<void>();
			let cancelAtReservation: Effect.Effect<void> = Effect.void;
			type ActiveTurn = {
				inputId: string;
				complete: (interrupted?: boolean) => Promise<void>;
			};
			const activeTurns = new Map<string, ActiveTurn>();
			let emitSSE: (event: SSEEvent) => Promise<void> = async () => {
				throw new Error("OpenCode ingress is not ready");
			};
			const stop = async (sid = sessionId, boundTurn?: ActiveTurn) => {
				if (disposing) return;
				// OpenCode's durable interrupt calls its HTTP client inside the Stop worker.
				if (
					provider === "opencode" &&
					scenario === "recover-registration-race"
				) {
					registrationStarted.resolve();
					await releaseRegistration.promise;
				}
				stopRequests.push(sessionId);
				if (sid === sessionId) await releaseStop.promise;
				if (scenario === "abort-rejected")
					throw new Error("The provider abort result is unknown");
				// An old process cannot issue another HTTP abort after owner loss.
				if (provider === "opencode" && originalOwnerGone) return;
				// Claude targets the captured Query; OpenCode's HTTP abort targets
				// whichever turn occupies the native session when it arrives.
				const active = provider === "claude" ? boundTurn : activeTurns.get(sid);
				if (active) {
					if (!disposing) abortedAtRelease.push(active.inputId);
					await active.complete(true);
				}
			};
			// Durable Stop is fenced to the target process, as real clients identify theirs.
			const api = Object.assign(makeMockOpenCodeAPI(), {
				promptProcessId: `opencode:run-now:${sessionId}`,
				controlReplaySafe: true,
			});
			api.session.abort = vi.fn(stop);
			api.session.prompt = vi.fn(async (sessionId, options) => {
				const inputId = options.text.split(" ")[0] ?? "";
				const messageId = options.messageId;
				expect(messageId).toEqual(expect.any(String));
				const assistantId = `${inputId}-assistant`;
				sent.push(inputId);
				providerInputs.push({ inputId, images: options.images ?? [] });
				const complete = async (interrupted = false) => {
					if (activeTurns.get(sessionId)?.inputId !== inputId) return;
					activeTurns.delete(sessionId);
					await emitSSE(
						interrupted
							? makeSSEEvent("session.error", {
									sessionID: sessionId,
									error: {
										name: "MessageAbortedError",
										data: { message: "Interrupted" },
									},
								})
							: makeSSEEvent("message.updated", {
									sessionID: sessionId,
									info: {
										id: assistantId,
										parentID: messageId,
										role: "assistant",
										time: { created: 1, completed: Date.now() },
									},
								}),
					);
					await emitSSE(
						makeSSEEvent("session.status", {
							sessionID: sessionId,
							status: { type: "idle" },
						}),
					);
				};
				activeTurns.set(sessionId, { inputId, complete });
				await emitSSE(
					makeSSEEvent("message.updated", {
						sessionID: sessionId,
						info: {
							id: messageId,
							role: "user",
							time: { created: Date.now() },
						},
					}),
				);
				await emitSSE(
					makeSSEEvent("message.part.updated", {
						sessionID: sessionId,
						part: {
							id: `${inputId}-text`,
							messageID: messageId,
							type: "text",
							text: options.text,
						},
					}),
				);
				await emitSSE(
					makeSSEEvent("message.updated", {
						sessionID: sessionId,
						info: {
							id: assistantId,
							parentID: messageId,
							role: "assistant",
							time: { created: Date.now() },
						},
					}),
				);
				await emitSSE(
					makeSSEEvent("session.status", {
						sessionID: sessionId,
						status: { type: "busy" },
					}),
				);
			});
			const persistence = makePersistenceEffectLayer(
				":memory:",
				"test-project",
				undefined,
				SessionEventBusLive,
			);
			const accounts = makeMockAccountDirectory([
				{
					driver: "claude",
					id: AccountIdSchema.make("claude"),
					name: "Claude",
					folder: configuredClaudeConfigDir(scratch),
					usageEligible: true,
				},
				{
					driver: "opencode",
					id: AccountIdSchema.make("opencode"),
					name: "OpenCode",
					usageEligible: false,
				},
				{
					driver: "claude",
					id: AccountIdSchema.make("target"),
					name: "Target Claude",
					folder: configuredClaudeConfigDir(scratch),
					usageEligible: true,
				},
			]);
			const orchestration = makeOrchestrationRuntimeLayer({
				configDir: scratch,
				workspaceRoot: scratch,
				shellEnv: () => ({}),
				claudeRunnerFactory: (deps, emit) =>
					makeClaudeSessionRunner(
						{
							...deps,
							capabilitiesService: {
								get: () =>
									Effect.fail(
										new ClaudeBoundaryError({
											operation: "probeCapabilities",
											cause: new Error(
												"No live capability probe in this transport fixture",
											),
										}),
									),
							},
						},
						emit,
					),
				claudeQueryFactory: ({ prompt }) => {
					let closed = false;
					let querySessionId = sessionId;
					let queryTurn: ActiveTurn | undefined;
					const stream = (async function* (): AsyncGenerator<SDKMessage> {
						for await (const user of prompt) {
							if (closed) return;
							const inputId = user.uuid ?? "";
							if (inputId.startsWith("other-"))
								querySessionId = `${sessionId}-other`;
							const content = user.message.content;
							const images =
								typeof content === "string"
									? []
									: content.flatMap((block) =>
											block.type === "image" && block.source.type === "base64"
												? [
														`data:${block.source.media_type};base64,${block.source.data}`,
													]
												: [],
										);
							const result = signal<boolean>();
							queryTurn = {
								inputId,
								complete: async (interrupted = false) => {
									if (activeTurns.get(querySessionId)?.inputId === inputId)
										activeTurns.delete(querySessionId);
									result.resolve(interrupted);
								},
							};
							activeTurns.set(querySessionId, queryTurn);
							sent.push(inputId);
							providerInputs.push({ inputId, images });
							yield {
								type: "command_lifecycle",
								state: "started",
								command_uuid: inputId,
								uuid: inputId,
								session_id: querySessionId,
							};
							yield {
								type: "assistant",
								uuid: "00000000-0000-0000-0000-000000000001",
								session_id: querySessionId,
								parent_tool_use_id: null,
								message: {
									id: `${inputId}-assistant`,
									type: "message",
									role: "assistant",
									content: [],
									model: "claude-sonnet-4",
									stop_reason: null,
									stop_sequence: null,
									stop_details: null,
									container: null,
									context_management: null,
									diagnostics: null,
									usage: {
										input_tokens: 0,
										output_tokens: 0,
										cache_creation: null,
										cache_creation_input_tokens: null,
										cache_read_input_tokens: null,
										fallback_credit: null,
										inference_geo: null,
										iterations: null,
										output_tokens_details: null,
										server_tool_use: null,
										service_tier: null,
										speed: null,
									},
								},
							};
							const interrupted = await result.promise;
							if (closed) return;
							if (!interrupted) naturalResults.push(inputId);
							yield interrupted
								? makeErrorResult({
										session_id: querySessionId,
										...(user.uuid ? { user_message_uuid: user.uuid } : {}),
									})
								: makeSuccessResult({
										session_id: querySessionId,
										...(user.uuid ? { user_message_uuid: user.uuid } : {}),
									});
						}
					})();
					return Object.assign(createMockQuery([]), {
						interrupt: vi.fn(() => stop(querySessionId, queryTurn)),
						close: () => {
							closed = true;
							void queryTurn?.complete(true);
						},
						next: stream.next.bind(stream),
						return: stream.return.bind(stream),
						throw: stream.throw.bind(stream),
						[Symbol.asyncIterator]: () => stream,
					});
				},
			}).pipe(
				Layer.provideMerge(SessionWorkspaceLive),
				Layer.provideMerge(
					Layer.mergeAll(
						persistence,
						SessionEventBusLive,
						DaemonConfigRefLive(
							makeDaemonConfigFromOptions(
								scenario === "run-now-during-continuation" ||
									scenario === "other-queue-during-continuation"
									? {
											usageLimits: {
												autoSwitch: true,
												autoResume: false,
												warnAt: 80,
												order: ["target"],
											},
										}
									: {},
							),
						),
						makeProviderRuntimeIngestionLive().pipe(
							Layer.provide(Layer.merge(persistence, SessionEventBusLive)),
						),
						Layer.succeed(AccountDirectory, accounts),
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(
							ConfigTag,
							makeMockConfig({ projectDir: scratch, configDir: scratch }),
						),
						Layer.succeed(LoggerTag, makeMockLogger()),
						Layer.succeed(
							OpenCodeInstancesTag,
							makeOpenCodeInstancesStub({ opencode: api }),
						),
					),
				),
			);
			const layer = Layer.unwrap(
				Effect.gen(function* () {
					const wired = yield* getOrchestrationLayer;
					const dispatch = wired.engine.dispatchEffect.bind(wired.engine);
					// Same-driver switches now warm before dispatch rather than end the session.
					if (
						scenario === "run-now-during-continuation" ||
						scenario === "other-queue-during-continuation"
					) {
						const prepare = wired.engine.preparePreWarmSessionEffect.bind(
							wired.engine,
						);
						vi.spyOn(
							wired.engine,
							"preparePreWarmSessionEffect",
						).mockImplementation((sid, preparation) =>
							sid === sessionId
								? Effect.promise(async () => {
										continuationEnding.resolve();
										await releaseContinuation.promise;
									}).pipe(Effect.andThen(prepare(sid, preparation)))
								: prepare(sid, preparation),
						);
					}
					// The Claude abort resolved after installing its fence waits for the test.
					vi.spyOn(wired.engine, "dispatchEffect").mockImplementation(
						(command) =>
							command.type === "interrupt_turn" &&
							scenario === "recover-registration-race"
								? Effect.promise(async () => {
										registrationStarted.resolve();
										await releaseRegistration.promise;
									}).pipe(Effect.andThen(dispatch(command)))
								: dispatch(command),
					);
					const ingress = yield* makeEffectOpenCodeRuntimeIngress(
						makeMockLogger(),
						undefined,
						(sid, mid) => wired.openCodeInstance.inputIdForUserEcho(sid, mid),
					);
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => ingress.shutdown()),
					);
					emitSSE = async (event) => {
						const sid =
							"sessionID" in event.properties
								? event.properties.sessionID
								: undefined;
						const result = await Effect.runPromise(
							ingress.onSSEEventEffect(
								event,
								typeof sid === "string" ? sid : sessionId,
								"opencode",
							),
						);
						expect(result.ok).toBe(true);
					};
					const deps = Layer.mergeAll(
						makeTestHandlerLayer({
							api,
							accountDirectory: accounts,
							config: makeMockConfig({
								projectDir: scratch,
								configDir: scratch,
							}),
							orchestrationEngine: wired.engine,
							providerRegistry: wired.registry,
							persistenceLayer: persistence,
							openCodeModelService: makeMockOpenCodeModelService(
								MOCK_OPENCODE_GPT4_CATALOG,
							),
							seedEvents: [
								canonicalEvent("session.created", sessionId, {
									sessionId,
									title: "Stop fence session",
									provider,
								}),
								makeSessionCreatedEvent(`${sessionId}-other`, { provider }),
								...sessionPickEvents(`${sessionId}-other`, {
									harness: provider,
									model:
										provider === "claude"
											? { providerId: "claude", modelId: "sonnet" }
											: { providerId: "openai", modelId: "gpt-4" },
									effort: "",
									contextWindow: "",
								}),
								...sessionPickEvents(sessionId, {
									harness: provider,
									model:
										provider === "claude"
											? { providerId: "claude", modelId: "sonnet" }
											: { providerId: "openai", modelId: "gpt-4" },
									effort: "",
									contextWindow: "",
								}),
							],
						}),
						SessionEventBusLive,
						Layer.succeed(Usage, {
							readings: Stream.empty,
							latest: () => Effect.succeed(undefined),
							refresh: () => Effect.succeed([]),
							turnEnded: () => Effect.void,
							pickFailover: () =>
								Effect.succeed(
									scenario === "run-now-during-continuation" ||
										scenario === "other-queue-during-continuation"
										? "target"
										: undefined,
								),
						}),
						Layer.succeed(ContinuationTag, {
							requestContinuation: () => Effect.void,
							intakeLimit: () => Effect.succeed(false),
							dismissCutOff: () => Effect.void,
							cancelContinuation: () => Effect.void,
							sweepDueContinuations: () => Effect.void,
							queueLimitPolicy: () => Effect.void,
							runLimitPolicies: Effect.never,
						}),
					);
					const inboxDeps =
						scenario === "cancel-after-reservation"
							? Layer.merge(
									deps,
									Layer.effect(
										ClaudeEventPersistEffectTag,
										Effect.gen(function* () {
											const persist = yield* ClaudeEventPersistEffectTag;
											return {
												...persist,
												persistEvents: (events, options) =>
													persist
														.persistEvents(events, options)
														.pipe(
															Effect.tap(() =>
																events.some(
																	(event) =>
																		event.type === "input.interrupt_requested",
																)
																	? cancelAtReservation.pipe(
																			Effect.andThen(Effect.yieldNow),
																		)
																	: Effect.void,
															),
														),
											} satisfies ClaudeEventPersistEffect;
										}),
									).pipe(Layer.provide(deps)),
								)
							: deps;
					return WsRpcServerLayer.pipe(
						Layer.provideMerge(
							SessionInboxLive.pipe(Layer.provideMerge(inboxDeps)),
						),
					);
				}),
			).pipe(Layer.provideMerge(orchestration));
			try {
				const running = Effect.runPromise(
					Effect.gen(function* () {
						const adapters = yield* ProviderAdapters;
						yield* adapters.registerProject(
							"test-project",
							yield* Effect.context<ProviderAdapterProjectContext>(),
						);
						yield* adapters.recover;
						const client = yield* RpcTest.makeClient(WsRpcGroup);
						const inbox = yield* SessionInboxTag;
						const providerTurns = yield* ProviderTurnServiceTag;
						const sql = yield* SqlClient.SqlClient;
						yield* Effect.addFinalizer(() =>
							Effect.gen(function* () {
								evidence["finalTurns"] =
									yield* sql`SELECT user_message_id, run_id, state FROM turns WHERE session_id = ${sessionId} ORDER BY rowid`;
								evidence["finalCommands"] =
									yield* sql`SELECT command_id, status FROM command_receipts WHERE session_id = ${sessionId}`;
								evidence["finalControls"] =
									yield* sql`SELECT command_id, effect_type, provider_process_id, status, error_code,
										json_extract(payload_json, '$.stop') AS stop_snapshot
										FROM provider_command_outbox WHERE session_id = ${sessionId} AND effect_type <> 'send_turn'`;
								if (scenario === "question-replacement-session-lock")
									evidence["events"] =
										yield* sql`SELECT sequence, type, data, metadata FROM events WHERE session_id = ${sessionId} ORDER BY sequence`;
								evidence["finalErrors"] =
									yield* sql`SELECT type, data FROM events WHERE session_id = ${sessionId} AND type = 'turn.error'`;
								evidence["finalSession"] =
									yield* sql`SELECT status, limit_recovery FROM sessions WHERE id = ${sessionId}`;
								evidence["resumeEvents"] =
									yield* sql`SELECT type, data FROM events WHERE session_id = ${sessionId}
										AND type IN ('session.resumed', 'session.resume_scheduled', 'session.resume_cancelled')`;
							}).pipe(Effect.orDie),
						);
						const awaitCondition = (condition: () => boolean) =>
							Effect.sleep("1 millis").pipe(
								Effect.repeat({ until: condition }),
								Effect.timeout("3 seconds"),
							);
						const finish = (sid = sessionId) =>
							Effect.tryPromise(async () => {
								const active = activeTurns.get(sid);
								expect(active).toBeDefined();
								await active?.complete();
							});
						if (
							![
								"recover-unregistered-reservation",
								"recover-registration-race",
								"run-now-during-continuation",
								"other-queue-during-continuation",
							].includes(scenario)
						)
							yield* inbox.start;
						for (const inputId of [
							"manual-stop-send",
							"manual-stop-steer",
							"question-replacement-session-lock",
							"owner-rebuild",
						].includes(scenario)
							? ["running"]
							: ["running", "first", "selected", "last"]) {
							yield* client["input.submit"]({
								sessionId,
								inputId,
								text: `${inputId} plain message`,
								...(inputId === "selected" ? { images: [image] } : {}),
								delivery: "queue",
								originId: "run-now-browser",
							});
							if (inputId === "running") {
								yield* awaitCondition(() => sent.length === 1);
								yield* sql`SELECT 1 FROM provider_runs WHERE session_id = ${sessionId}
									AND status = 'running'`.pipe(
									Effect.delay("1 millis"),
									Effect.repeat({ until: (rows) => rows.length === 1 }),
									Effect.timeout("3 seconds"),
								);
							}
						}
						const secondClient = yield* RpcTest.makeClient(WsRpcGroup);
						const runNow = (rpc = client) =>
							rpc["input.sendNow"]({
								sessionId,
								inputId: "selected",
								interrupt: true,
							});
						if (scenario === "question-replacement-session-lock") {
							const interactions = yield* PendingInteractionServiceTag;
							yield* interactions.recordQuestionRequest({
								requestId: "live-question",
								sessionId,
								questions: [{ question: "Continue?" }],
							});
							const permitHeld = signal<void>();
							const releasePermit = signal<void>();
							const questionRead = signal<void>();
							const listQuestions =
								interactions.listPendingQuestions.bind(interactions);
							vi.spyOn(interactions, "listPendingQuestions").mockImplementation(
								(sid) =>
									listQuestions(sid).pipe(
										Effect.tap(() => Effect.sync(() => questionRead.resolve())),
									),
							);
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => releasePermit.resolve()),
							);
							const held = yield* Effect.forkChild(
								inbox.withSession(
									sessionId,
									Effect.sync(() => permitHeld.resolve()).pipe(
										Effect.andThen(Effect.promise(() => releasePermit.promise)),
									),
								),
							);
							yield* Effect.promise(() => permitHeld.promise);
							const replacement = yield* Effect.forkChild(
								providerTurns.prepareTurnSession({
									clientId: "question-replacement",
									commandId: "question-replacement",
									sessionId,
								}),
							);
							yield* Effect.promise(() => questionRead.promise).pipe(
								Effect.timeout("3 seconds"),
							);
							const cancellation = yield* Effect.forkChild(
								client.CancelSession({
									sessionId,
									commandId: "concurrent-stop",
								}),
							);
							yield* Effect.sleep("30 millis");
							expect(providerTurns.turnFences(sessionId).stopping).toBe(false);
							expect(stopRequests).toEqual([]);
							expect(
								yield* sql`SELECT command_id FROM provider_command_outbox WHERE session_id = ${sessionId} AND effect_type = 'interrupt_turn'`,
							).toEqual([]);
							yield* Effect.sync(() => releasePermit.resolve());
							yield* Fiber.join(held);
							yield* awaitCondition(() => stopRequests.length === 1);
							expect(
								yield* inbox
									.withSession(sessionId, Effect.succeed("available"))
									.pipe(Effect.timeout("500 millis")),
							).toBe("available");
							yield* Effect.sync(() => releaseStop.resolve());
							expect(
								yield* Fiber.join(replacement).pipe(
									Effect.timeout("3 seconds"),
								),
							).toBe(sessionId);
							expect(
								yield* Fiber.join(cancellation).pipe(
									Effect.timeout("3 seconds"),
								),
							).toEqual({ ok: true });
							expect(stopRequests).toHaveLength(1);
							expect(
								yield* sql`SELECT command_id FROM provider_command_outbox WHERE session_id = ${sessionId} AND effect_type = 'interrupt_turn'`,
							).toHaveLength(1);
							evidence["questionReplacementSerializedWithStop"] = true;
							return;
						}
						if (
							scenario === "run-now-during-continuation" ||
							scenario === "other-queue-during-continuation"
						) {
							const persist = yield* ClaudeEventPersistEffectTag;
							yield* persist.persistEvent(
								canonicalEvent("session.usage_limited", sessionId, {
									instanceId: "claude",
									rateLimitType: "seven_day",
									resetsAt: 5,
									cutOffMessageId: "running",
								}),
							);
							const continuation = yield* makeContinuation;
							yield* Effect.forkScoped(continuation.runLimitPolicies);
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => releaseContinuation.resolve()),
							);
							yield* continuation.queueLimitPolicy(sessionId);
							yield* Effect.promise(() => continuationEnding.promise).pipe(
								Effect.timeout("3 seconds"),
							);
							if (scenario === "other-queue-during-continuation") {
								const other = `${sessionId}-other`;
								for (const inputId of ["other-running", "other-next"]) {
									yield* client["input.submit"]({
										sessionId: other,
										inputId,
										text: `${inputId} plain message`,
										delivery: "queue",
										originId: "other-browser",
									});
								}
								yield* awaitCondition(() => sent.includes("other-running"));
								yield* inbox.start;
								yield* finish(other);
								yield* awaitCondition(() => sent.includes("other-next"));
								expect(stopRequests).toEqual([]);
								evidence["otherQueueDrainedBeforeContinuationRelease"] = true;
								yield* Effect.sync(() => releaseContinuation.resolve());
								return;
							}
							const stopping = yield* Effect.forkChild(runNow());
							yield* sql`SELECT 1 FROM events WHERE session_id = ${sessionId}
									AND type = 'input.interrupt_requested'`.pipe(
								Effect.delay("1 millis"),
								Effect.repeat({ until: (rows) => rows.length > 0 }),
								Effect.timeout("3 seconds"),
							);
							// The switch's hold must not keep the inbox permit.
							expect(
								yield* client["input.cancel"]({
									sessionId,
									inputId: "last",
								}).pipe(Effect.timeout("500 millis")),
							).toEqual({ ok: true });
							yield* Effect.sync(() => releaseStop.resolve());
							yield* Effect.sync(() => releaseContinuation.resolve());
							yield* Fiber.join(stopping).pipe(Effect.timeout("3 seconds"));
							// Run now reserved and returned; the continuation resumes on its own.
							yield* sql`SELECT 1 FROM events WHERE session_id = ${sessionId} AND type = 'session.resumed'`.pipe(
								Effect.delay("1 millis"),
								Effect.repeat({ until: (rows) => rows.length > 0 }),
								Effect.timeout("3 seconds"),
							);
							expect(
								yield* sql`SELECT 1 FROM provider_command_outbox WHERE session_id = ${sessionId}
								AND effect_type = 'send_turn' AND json_extract(payload_json, '$.continuation') IS NOT NULL`,
							).toHaveLength(1);
							const [resumed] = yield* sql<{
								limit_recovery: string;
							}>`SELECT limit_recovery FROM sessions WHERE id = ${sessionId}`;
							expect(
								JSON.parse(resumed?.limit_recovery ?? "null"),
							).toMatchObject({ continued: true, switched: true });
							evidence["continuationDispatchedBeforeRunNow"] = true;
							return;
						}
						if (
							[
								"recover-unregistered-reservation",
								"recover-registration-race",
							].includes(scenario)
						) {
							const persist = yield* ClaudeEventPersistEffectTag;
							yield* persist.persistEvent(
								canonicalEvent("input.interrupt_requested", sessionId, {
									sessionId,
									inputId: "selected",
								}),
							);
							expect(stopRequests).toEqual([]);
							yield* inbox.start;
							if (scenario === "recover-registration-race") {
								yield* Effect.promise(() => registrationStarted.promise);
								yield* finish();
								yield* client["input.submit"]({
									sessionId,
									inputId: "concurrent",
									text: "concurrent plain message",
									delivery: "queue",
								}).pipe(Effect.timeout("500 millis"));
								expect(sent).toEqual(["running"]);
								yield* Effect.sync(() => releaseRegistration.resolve());
								yield* sql`SELECT 1 FROM provider_command_outbox control
									JOIN command_receipts receipt ON receipt.command_id = control.command_id
									WHERE control.session_id = ${sessionId} AND control.effect_type = 'interrupt_turn'
									AND control.status = 'completed' AND receipt.status = 'side_effect_completed'`.pipe(
									Effect.delay("1 millis"),
									Effect.repeat({ until: (rows) => rows.length === 1 }),
									Effect.timeout("3 seconds"),
								);
								expect(stopRequests).toEqual([]);
								yield* awaitCondition(() => sent.length === 2);
								expect(providerTurns.turnFences(sessionId).stopping).toBe(
									false,
								);
							} else {
								yield* awaitCondition(() => stopRequests.length === 1);
								if (provider === "opencode") {
									expect(providerTurns.turnFences(sessionId).stopping).toBe(
										true,
									);
									yield* finish();
								}
								yield* Effect.sleep("30 millis");
							}
							expect(sent).toEqual(
								scenario === "recover-registration-race"
									? ["running", "selected"]
									: ["running"],
							);
							yield* Effect.sync(() => releaseStop.resolve());
							yield* awaitCondition(() => sent.length === 2);
							expect(sent).toEqual(["running", "selected"]);
							expect(abortedAtRelease).not.toContain("selected");
							expect(activeTurns.get(sessionId)?.inputId).toBe("selected");
							yield* finish();
							evidence["unfinishedReservationRecovered"] = true;
							return;
						}
						if (scenario === "owner-rebuild") {
							const owner = yield* Scope.make();
							yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
							const first = Context.get(
								yield* Layer.buildWithScope(
									Layer.fresh(ProviderTurnServiceLive),
									owner,
								),
								ProviderTurnServiceTag,
							);
							yield* first.beginStop({
								clientId: "first-owner",
								commandId: "owner-stop",
								sessionId,
							});
							yield* awaitCondition(() => stopRequests.length === 1);
							// Closing the owner interrupts its abort worker, fence included.
							yield* Scope.close(owner, Exit.void).pipe(
								Effect.timeout("500 millis"),
							);
							originalOwnerGone = true;
							expect(first.turnFences(sessionId).stopping).toBe(false);
							const rebuiltOwner = yield* Scope.make();
							yield* Effect.addFinalizer(() =>
								Scope.close(rebuiltOwner, Exit.void),
							);
							const rebuilt = Context.get(
								yield* Layer.buildWithScope(
									Layer.fresh(ProviderTurnServiceLive),
									rebuiltOwner,
								),
								ProviderTurnServiceTag,
							);
							// The original Stop remains durable until its native turn ends.
							expect(rebuilt.turnFences(sessionId).stopping).toBe(true);
							if (activeTurns.has(sessionId)) yield* finish();
							yield* awaitCondition(
								() => !rebuilt.turnFences(sessionId).stopping,
							);
							expect(
								yield* rebuilt.prepareTurnSession({
									clientId: "rebuilt-owner",
									commandId: "replacement",
									sessionId,
								}),
							).toBe(sessionId);
							const dispatch = yield* Effect.result(
								rebuilt.sendTurn({
									clientId: "rebuilt-owner",
									commandId: "replacement",
									sessionId,
									text: "replacement plain message",
								}),
							);
							expect(dispatch._tag).toBe("Success");
							yield* awaitCondition(() => sent.includes("replacement"));
							yield* Effect.sync(() => releaseStop.resolve());
							yield* Effect.sleep("30 millis");
							expect(abortedAtRelease).not.toContain("replacement");
							expect(activeTurns.get(sessionId)?.inputId).toBe("replacement");
							yield* finish();
							evidence["replacementSurvivedOwnerClose"] = true;
							return;
						}
						const manual = ["manual-stop-send", "manual-stop-steer"].includes(
							scenario,
						);
						const request: Effect.Effect<{ readonly ok: boolean }, unknown> =
							manual
								? client.CancelSession({ sessionId, commandId: "manual-stop" })
								: scenario === "cancel-after-reservation"
									? inbox
											.sendNow({
												clientId: "disconnecting-request",
												sessionId,
												inputId: "selected",
												interrupt: true,
											})
											.pipe(
												Effect.map((outcome) => ({
													ok: outcome === "accepted",
												})),
											)
									: runNow();
						const firstRequest = yield* Effect.forkChild(request);
						if (scenario === "cancel-after-reservation")
							cancelAtReservation = Effect.sync(() =>
								firstRequest.interruptUnsafe(),
							);
						const secondRequest =
							scenario === "double-run-now"
								? yield* Effect.forkChild(runNow(secondClient))
								: undefined;
						yield* awaitCondition(() => stopRequests.length >= 1);
						if (scenario === "never-settling") {
							expect(
								yield* Fiber.join(firstRequest).pipe(
									Effect.timeout("500 millis"),
								),
							).toEqual({ ok: true });
							if (provider === "opencode") yield* finish();
							yield* Effect.sleep("20 millis");
							for (const inputId of ["selected", "first"])
								expect(
									yield* client["input.cancel"]({ sessionId, inputId }).pipe(
										Effect.timeout("500 millis"),
									),
								).toEqual({ ok: true });
							yield* client["input.submit"]({
								sessionId,
								inputId: "edited",
								text: "edited plain message",
								delivery: "queue",
							}).pipe(Effect.timeout("500 millis"));
							for (const inputId of ["other-running", "other-next"])
								yield* client["input.submit"]({
									sessionId: `${sessionId}-other`,
									inputId,
									text: `${inputId} plain message`,
									delivery: "queue",
								}).pipe(Effect.timeout("500 millis"));
							yield* awaitCondition(() => sent.includes("other-running"));
							yield* finish(`${sessionId}-other`);
							yield* awaitCondition(() => sent.includes("other-next"));
							yield* finish(`${sessionId}-other`);
							expect(sent).toEqual(["running", "other-running", "other-next"]);
							expect(providerTurns.turnFences(sessionId).stopping).toBe(true);
							evidence["queueEditableWhileAbortPending"] = true;
							evidence["otherSessionDrainedWhileAbortPending"] = true;
							return;
						}
						if (scenario === "abort-rejected") {
							expect(
								yield* Fiber.join(firstRequest).pipe(
									Effect.timeout("500 millis"),
								),
							).toEqual({ ok: true });
							if (activeTurns.get(sessionId)?.inputId === "running")
								yield* finish();
							yield* Effect.sync(() => releaseStop.resolve());
							yield* Effect.sleep("30 millis");
							expect(providerTurns.turnFences(sessionId).stopping).toBe(false);
							yield* client["input.submit"]({
								sessionId,
								inputId: "retry",
								text: "retry plain message",
								delivery: "queue",
							});
							yield* awaitCondition(() => sent.includes("selected"));
							expect(abortedAtRelease).not.toContain("selected");
							expect(activeTurns.get(sessionId)?.inputId).toBe("selected");
							yield* finish();
							evidence["sendRecoveredAfterAbortRejection"] = true;
							return;
						}
						if (scenario === "timeout-recovery") {
							yield* Fiber.join(firstRequest);
							// OpenCode's original turn never ends: the bound must retire it.
							if (
								provider === "claude" &&
								activeTurns.get(sessionId)?.inputId === "running"
							)
								yield* finish();
							if (provider === "claude")
								yield* Effect.sync(() => releaseStop.resolve());
							if (provider === "opencode")
								yield* Effect.sleep(STOP_ABORT_WAIT_MS + 100);
							yield* client["input.submit"]({
								sessionId,
								inputId: "retry",
								text: "retry plain message",
								delivery: "queue",
							});
							yield* awaitCondition(() => sent.includes("selected"));
							if (provider === "claude") {
								yield* Effect.sync(() => releaseStop.resolve());
								yield* Effect.sleep("30 millis");
								expect(abortedAtRelease).not.toContain("selected");
								expect(activeTurns.get(sessionId)?.inputId).toBe("selected");
							}
							// OpenCode deliberately resumes after the bound. Its session-wide
							// abort can still arrive late; native-session remapping is separate work.
							yield* finish();
							evidence["sendRecoveredAfterBound"] = true;
							return;
						}
						if (["manual-stop-send", "manual-stop-steer"].includes(scenario))
							yield* client["input.submit"]({
								sessionId,
								inputId: "selected",
								text: "selected plain message",
								images: [image],
								delivery: scenario === "manual-stop-steer" ? "steer" : "queue",
							}).pipe(Effect.timeout("500 millis"));
						const terminalBeforeAcknowledgement = [
							"natural-completion-race",
							"slow-run-now",
							"manual-stop-send",
							"manual-stop-steer",
						].includes(scenario);
						if (terminalBeforeAcknowledgement) {
							if (activeTurns.get(sessionId)?.inputId === "running")
								yield* finish();
							// Cross the former timeout with the old turn already terminal.
							yield* Effect.sleep(
								scenario === "natural-completion-race"
									? "20 millis"
									: "5100 millis",
							);
						} else yield* Effect.sleep("20 millis");
						if (provider === "claude") {
							if (!terminalBeforeAcknowledgement) {
								expect(sent).toEqual(["running"]);
								yield* Effect.sync(() => releaseStop.resolve());
							}
							yield* awaitCondition(() => sent.length === 2);
							if (terminalBeforeAcknowledgement) {
								expect(providerTurns.turnFences(sessionId).stopping).toBe(
									false,
								);
								expect(activeTurns.get(sessionId)?.inputId).toBe("selected");
							}
						}
						expect(sent).toEqual(
							provider === "claude" ? ["running", "selected"] : ["running"],
						);
						expect(stopRequests).toHaveLength(1);
						if (manual && provider === "opencode")
							expect(firstRequest.pollUnsafe() === undefined).toBe(true);
						else if (scenario === "cancel-after-reservation") {
							expect((yield* Fiber.await(firstRequest))._tag).toBe("Failure");
							expect(providerTurns.turnFences(sessionId).stopping).toBe(
								provider === "opencode",
							);
						} else
							expect(
								yield* Fiber.join(firstRequest).pipe(
									Effect.timeout("500 millis"),
								),
							).toEqual({ ok: true });
						if (secondRequest)
							expect(secondRequest.pollUnsafe() !== undefined).toBe(true);
						yield* Effect.sync(() => releaseStop.resolve());
						if (scenario !== "cancel-after-reservation")
							expect(yield* Fiber.join(firstRequest)).toEqual({ ok: true });
						if (secondRequest)
							expect(yield* Fiber.join(secondRequest)).toEqual({ ok: true });
						yield* awaitCondition(() => sent.length === 2);
						expect(sent).toEqual(["running", "selected"]);
						expect(providerInputs[1]).toEqual({
							inputId: "selected",
							images: [image],
						});
						expect(abortedAtRelease).not.toContain("selected");
						if (["manual-stop-send", "manual-stop-steer"].includes(scenario)) {
							expect(
								yield* sql`SELECT 1 FROM events WHERE session_id = ${sessionId}
								AND type = 'input.sent' AND json_extract(data, '$.steer') = 1`,
							).toEqual([]);
							yield* finish();
							evidence["replacementSurvivedLateAbort"] = true;
							return;
						}
						const queued = yield* sql<{
							input_id: string;
						}>`SELECT input_id FROM pending_inputs WHERE session_id = ${sessionId} AND state = 'queued' ORDER BY admitted_at, rowid`;
						expect(queued.map((row) => row.input_id)).toEqual([
							"first",
							"last",
						]);
						expect(yield* runNow()).toEqual({
							ok: false,
							reason: "already_started",
						});
						expect(stopRequests).toHaveLength(1);
						for (const count of [3, 4, 5]) {
							yield* finish();
							if (count < 5) yield* awaitCondition(() => sent.length === count);
						}
						yield* sql<{
							n: number;
						}>`SELECT COUNT(*) AS n FROM turns WHERE session_id = ${sessionId} AND state = 'running'`.pipe(
							Effect.repeat({ until: (rows) => rows[0]?.n === 0 }),
							Effect.timeout("3 seconds"),
						);
						yield* sql<{
							n: number;
						}>`SELECT COUNT(*) AS n FROM provider_command_outbox WHERE session_id = ${sessionId} AND status IN ('pending', 'running', 'retryable_failed')`.pipe(
							Effect.repeat({ until: (rows) => rows[0]?.n === 0 }),
							Effect.timeout("3 seconds"),
						);
						expect(sent).toEqual(["running", "selected", "first", "last"]);
						const turns = yield* sql<{
							input_id: string;
							user_message_id: string;
							state: string;
							run_id: string;
						}>`SELECT user.input_id, turns.user_message_id, turns.state, turns.run_id
							FROM turns JOIN messages user ON user.id = turns.user_message_id
							AND user.session_id = turns.session_id
							WHERE turns.session_id = ${sessionId} ORDER BY turns.rowid`;
						expect(turns.map((turn) => turn.input_id)).toEqual(sent);
						expect(turns.map((turn) => turn.run_id)).toEqual(
							sent.map(() => expect.any(String)),
						);
						expect(turns[0]?.state).toBe(
							["natural-completion-race", "slow-run-now"].includes(scenario)
								? "completed"
								: provider === "claude"
									? "interrupted"
									: "error",
						);
						expect(
							turns.slice(1).every((turn) => turn.state === "completed"),
						).toBe(true);
						const messages = yield* sql<{
							input_id: string;
							text: string;
						}>`SELECT input_id, text FROM messages WHERE session_id = ${sessionId} AND role = 'user' ORDER BY rowid`;
						expect(messages).toEqual(
							sent.map((inputId) => ({
								input_id: inputId,
								text: `${inputId} plain message`,
							})),
						);
						const steers =
							yield* sql`SELECT 1 FROM events WHERE session_id = ${sessionId} AND type = 'input.sent' AND json_extract(data, '$.steer') = 1`;
						expect(steers).toEqual([]);
						const reservations =
							yield* sql`SELECT 1 FROM events WHERE session_id = ${sessionId} AND type = 'input.interrupt_requested'`;
						expect(reservations).toHaveLength(1);
						const outbox = yield* sql<{
							command_id: string;
							effect_type: string;
							status: string;
						}>`SELECT command_id, effect_type, status FROM provider_command_outbox WHERE session_id = ${sessionId} ORDER BY request_sequence`;
						expect(
							outbox
								.filter((row) => row.effect_type === "send_turn")
								.map((row) => row.command_id),
						).toEqual(sent);
						expect(
							outbox
								.filter((row) => row.effect_type === "send_turn")
								.slice(1)
								.map((row) => row.status),
						).toEqual(["completed", "completed", "completed"]);
						evidence["queued"] = queued;
						evidence["messages"] = messages;
						evidence["turns"] = turns;
						evidence["outbox"] = outbox;
					}).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								disposing = true;
								if (scenario !== "never-settling") releaseStop.resolve();
							}),
						),
						Effect.scoped,
						Effect.provide(layer),
						Effect.onExit((exit) =>
							Effect.sync(() => {
								if (scenario === "question-replacement-session-lock")
									Object.assign(evidence, {
										passed: exit._tag === "Success",
										outcome: exit._tag,
										provider,
										stopRequests,
										abortedAtRelease,
										naturalResults,
										sent,
										providerInputs,
										nativeCallCount: stopRequests.length,
									});
								mkdirSync("test-results", { recursive: true });
								writeFileSync(
									`test-results/aoqb-18-stop-fence-${provider}-${scenario}.json`,
									JSON.stringify(
										{
											outcome: exit._tag,
											provider,
											scenario,
											stopRequests,
											abortedAtRelease,
											naturalResults,
											sent,
											providerInputs,
											...evidence,
										},
										null,
										2,
									),
								);
							}),
						),
					),
				);
				await running;
			} finally {
				releaseContinuation.resolve();
				releaseRegistration.resolve();
				releaseStop.resolve();
				rmSync(scratch, { recursive: true, force: true });
			}
		}, 45_000);
	}
});
