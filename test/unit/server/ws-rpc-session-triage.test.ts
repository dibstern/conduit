import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockSessionManagerService,
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("session triage RPCs", () => {
	it.scoped(
		"routes both setters by projectSlug and broadcasts refreshed lists",
		() =>
			Effect.gen(function* () {
				const { wsHandler, calls } = makeRecordingWebSocketHandler();
				const service = makeMockSessionManagerService({
					setSessionSettled: vi.fn(() => Effect.succeed(true)),
					setSessionPinned: vi.fn(() => Effect.succeed(true)),
					sendSessionLists: vi.fn((send) =>
						Effect.sync(() =>
							send({ type: "session_list", sessions: [], roots: true }),
						),
					),
				});
				const context = yield* Layer.build(
					makeTestHandlerLayer({ wsHandler, sessionManagerService: service }),
				);
				const resolve = vi.fn((_slug: string) => Effect.succeed(context));
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(makeRoutedWsRpcServerLayer(resolve)),
				);
				for (const value of [true, false]) {
					expect(
						yield* client.SetSessionSettled({
							projectSlug: "project-b",
							sessionId: "s1",
							settled: value,
							originId: "browser",
						}),
					).toEqual({ ok: true });
					expect(
						yield* client.SetSessionPinned({
							projectSlug: "project-b",
							sessionId: "s1",
							pinned: value,
						}),
					).toEqual({ ok: true });
					expect(service.setSessionSettled).toHaveBeenCalledWith("s1", value);
					expect(service.setSessionPinned).toHaveBeenCalledWith("s1", value);
				}
				expect(resolve).toHaveBeenCalledTimes(4);
				expect(resolve.mock.calls.every(([slug]) => slug === "project-b")).toBe(
					true,
				);
				expect(calls.map((call) => call.message)).toEqual(
					Array.from({ length: 4 }, () => ({
						type: "session_list",
						sessions: [],
						roots: true,
					})),
				);
			}),
	);

	it.scoped(
		"returns a WsRpcError explaining the pin guard without broadcasting",
		() =>
			Effect.gen(function* () {
				const { wsHandler, calls } = makeRecordingWebSocketHandler();
				const service = makeMockSessionManagerService({
					setSessionSettled: () =>
						Effect.fail(
							new SessionManagerError({
								operation: "setSessionSettled",
								cause: new Error(
									"Session is pinned and must be unpinned first",
								),
							}),
						),
				});
				const context = yield* Layer.build(
					makeTestHandlerLayer({ wsHandler, sessionManagerService: service }),
				);
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(() => Effect.succeed(context)),
					),
				);
				const result = yield* Effect.either(
					client.SetSessionSettled({
						projectSlug: "project-a",
						sessionId: "s1",
						settled: true,
					}),
				);
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left).toMatchObject({
						_tag: "WsRpcError",
						message: expect.stringMatching(/pinned.*unpinned first/),
					});
				expect(calls).toEqual([]);
				expect(service.sendSessionLists).not.toHaveBeenCalled();
			}),
	);

	it.scoped("succeeds without broadcasting for idempotent requests", () =>
		Effect.gen(function* () {
			const service = makeMockSessionManagerService();
			const context = yield* Layer.build(
				makeTestHandlerLayer({ sessionManagerService: service }),
			);
			const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
				Effect.provide(
					makeRoutedWsRpcServerLayer(() => Effect.succeed(context)),
				),
			);
			expect(
				yield* client.SetSessionSettled({
					projectSlug: "a",
					sessionId: "s",
					settled: true,
				}),
			).toEqual({ ok: true });
			expect(
				yield* client.SetSessionPinned({
					projectSlug: "a",
					sessionId: "s",
					pinned: false,
				}),
			).toEqual({ ok: true });
			expect(service.sendSessionLists).not.toHaveBeenCalled();
		}),
	);
});
