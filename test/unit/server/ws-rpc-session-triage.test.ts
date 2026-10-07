import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockSessionManagerService,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("session triage RPCs", () => {
	it.scoped("routes the triage setters by projectSlug", () =>
		Effect.gen(function* () {
			const service = makeMockSessionManagerService({
				setSessionSettled: vi.fn(() => Effect.succeed(true)),
				setSessionPinned: vi.fn(() => Effect.succeed(true)),
				snoozeSession: vi.fn(() => Effect.succeed(true)),
				unsnoozeSession: vi.fn(() => Effect.succeed(true)),
			});
			const context = yield* Layer.build(
				makeTestHandlerLayer({ sessionManagerService: service }),
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
				expect(service.setSessionSettled).toHaveBeenCalledWith("s1", {
					settled: value,
				});
				expect(service.setSessionPinned).toHaveBeenCalledWith("s1", value);
			}
			expect(
				yield* client.SnoozeSession({
					projectSlug: "project-b",
					sessionId: "s1",
					until: null,
				}),
			).toEqual({ ok: true });
			expect(
				yield* client.UnsnoozeSession({
					projectSlug: "project-b",
					sessionId: "s1",
				}),
			).toEqual({ ok: true });
			expect(service.snoozeSession).toHaveBeenCalledWith("s1", null);
			expect(service.unsnoozeSession).toHaveBeenCalledWith("s1");
			expect(resolve).toHaveBeenCalledTimes(6);
			expect(resolve.mock.calls.every(([slug]) => slug === "project-b")).toBe(
				true,
			);
			expect(service.setSessionSettled).toHaveBeenCalledTimes(2);
		}),
	);

	it.scoped("returns a WsRpcError explaining the pin guard", () =>
		Effect.gen(function* () {
			const service = makeMockSessionManagerService({
				setSessionSettled: () =>
					Effect.fail(
						new SessionManagerError({
							operation: "setSessionSettled",
							cause: new Error("Session is pinned and must be unpinned first"),
						}),
					),
			});
			const context = yield* Layer.build(
				makeTestHandlerLayer({ sessionManagerService: service }),
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
		}),
	);

	it.scoped("succeeds for idempotent requests", () =>
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
			expect(
				yield* client.SnoozeSession({
					projectSlug: "a",
					sessionId: "s",
					until: null,
				}),
			).toEqual({ ok: true });
			expect(
				yield* client.UnsnoozeSession({ projectSlug: "a", sessionId: "s" }),
			).toEqual({ ok: true });
		}),
	);

	for (const [reason, message] of [
		["pinned", "Unpin the session first"],
		["settled", "Un-settle the session first"],
		["permission", "Session is waiting on you"],
		["question", "Session is waiting on you"],
		["past", "Snooze time must be in the future"],
	] as const) {
		it.scoped(`maps ${reason} refusal to WsRpcError`, () =>
			Effect.gen(function* () {
				const service = makeMockSessionManagerService({
					snoozeSession: () =>
						Effect.fail(
							new SessionManagerError({
								operation: "snoozeSession",
								cause: new Error(message),
							}),
						),
				});
				const context = yield* Layer.build(
					makeTestHandlerLayer({ sessionManagerService: service }),
				);
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(() => Effect.succeed(context)),
					),
				);
				const result = yield* Effect.either(
					client.SnoozeSession({
						projectSlug: "project-a",
						sessionId: "s1",
						until: null,
					}),
				);
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left).toMatchObject({
						_tag: "WsRpcError",
						message: expect.stringContaining(message),
					});
			}),
		);
	}
});
