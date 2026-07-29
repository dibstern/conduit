import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { getPermissionMode } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { ClaudeProviderInstance } from "../../../src/lib/provider/claude/claude-provider-instance.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockLogger,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer SwitchPermissionMode", () => {
	it.effect("sets, broadcasts, and hydrates the permission mode", () => {
		const wsHandler = makeMockWebSocketHandler();
		const claudeInstance = new ClaudeProviderInstance({
			workspaceRoot: "/tmp/ws",
		});
		const setSdkPermissionMode = vi
			.spyOn(claudeInstance, "setPermissionModeEffect")
			.mockReturnValue(Effect.void);
		const providerRegistry = new ProviderRegistry([claudeInstance]);

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.SwitchPermissionMode({
				projectSlug: "project-a",
				sessionId: "session-1",
				mode: "full",
				originId: "browser-1",
			});

			expect(result).toEqual({ projectSlug: "project-a", mode: "full" });
			expect(yield* getPermissionMode("session-1")).toBe("full");
			expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
				type: "permission_mode_info",
				mode: "full",
			});

			const models = yield* client.GetModels({
				projectSlug: "project-a",
				sessionId: "session-1",
			});
			expect(models.permissionMode).toBe("full");
			expect(setSdkPermissionMode).toHaveBeenCalledWith("session-1", "full");

			yield* client.SwitchPermissionMode({
				projectSlug: "project-a",
				sessionId: "session-1",
				mode: "auto",
				originId: "browser-1",
			});
			expect(setSdkPermissionMode).toHaveBeenLastCalledWith(
				"session-1",
				"auto",
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							wsHandler,
							log: makeMockLogger(),
						}),
					),
					Layer.provideMerge(Layer.succeed(LoggerTag, makeMockLogger())),
					Layer.provideMerge(
						Layer.succeed(ProviderRegistryTag, providerRegistry),
					),
				),
			),
		);
	});

	it.effect(
		"leaves the stored mode unchanged when the live query rejects the update",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const claudeInstance = new ClaudeProviderInstance({
				workspaceRoot: "/tmp/ws",
			});
			vi.spyOn(claudeInstance, "setPermissionModeEffect").mockReturnValue(
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "claude",
						operation: "set permission mode",
						cause: new Error("SDK rejected permission mode"),
					}),
				),
			);
			const providerRegistry = new ProviderRegistry([claudeInstance]);

			return Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* Effect.either(
					client.SwitchPermissionMode({
						projectSlug: "project-a",
						sessionId: "session-1",
						mode: "full",
						originId: "browser-1",
					}),
				);

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left.message).toContain("SDK rejected permission mode");
				}
				expect(yield* getPermissionMode("session-1")).toBe("ask");
				expect(wsHandler.sendToSession).not.toHaveBeenCalled();
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								wsHandler,
								log: makeMockLogger(),
							}),
						),
						Layer.provideMerge(Layer.succeed(LoggerTag, makeMockLogger())),
						Layer.provideMerge(
							Layer.succeed(ProviderRegistryTag, providerRegistry),
						),
					),
				),
			);
		},
	);
});
