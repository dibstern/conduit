import { RpcTest } from "@effect/rpc";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { restoreSessionPermissionModes } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	getPermissionMode,
	makeOverridesStateLive,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
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

	it.effect("restores the switched mode after a fresh overrides layer", () => {
		const wsHandler = makeMockWebSocketHandler();
		const claudeInstance = new ClaudeProviderInstance({
			workspaceRoot: "/tmp/ws",
		});
		vi.spyOn(claudeInstance, "setPermissionModeEffect").mockReturnValue(
			Effect.void,
		);
		const providerRegistry = new ProviderRegistry([claudeInstance]);
		const sessionId = "session-restart";

		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES (${sessionId}, 'claude', 'Restart session', 'idle', 1000, 1000)`;

			const client = yield* RpcTest.makeClient(WsRpcGroup);
			yield* client.SwitchPermissionMode({
				projectSlug: "project-a",
				sessionId,
				mode: "auto",
				originId: "browser-1",
			});

			const restoredMode = yield* Effect.gen(function* () {
				expect(yield* getPermissionMode(sessionId)).toBe("ask");
				yield* restoreSessionPermissionModes();
				return yield* getPermissionMode(sessionId);
			}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive())));

			expect(restoredMode).toBe("auto");
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
					Layer.provideMerge(makePersistenceEffectLayer(":memory:")),
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
			const sessionId = "session-1";

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions (
						id, provider, title, status, permission_mode, created_at, updated_at
					)
					VALUES (
						${sessionId}, 'claude', 'Rejected switch', 'idle', 'ask', 1000, 1000
					)`;

				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* Effect.either(
					client.SwitchPermissionMode({
						projectSlug: "project-a",
						sessionId,
						mode: "full",
						originId: "browser-1",
					}),
				);

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left.message).toContain("SDK rejected permission mode");
				}
				expect(yield* getPermissionMode(sessionId)).toBe("ask");
				const rows = yield* sql<{ readonly permission_mode: string | null }>`
					SELECT permission_mode FROM sessions WHERE id = ${sessionId}`;
				expect(rows).toHaveLength(1);
				expect(rows[0]?.permission_mode).toBe("ask");
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
						Layer.provideMerge(makePersistenceEffectLayer(":memory:")),
					),
				),
			);
		},
	);
});
