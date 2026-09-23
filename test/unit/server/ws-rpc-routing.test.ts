import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import {
	type Context,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Scope,
} from "effect";
import { expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { makeWsTransportLive } from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeRoutedWsRpcWebSocketHandler,
	makeWsRpcWebSocketHandler,
} from "../../../src/lib/server/ws-rpc-handler.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("routed RPC server", () => {
	it.scoped.each([true, false])(
		"AttachProject returns ok without resolving a relay context when reattached=%s",
		(reattached) =>
			Effect.gen(function* () {
				const resolve = vi.fn(() =>
					Effect.fail(new WsRpcError({ message: "unexpected relay context" })),
				);
				const reattach = vi.fn(() => Effect.succeed(reattached));
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, undefined, reattach),
					),
				);
				expect(
					yield* client.AttachProject({
						projectSlug: "project-b",
						originId: "daemon-client",
					}),
				).toEqual({ ok: true });
				expect(reattach).toHaveBeenCalledWith(
					expect.objectContaining({
						projectSlug: "project-b",
						originId: "daemon-client",
					}),
				);
				expect(resolve).not.toHaveBeenCalled();
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
				).toEqual({ ok: true });
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
				const context = yield* Layer.build(makeTestHandlerLayer());
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
				).toEqual({ ok: true });
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
					}),
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
										{ slug, title: slug, directory: `/tmp/${slug}` },
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
