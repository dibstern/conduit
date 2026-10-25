import { tmpdir } from "node:os";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { AttachmentStoreTag } from "../../../src/lib/domain/persistence/Services/attachment-store.js";
import { RateLimiterLive } from "../../../src/lib/domain/relay/Layers/rate-limiter-layer.js";
import { InputDraftsTag } from "../../../src/lib/domain/relay/Services/input-drafts.js";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { setModel } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import { sendMessageToSession } from "../../../src/lib/handlers/prompt.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { runnerFailure } from "../../../src/lib/provider/runner/runner-protocol.js";
import { makeRunnerProviderInstance } from "../../../src/lib/provider/runner/runner-provider-instance.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	MOCK_OPENCODE_GPT4_CATALOG,
	makeMockConfig,
	makeMockOpenCodeModelService,
	makeMockSessionManagerService,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer input.submit", () => {
	for (const input of [
		{ sessionId: "session-1", text: "" },
		{ sessionId: undefined, text: "hello" },
	]) {
		it.effect(
			`reports no handoff for ${input.sessionId ? "empty text" : "no active session"}`,
			() =>
				sendMessageToSession({
					...input,
					clientId: "browser-tab-a",
					commandId: "cmd-no-handoff",
				}).pipe(
					Effect.tap((result) =>
						Effect.sync(() => {
							expect(result).toEqual({
								sessionId: input.sessionId,
								handedOff: false,
							});
						}),
					),
					Effect.scoped,
					Effect.provide(makeTestHandlerLayer(), { local: true }),
				),
		);
	}

	for (const method of ["input.submit", "StartSideThread"] as const) {
		for (const receipt of ["queued", "message", "uncommitted"] as const) {
			it.effect(
				`${method} ${receipt === "uncommitted" ? "rejects an uncommitted input" : `acknowledges a ${receipt} input retry`} before preparing a quarantined session`,
				() => {
					const registry = new ProviderRegistry();
					const recordMessageActivity = vi.fn(() => Effect.void);
					return Effect.gen(function* () {
						const provider = yield* makeRunnerProviderInstance(
							{
								accounts: Effect.succeed(
									accountsStateFromInstances(
										[],
										configuredClaudeConfigDir(tmpdir()),
									),
								),
							},
							{
								driverKind: "claude",
								discoverEffect: () => Effect.die("Unexpected discovery"),
								generateTextEffect: () => Effect.die("Unexpected generation"),
								prepareTurnEffect: () => Effect.die("Unexpected preparation"),
							},
							() =>
								Effect.succeed({
									hasLiveProcessEffect: () => Effect.succeed(true),
									getSessionFailureEffect: () =>
										Effect.succeed({
											operation: "send-turn",
											message: "Runner is quarantined",
											code: "runner_quarantined",
											retryable: false,
										}),
									executeEffect: () =>
										Effect.fail(
											runnerFailure("test cleanup", "No runner process"),
										),
								}),
						);
						registry.registerInstance(provider);
						const sql = yield* SqlClient.SqlClient;
						const pending = yield* PendingInteractionServiceTag;
						const drafts = yield* InputDraftsTag;
						const put = vi.spyOn(yield* AttachmentStoreTag, "put");
						const prepare = vi.spyOn(
							yield* ProviderTurnServiceTag,
							"prepareTurnSession",
						);
						const question = yield* pending.recordQuestionRequest({
							requestId: "recovered-question",
							sessionId: "thread",
							questions: [{ question: "Keep this question?" }],
							recovered: true,
						});
						yield* drafts.write({ session: "thread" }, "newer draft");
						const before =
							yield* sql`SELECT event_id FROM events ORDER BY sequence`;
						const client = yield* rpcClient;
						const request = {
							inputId: "original-input",
							text: "original prompt",
							images: ["data:image/png;base64,YWJj"],
							originId: "browser-tab-a",
						};
						const result = yield* method === "input.submit"
							? Effect.result(
									client[method]({
										...request,
										sessionId: receipt === "uncommitted" ? "thread" : "parent",
										delivery: "queue",
									}),
								)
							: Effect.result(
									client[method]({
										...request,
										sessionId: "parent",
										title: "Side thread",
									}),
								);
						if (receipt === "uncommitted") {
							expect(result).toMatchObject({
								_tag: "Failure",
								failure: {
									_tag: "WsRpcError",
									message: expect.stringContaining("Runner is quarantined"),
								},
							});
						} else {
							expect(result).toMatchObject({
								_tag: "Success",
								success:
									method === "input.submit"
										? { ok: true, sessionId: "thread", handedOff: false }
										: { sessionId: "thread" },
							});
						}
						expect(prepare).not.toHaveBeenCalled();
						expect(put).not.toHaveBeenCalled();
						expect(recordMessageActivity).not.toHaveBeenCalled();
						expect(yield* pending.listPendingQuestions("thread")).toEqual([
							question,
						]);
						expect(yield* drafts.read({ session: "thread" })).toBe(
							"newer draft",
						);
						expect(
							yield* sql`SELECT event_id FROM events ORDER BY sequence`,
						).toEqual(before);
					}).pipe(
						Effect.scoped,
						Effect.provide(
							WsRpcServerLayer.pipe(
								Layer.provideMerge(
									makeTestHandlerLayer({
										providerRegistry: registry,
										seedEvents: [
											makeSessionCreatedEvent("parent", { provider: "claude" }),
											canonicalEvent("session.created", "thread", {
												sessionId: "thread",
												title: "Side thread",
												provider: "claude",
												parentId: "parent",
												sideThread: true,
												startInputId: "original-input",
											}),
											...(receipt === "queued"
												? [
														canonicalEvent("input.admitted", "thread", {
															sessionId: "thread",
															inputId: "original-input",
															delivery: "queue",
															request: { text: "original prompt" },
														}),
													]
												: receipt === "message"
													? [
															canonicalEvent("message.created", "thread", {
																sessionId: "thread",
																messageId: "native-user-message",
																role: "user",
																inputId: "original-input",
															}),
														]
													: []),
										],
										sessionManagerService: makeMockSessionManagerService({
											recordMessageActivity,
										}),
									}),
								),
							),
							{ local: true },
						),
					);
				},
			);
		}
	}

	it.effect("passes the input id through to provider orchestration", () => {
		const dispatch = vi.fn(() =>
			Effect.succeed({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			}),
		);
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatchEffect: dispatch,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			yield* setModel("session-1", {
				providerID: "claude",
				modelID: "sonnet",
			});

			yield* client["input.submit"]({
				sessionId: "session-1",
				text: "hello",
				originId: "browser-tab-a",
				inputId: "cmd-send-1",
				delivery: "queue",
			});

			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					commandId: "cmd-send-1",
				}),
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							config: makeMockConfig({ projectDir: tmpdir() }),
							orchestrationEngine: engine,
							seedEvents: [
								makeSessionCreatedEvent("session-1", { provider: "claude" }),
								...sessionPickEvents("session-1", {
									harness: "claude",
									model: { providerId: "claude", modelId: "sonnet" },
									effort: "",
									contextWindow: "",
								}),
							],
							claudeEventPersistEffect: {
								persistHandoffDelivered: () => Effect.void,
								persistEvent: () => Effect.void,
								persistEvents: () => Effect.void,
								persistUserMessage: () => Effect.void,
								ensureClaudeSubagentSession: () => Effect.void,
								readClaudeSubagentTranscript: () =>
									Effect.succeed({ messages: [], parts: [] }),
							},
						}),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("sends prompts through the shared prompt path", () => {
		const dispatchEffect = vi.fn(
			(command: { onAccepted?: Effect.Effect<void> }) =>
				// The engine commits the handoff, then the turn runs on.
				Effect.andThen(command.onAccepted ?? Effect.void, Effect.never),
		);
		const engine = withDispatchEffect({ dispatchEffect });
		engine.bindSession("session-1", "opencode");
		const recordMessageActivity = vi.fn(() => Effect.void);

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client["input.submit"]({
				sessionId: "session-1",
				text: "hello",
				images: ["data:image/png;base64,abc"],
				originId: "browser-tab-a",
				inputId: "cmd-send-legacy-test",
				delivery: "queue",
			});

			expect(result).toEqual({
				ok: true,
				sessionId: "session-1",
				handedOff: true,
			});
			expect(recordMessageActivity).toHaveBeenCalledWith("session-1");
			expect(dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					input: expect.objectContaining({
						sessionId: "session-1",
						prompt: "hello",
						images: [
							expect.objectContaining({
								attachmentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
								mime: "image/png",
							}),
						],
					}),
				}),
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							config: makeMockConfig({ projectDir: tmpdir() }),
							orchestrationEngine: engine,
							openCodeModelService: makeMockOpenCodeModelService(
								MOCK_OPENCODE_GPT4_CATALOG,
							),
							seedEvents: [
								makeSessionCreatedEvent("session-1"),
								...sessionPickEvents("session-1", {
									harness: "opencode",
									model: { providerId: "openai", modelId: "gpt-4" },
									effort: "",
									contextWindow: "",
								}),
							],
							sessionManagerService: makeMockSessionManagerService({
								recordMessageActivity,
							}),
						}),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("applies the relay rate limit when a limiter is available", () => {
		const dispatchEffect = vi.fn(
			(command: { onAccepted?: Effect.Effect<void> }) =>
				// The engine commits the handoff, then the turn runs on.
				Effect.andThen(command.onAccepted ?? Effect.void, Effect.never),
		);
		const engine = withDispatchEffect({ dispatchEffect });
		engine.bindSession("session-1", "opencode");

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			yield* client["input.submit"]({
				sessionId: "session-1",
				text: "first",
				originId: "browser-tab-a",
				inputId: "cmd-rate-1",
				delivery: "queue",
			});

			const second = yield* Effect.result(
				client["input.submit"]({
					sessionId: "session-1",
					text: "second",
					originId: "browser-tab-a",
					inputId: "cmd-rate-2",
					delivery: "queue",
				}),
			);

			expect(second._tag).toBe("Failure");
			expect(dispatchEffect).toHaveBeenCalledTimes(1);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							makeTestHandlerLayer({
								config: makeMockConfig({ projectDir: tmpdir() }),
								orchestrationEngine: engine,
								openCodeModelService: makeMockOpenCodeModelService(
									MOCK_OPENCODE_GPT4_CATALOG,
								),
								seedEvents: [
									makeSessionCreatedEvent("session-1"),
									...sessionPickEvents("session-1", {
										harness: "opencode",
										model: { providerId: "openai", modelId: "gpt-4" },
										effort: "",
										contextWindow: "",
									}),
								],
							}),
							RateLimiterLive({ maxRequests: 1, windowMs: 60_000 }),
						),
					),
				),
				{ local: true },
			),
		);
	});
});
