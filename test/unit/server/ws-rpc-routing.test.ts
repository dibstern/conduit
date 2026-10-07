import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import {
	type Context,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Scope,
	Stream,
} from "effect";
import { expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { makeWsTransportLive } from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";
import { BackgroundLivenessTag } from "../../../src/lib/domain/relay/Services/services.js";
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
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("routed RPC server", () => {
	it.scoped("keeps two project shell streams on their own read models", () =>
		Effect.gen(function* () {
			const contexts = new Map<string, Context.Context<unknown>>();
			for (const slug of ["project-a", "project-b"]) {
				const bus = makeSessionEventBusLive();
				const context = yield* Layer.build(
					Layer.mergeAll(
						RpcSubscriptionScopeLive,
						bus,
						makePersistenceEffectLayer(":memory:", undefined, bus),
						Layer.succeed(BackgroundLivenessTag, () => undefined),
					),
				);
				contexts.set(slug, context as Context.Context<unknown>);
				yield* Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.recover();
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent(
							"session.created",
							slug,
							{
								sessionId: slug,
								title: slug,
								provider: "claude",
							},
							{ provider: "claude", createdAt: 1 },
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
					}),
				),
			);
			for (const slug of ["project-a", "project-b"]) {
				const envelopes = yield* client
					.SubscribeShell({ projectSlug: slug })
					.pipe(Stream.take(2), Stream.runCollect);
				expect(Array.from(envelopes)).toMatchObject([
					{ _tag: "snapshot", rows: [{ id: slug }] },
					{ _tag: "synchronized" },
				]);
			}
		}),
	);

	it.scoped(
		"serves a named project's approvals, a subagent's included, and no other project's",
		() =>
			Effect.gen(function* () {
				const contexts = new Map<string, Context.Context<unknown>>();
				for (const slug of ["project-a", "project-b"]) {
					const bus = makeSessionEventBusLive();
					const context = yield* Layer.build(
						Layer.mergeAll(
							RpcSubscriptionScopeLive,
							bus,
							makePersistenceEffectLayer(":memory:", undefined, bus),
							Layer.succeed(BackgroundLivenessTag, () => undefined),
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
						}),
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

	it.scoped(
		"AttachProject replies with the daemon's resolved project without resolving a relay context",
		() =>
			Effect.gen(function* () {
				const resolve = vi.fn(() =>
					Effect.fail(new WsRpcError({ message: "unexpected relay context" })),
				);
				const attachProject = vi.fn(() =>
					Effect.succeed({ projectSlug: "project-c" }),
				);
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(
							resolve,
							undefined,
							undefined,
							undefined,
							attachProject,
						),
					),
				);
				expect(
					yield* client.AttachProject({
						projectSlug: "project-b",
						originId: "daemon-client",
					}),
				).toEqual({ projectSlug: "project-c" });
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

	it.scoped(
		"AttachProject on a standalone relay replies with its own project",
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(
					makeTestHandlerLayer({
						config: makeMockConfig({ slug: "initial", getProjects: () => [] }),
					}).pipe(Layer.provideMerge(RpcSubscriptionScopeLive)),
				);
				const resolve = vi.fn(() => Effect.succeed(context));
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, "initial"),
					),
				);
				expect(
					yield* client.AttachProject({ originId: "relay-client" }),
				).toEqual({ projectSlug: "initial" });
				expect(resolve).toHaveBeenCalledWith("initial");
			}),
	);

	it.scoped(
		"lets daemon ViewSession reattachment bypass the relay handler",
		() =>
			Effect.gen(function* () {
				const resolve = vi.fn(() =>
					Effect.fail(
						new WsRpcError({ message: "must not resolve relay context" }),
					),
				);
				const reattach = vi.fn(() => Effect.succeed(true));
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, undefined, reattach),
					),
				);

				expect(
					yield* client.ViewSession({
						projectSlug: "project-b",
						sessionId: "session-b",
						originId: "daemon-client",
					}),
				).toEqual({ ok: true, draft: "" });
				expect(reattach).toHaveBeenCalledWith(
					expect.objectContaining({
						projectSlug: "project-b",
						sessionId: "session-b",
						originId: "daemon-client",
					}),
				);
				expect(resolve).not.toHaveBeenCalled();
			}),
	);

	it.scoped(
		"routes ViewSession normally when daemon reattachment declines",
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(
					makeTestHandlerLayer().pipe(
						Layer.provideMerge(RpcSubscriptionScopeLive),
					),
				);
				const resolve = vi.fn(() => Effect.succeed(context));
				const reattach = vi.fn(() => Effect.succeed(false));
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, undefined, reattach),
					),
				);

				expect(
					yield* client.ViewSession({
						projectSlug: "project-a",
						sessionId: "session-a",
						originId: "relay-client",
					}),
				).toEqual({ ok: true, draft: "" });
				expect(reattach).toHaveBeenCalledTimes(1);
				expect(resolve).toHaveBeenCalledWith("project-a");
			}),
	);

	it.scoped(
		"uses the initial standalone relay when a daemon request omits projectSlug",
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(
					makeTestHandlerLayer({
						config: makeMockConfig({ slug: "initial", getProjects: () => [] }),
					}).pipe(Layer.provideMerge(RpcSubscriptionScopeLive)),
				);
				const resolve = vi.fn(() => Effect.succeed(context));
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, "initial"),
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

	it.scoped("does not return a disposed relay's context", () =>
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
				Effect.provide(runtime),
			);
			if (!handler.context) throw new Error("Missing relay context");
			expect((yield* Effect.exit(handler.context))._tag).toBe("Success");
			yield* runtime.disposeEffect;
			expect((yield* Effect.exit(handler.context))._tag).toBe("Failure");
		}),
	);

	it.scoped(
		"uses each project's services and keeps serving after a routing error",
		() =>
			Effect.gen(function* () {
				const contexts = new Map<string, Context.Context<unknown>>();
				for (const slug of ["project-a", "project-b"]) {
					contexts.set(
						slug,
						yield* Layer.build(
							makeTestHandlerLayer({
								config: makeMockConfig({
									slug,
									getProjects: () => [
										{ slug, title: slug, folders: [`/tmp/${slug}`] as const },
									],
								}),
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
					Effect.provide(makeRoutedWsRpcServerLayer(resolve)),
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
				const missing = yield* Effect.either(
					client.GetProjects({ projectSlug: "missing" }),
				);
				expect(missing._tag).toBe("Left");
				if (missing._tag === "Left") {
					expect(missing.left).toBeInstanceOf(WsRpcError);
					expect(missing.left.message).toContain("missing");
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

	it.scoped("keeps its transport open until the owning scope closes", () =>
		Effect.gen(function* () {
			const close = vi.spyOn(WebSocketServer.prototype, "close");
			yield* Effect.addFinalizer(() => Effect.sync(() => close.mockRestore()));
			const scope = yield* Scope.make();
			yield* makeRoutedWsRpcWebSocketHandler(() =>
				Effect.fail(new WsRpcError({ message: "unused" })),
			).pipe(Scope.extend(scope));
			expect(close).not.toHaveBeenCalled();
			yield* Scope.close(scope, Exit.void);
			expect(close).toHaveBeenCalledTimes(1);
		}),
	);
});
