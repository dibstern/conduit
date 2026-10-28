import { describe, it } from "@effect/vitest";
import {
	type Context,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Option,
	Scope,
	Stream,
} from "effect";
import { RpcTest } from "effect/rpc";
import { expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import {
	SessionDirectory,
	SessionDirectoryReadError,
} from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { makeWsTransportLive } from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { makeSessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeRoutedWsRpcServerLayer,
	RpcSubscriptionScopeLive,
} from "../../../src/lib/server/ws-rpc.js";
import {
	makeRoutedWsRpcWebSocketHandler,
	makeWsRpcWebSocketHandler,
} from "../../../src/lib/server/ws-rpc-handler.js";
import {
	makeMockConfig,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const sessionDirectory = Layer.succeed(SessionDirectory)({
	projectOf: (sessionId) =>
		Effect.succeed(
			sessionId === "session-a" ? Option.some("project-a") : Option.none(),
		),
});
describe("routed RPC server", () => {
	it.effect(
		"EA27 routed ownership failure is refused before producer acquisition",
		() =>
			Effect.gen(function* () {
				const wsHandler = makeMockWebSocketHandler();
				let lookups = 0;
				const directory = Layer.succeed(SessionDirectory)({
					projectOf: (sessionId) =>
						++lookups === 1
							? Effect.succeed(Option.some("project-a"))
							: Effect.yieldNow.pipe(
									Effect.andThen(
										Effect.fail(
											new SessionDirectoryReadError({
												sessionId,
												cause: "unavailable",
											}),
										),
									),
								),
				});
				const context = yield* Layer.build(
					Layer.mergeAll(
						RpcSubscriptionScopeLive,
						makeTestHandlerLayer({
							wsHandler,
							config: makeMockConfig({ slug: "project-a" }),
						}),
					),
				);
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(() => Effect.succeed(context)).pipe(
							Layer.provide(directory),
						),
						{ local: true },
					),
				);
				const result = yield* client
					.SubscribeSessionDetail({ sessionId: "session-a" })
					.pipe(Stream.runHead, Effect.result);
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "WsRpcError", code: "ownership-lookup-failed" },
				});
				expect(wsHandler.registerSessionViewer).not.toHaveBeenCalled();
			}),
	);
	it.effect(
		"rejects session creation without a project even with a relay default",
		() =>
			Effect.gen(function* () {
				const resolve = vi.fn(() =>
					Effect.fail(
						new WsRpcError({ message: "unexpected relay resolution" }),
					),
				);
				const createSession = yield* WsRpcGroup.accessHandler(
					"CreateSession",
				).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, "conduit").pipe(
							Layer.provide(sessionDirectory),
						),
						{ local: true },
					),
				);
				const malformed = {
					_tag: "CreateSession" as const,
					originId: "relay-client",
				};
				const result = yield* Effect.result(
					// @ts-expect-error CreateSession requires an explicit projectSlug.
					createSession(malformed, Headers.empty),
				);
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { message: "projectSlug is required" },
				});
				expect(resolve).not.toHaveBeenCalled();
			}),
	);

	it.effect(
		"serves a named project's approvals, a subagent's included, and no other project's",
		() =>
			Effect.gen(function* () {
				const contexts = new Map<string, Context.Context<unknown>>();
				for (const slug of ["project-a", "project-b"]) {
					const bus = makeSessionEventBusLive();
					const context = yield* Layer.build(
						Layer.mergeAll(
							RpcSubscriptionScopeLive,
							Layer.succeed(ConfigTag)(makeMockConfig({ slug })),
							bus,
							makePersistenceEffectLayer(":memory:", slug, undefined, bus),
							Layer.effect(SessionActivityTag, makeSessionActivity),
						),
					);
					contexts.set(slug, context as Context.Context<unknown>);
					const at = { provider: "claude", createdAt: 1 };
					yield* Effect.gen(function* () {
						const runner = yield* ProjectionRunnerEffectTag;
						yield* runner.recover();
						const commit = yield* makeCommitAndSignal;
						yield* commit([
							canonicalEvent(
								"session.created",
								`${slug}-parent`,
								{ sessionId: `${slug}-parent`, title: "p", provider: "claude" },
								at,
							),
							canonicalEvent(
								"session.created",
								`${slug}-child`,
								{
									sessionId: `${slug}-child`,
									title: "c",
									provider: "claude",
									parentId: `${slug}-parent`,
								},
								at,
							),
							canonicalEvent(
								"permission.asked",
								`${slug}-child`,
								{
									id: `${slug}-perm`,
									sessionId: `${slug}-child`,
									toolName: "Bash",
									input: { command: "ls" },
								},
								at,
							),
							canonicalEvent(
								"question.asked",
								`${slug}-parent`,
								{
									id: `${slug}-que`,
									sessionId: `${slug}-parent`,
									questions: [
										{
											question: "Q?",
											header: "H",
											options: [],
											multiSelect: false,
										},
									],
								},
								at,
							),
						]);
					}).pipe(Effect.provide(context));
				}
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer((slug) => {
							const context = contexts.get(slug);
							return context
								? Effect.succeed(context)
								: Effect.fail(
										new WsRpcError({ message: `Unknown project ${slug}` }),
									);
						}).pipe(Layer.provide(sessionDirectory)),
						{ local: true },
					),
				);
				const envelopes = yield* client
					.SubscribeApprovals({ projectSlug: "project-b" })
					.pipe(Stream.take(2), Stream.runCollect);
				const [snapshot, synchronized] = Array.from(envelopes);
				expect(synchronized).toEqual({ _tag: "synchronized" });
				const rows = snapshot?._tag === "snapshot" ? snapshot.rows : [];
				expect(rows).toHaveLength(2);
				expect(rows).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							_tag: "permission",
							requestId: "project-b-perm",
							sessionId: "project-b-child",
						}),
						expect.objectContaining({
							_tag: "question",
							toolId: "project-b-que",
							sessionId: "project-b-parent",
						}),
					]),
				);
			}),
	);

	it.effect(
		"AttachProject replies with the daemon's resolved project without resolving a relay context",
		() =>
			Effect.gen(function* () {
				const resolve = vi.fn(() =>
					Effect.fail(new WsRpcError({ message: "unexpected relay context" })),
				);
				const attachProject = vi.fn(() =>
					Effect.succeed({
						projectSlug: "project-c",
						sessionSlug: "project-c",
					}),
				);
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(
							resolve,
							undefined,
							undefined,
							attachProject,
						).pipe(Layer.provide(sessionDirectory)),
						{ local: true },
					),
				);
				expect(
					yield* client.AttachProject({
						projectSlug: "project-b",
						originId: "daemon-client",
					}),
				).toEqual({ projectSlug: "project-c", sessionSlug: "project-c" });
				expect(attachProject).toHaveBeenCalledWith(
					expect.objectContaining({
						projectSlug: "project-b",
						originId: "daemon-client",
					}),
					expect.anything(),
				);
				expect(resolve).not.toHaveBeenCalled();
			}),
	);

	it.effect(
		"AttachProject on a standalone relay replies with its own project",
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(
					makeTestHandlerLayer({
						config: makeMockConfig({ slug: "initial" }),
					}).pipe(Layer.provideMerge(RpcSubscriptionScopeLive)),
				);
				const resolve = vi.fn(() => Effect.succeed(context));
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, "initial").pipe(
							Layer.provide(sessionDirectory),
						),
						{ local: true },
					),
				);
				expect(
					yield* client.AttachProject({ originId: "relay-client" }),
				).toEqual({ projectSlug: "initial", sessionSlug: null });
				expect(resolve).toHaveBeenCalledWith("initial");
			}),
	);

	it.effect("routes ViewSession through the project handler", () =>
		Effect.gen(function* () {
			const context = yield* Layer.build(
				makeTestHandlerLayer().pipe(
					Layer.provideMerge(RpcSubscriptionScopeLive),
				),
			);
			const resolve = vi.fn(() => Effect.succeed(context));
			const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
				Effect.provide(
					makeRoutedWsRpcServerLayer(resolve).pipe(
						Layer.provide(sessionDirectory),
					),
					{ local: true },
				),
			);

			expect(
				yield* client.ViewSession({
					sessionId: "session-a",
					originId: "relay-client",
				}),
			).toEqual({ ok: true });
			expect(resolve).toHaveBeenCalledWith("project-a");
		}),
	);

	it.effect(
		"uses the initial standalone relay when a daemon request omits projectSlug",
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(
					makeTestHandlerLayer({
						config: makeMockConfig({ slug: "initial" }),
					}).pipe(Layer.provideMerge(RpcSubscriptionScopeLive)),
				);
				const resolve = vi.fn(() => Effect.succeed(context));
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, "initial").pipe(
							Layer.provide(sessionDirectory),
						),
						{ local: true },
					),
				);
				expect(yield* client.GetProjects({})).toMatchObject({
					current: "initial",
					projects: [],
				});
				expect(resolve).toHaveBeenCalledWith("initial");
				yield* client.GetProjects({ projectSlug: "explicit" });
				expect(resolve).toHaveBeenCalledWith("explicit");
			}),
	);

	it.effect("does not return a disposed relay's context", () =>
		Effect.gen(function* () {
			const runtime = yield* Effect.acquireRelease(
				Effect.sync(() =>
					ManagedRuntime.make(
						Layer.merge(
							makeTestHandlerLayer(),
							makeWsTransportLive({ noServer: true }),
						),
					),
				),
				(runtime) => runtime.disposeEffect,
			);
			const handler = yield* makeWsRpcWebSocketHandler({ runtime }).pipe(
				Effect.provide(yield* runtime.contextEffect),
			);
			if (!handler.context) throw new Error("Missing relay context");
			expect((yield* Effect.exit(handler.context))._tag).toBe("Success");
			yield* runtime.disposeEffect;
			expect((yield* Effect.exit(handler.context))._tag).toBe("Failure");
		}),
	);

	it.effect(
		"uses each project's services and keeps serving after a routing error",
		() =>
			Effect.gen(function* () {
				const contexts = new Map<string, Context.Context<unknown>>();
				for (const slug of ["project-a", "project-b"]) {
					contexts.set(
						slug,
						yield* Layer.build(
							makeTestHandlerLayer({
								config: makeMockConfig({ slug }),
								projectManagementService: {
									currentSlug: () => Effect.succeed(slug),
									list: () =>
										Effect.succeed([
											{ slug, title: slug, folders: [`/tmp/${slug}`] as const },
										]),
									save: () => Effect.die("Unexpected save"),
									remove: () => Effect.die("Unexpected remove"),
								},
							}),
						),
					);
				}
				const resolve = vi.fn((slug: string) => {
					const context = contexts.get(slug);
					return context
						? Effect.succeed(context)
						: Effect.fail(
								new WsRpcError({ message: `Project "${slug}" unavailable` }),
							);
				});
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve).pipe(
							Layer.provide(sessionDirectory),
						),
						{ local: true },
					),
				);
				const results = yield* Effect.all(
					[
						client.GetProjects({ projectSlug: "project-a" }),
						client.GetProjects({ projectSlug: "project-b" }),
					],
					{ concurrency: 2 },
				);
				expect(results[0]).toMatchObject({
					current: "project-a",
					projects: [{ slug: "project-a" }],
				});
				expect(results[1]).toMatchObject({
					current: "project-b",
					projects: [{ slug: "project-b" }],
				});
				const missing = yield* Effect.result(
					client.GetProjects({ projectSlug: "missing" }),
				);
				expect(missing._tag).toBe("Failure");
				if (missing._tag === "Failure") {
					expect(missing.failure).toBeInstanceOf(WsRpcError);
					expect(missing.failure.message).toContain("missing");
				}
				expect(
					yield* client.GetProjects({ projectSlug: "project-b" }),
				).toMatchObject({ current: "project-b" });
				expect(resolve.mock.calls.map(([slug]) => slug)).toEqual([
					"project-a",
					"project-b",
					"missing",
					"project-b",
				]);
			}),
	);

	it.effect("keeps its transport open until the owning scope closes", () =>
		Effect.gen(function* () {
			const close = vi.spyOn(WebSocketServer.prototype, "close");
			yield* Effect.addFinalizer(() => Effect.sync(() => close.mockRestore()));
			const scope = yield* Scope.make();
			yield* makeRoutedWsRpcWebSocketHandler(() =>
				Effect.fail(new WsRpcError({ message: "unused" })),
			).pipe(Effect.provide(sessionDirectory), Scope.provide(scope));
			expect(close).not.toHaveBeenCalled();
			yield* Scope.close(scope, Exit.void);
			expect(close).toHaveBeenCalledTimes(1);
		}),
	);
});

import { Headers } from "effect/http";
