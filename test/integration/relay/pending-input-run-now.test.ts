import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { SqlClient } from "@effect/sql";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { ContinuationTag } from "../../../src/lib/domain/relay/Services/continuation.js";
import { makeEffectOpenCodeRuntimeIngress } from "../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeClaudeSessionRunner } from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { SDKMessage } from "../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../src/lib/provider/event-sink-errors.js";
import {
	getOrchestrationLayer,
	makeOrchestrationRuntimeLayer,
} from "../../../src/lib/provider/orchestration-wiring.js";
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
import { makeSSEEvent } from "../../helpers/sse-factories.js";

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
describe("Run now through RPC, inbox, durable orchestration and provider adapters", () => {
	for (const provider of ["claude", "opencode"] as const) {
		it.each([
			"normal",
			"natural-completion-race",
			"double-run-now",
		] as const)(`${provider}: %s runs the selected input next after Stop`, async (scenario) => {
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
			const releaseStop = signal<void>();
			type ActiveTurn = {
				inputId: string;
				complete: (interrupted?: boolean) => Promise<void>;
			};
			const activeTurns = new Map<string, ActiveTurn>();
			let emitSSE: (event: SSEEvent) => Promise<void> = async () => {
				throw new Error("OpenCode ingress is not ready");
			};
			const stop = async (sid = sessionId) => {
				if (!disposing) stopRequests.push(sessionId);
				if (sid === sessionId) await releaseStop.promise;
				// The real OpenCode endpoint and Claude interrupt are session-wide.
				// Applying at release makes an early replacement fail this test.
				const active = activeTurns.get(sid);
				if (active) {
					if (!disposing) abortedAtRelease.push(active.inputId);
					await active.complete(true);
				}
			};
			const api = makeMockOpenCodeAPI();
			api.session.abort = vi.fn(stop);
			api.session.prompt = vi.fn(async (sessionId, options) => {
				const inputId = options.text.split(" ")[0] ?? "";
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
										parentID: inputId,
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
						info: { id: inputId, role: "user", time: { created: Date.now() } },
					}),
				);
				await emitSSE(
					makeSSEEvent("message.part.updated", {
						sessionID: sessionId,
						part: {
							id: `${inputId}-text`,
							messageID: inputId,
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
							parentID: inputId,
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
					let queryTurn: ActiveTurn | undefined;
					const stream = (async function* (): AsyncGenerator<SDKMessage> {
						for await (const user of prompt) {
							if (closed) return;
							const inputId = user.uuid ?? "";
							const content = user.message.content;
							const images =
								typeof content === "string"
									? []
									: content.flatMap((block) =>
											block.type === "image" && block.source.type === "base64"
												? [block.source.data]
												: [],
										);
							const result = signal<boolean>();
							queryTurn = {
								inputId,
								complete: async (interrupted = false) => {
									if (activeTurns.get(sessionId) === queryTurn)
										activeTurns.delete(sessionId);
									result.resolve(interrupted);
								},
							};
							activeTurns.set(sessionId, queryTurn);
							sent.push(inputId);
							providerInputs.push({ inputId, images });
							yield {
								type: "assistant",
								uuid: "00000000-0000-0000-0000-000000000001",
								session_id: sessionId,
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
										session_id: sessionId,
										...(user.uuid ? { user_message_uuid: user.uuid } : {}),
									})
								: makeSuccessResult({
										session_id: sessionId,
										...(user.uuid ? { user_message_uuid: user.uuid } : {}),
									});
						}
					})();
					return Object.assign(createMockQuery([]), {
						interrupt: vi.fn(() => stop()),
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
				Layer.provideMerge(
					Layer.mergeAll(
						persistence,
						SessionEventBusLive,
						makeProviderRuntimeIngestionLive().pipe(
							Layer.provide(Layer.merge(persistence, SessionEventBusLive)),
						),
						Layer.succeed(AccountDirectory, accounts),
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(
							OpenCodeInstancesTag,
							makeOpenCodeInstancesStub({ opencode: api }),
						),
					),
				),
			);
			const layer = Layer.unwrapScoped(
				Effect.gen(function* () {
					const wired = yield* getOrchestrationLayer;
					const ingress = yield* makeEffectOpenCodeRuntimeIngress(
						makeMockLogger(),
						undefined,
						(sid, mid) => wired.openCodeInstance.inputIdForUserEcho(sid, mid),
					);
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => ingress.shutdown()),
					);
					let onSSE: (event: unknown) => void = () => {};
					wired.wireSSEToInstance((_event, handler) => {
						onSSE = handler;
					});
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
						onSSE(event);
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
								makeSessionCreatedEvent(sessionId, { provider }),
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
							pickFailover: () => Effect.succeed(undefined),
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
					return WsRpcServerLayer.pipe(
						Layer.provideMerge(SessionInboxLive.pipe(Layer.provideMerge(deps))),
					);
				}),
			).pipe(Layer.provideMerge(orchestration));
			const evidence: Record<string, unknown> = {};
			try {
				const running = Effect.runPromise(
					Effect.gen(function* () {
						const client = yield* RpcTest.makeClient(WsRpcGroup);
						const inbox = yield* SessionInboxTag;
						const sql = yield* SqlClient.SqlClient;
						yield* Effect.addFinalizer(() =>
							Effect.gen(function* () {
								evidence["finalTurns"] =
									yield* sql`SELECT user_message_id, state FROM turns WHERE session_id = ${sessionId} ORDER BY rowid`;
								evidence["finalCommands"] =
									yield* sql`SELECT command_id, status FROM command_receipts WHERE session_id = ${sessionId}`;
								evidence["finalErrors"] =
									yield* sql`SELECT type, data FROM events WHERE session_id = ${sessionId} AND type = 'turn.error'`;
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
						yield* inbox.start;
						for (const inputId of ["running", "first", "selected", "last"]) {
							yield* client.input.submit({
								sessionId,
								inputId,
								text: `${inputId} plain message`,
								...(inputId === "selected" ? { images: [image] } : {}),
								delivery: "queue",
								originId: "run-now-browser",
							});
							if (inputId === "running")
								yield* awaitCondition(() => sent.length === 1);
						}
						const secondClient = yield* RpcTest.makeClient(WsRpcGroup);
						const runNow = (rpc = client) =>
							rpc.input.sendNow({
								sessionId,
								inputId: "selected",
								interrupt: true,
							});
						const firstRequest = yield* Effect.fork(runNow());
						const secondRequest =
							scenario === "double-run-now"
								? yield* Effect.fork(runNow(secondClient))
								: undefined;
						yield* awaitCondition(() => stopRequests.length >= 1);
						if (scenario === "natural-completion-race") {
							yield* finish();
							// Match manual Stop then Send, using the base bounded fence.
							yield* Effect.sleep("20 millis");
						} else yield* Effect.sleep("20 millis");
						expect(sent).toEqual(["running"]);
						expect(stopRequests).toHaveLength(1);
						expect(Option.isNone(yield* Fiber.poll(firstRequest))).toBe(true);
						if (secondRequest)
							expect(Option.isSome(yield* Fiber.poll(secondRequest))).toBe(
								true,
							);
						yield* Effect.sync(() => releaseStop.resolve());
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
							user_message_id: string;
							state: string;
						}>`SELECT user_message_id, state FROM turns WHERE session_id = ${sessionId} ORDER BY rowid`;
						expect(turns.map((turn) => turn.user_message_id)).toEqual(sent);
						expect(turns[0]?.state).toBe(
							provider === "claude"
								? "interrupted"
								: scenario === "natural-completion-race"
									? "completed"
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
								releaseStop.resolve();
							}),
						),
						Effect.scoped,
						Effect.provide(layer),
						Effect.onExit((exit) =>
							Effect.sync(() => {
								mkdirSync("test-results", { recursive: true });
								writeFileSync(
									`test-results/aoqb-13-run-now-${provider}-${scenario}.json`,
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
				releaseStop.resolve();
				rmSync(scratch, { recursive: true, force: true });
			}
		});
	}
});
