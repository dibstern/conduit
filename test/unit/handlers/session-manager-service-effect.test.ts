import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WebSocketHandlerTag } from "../../../src/lib/effect/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/effect/session-manager-service.js";
import { handleListSessions } from "../../../src/lib/handlers/session.js";
import {
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

describe("session handlers with Effect-native session manager service", () => {
	it.effect("lists sessions through the session manager service", () => {
		const wsHandler = makeMockWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			sendDualSessionLists: vi.fn((send) =>
				Effect.sync(() => {
					send({
						type: "session_list",
						sessions: [
							{
								id: "session-1",
								title: "Session 1",
								updatedAt: 100,
								messageCount: 2,
							},
						],
						roots: true,
					});
				}),
			),
		});

		const layer = Layer.mergeAll(
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(WebSocketHandlerTag, wsHandler),
		);

		return handleListSessions("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(
					sessionManagerService.sendDualSessionLists,
				).toHaveBeenCalledOnce();
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "session_list",
					sessions: [
						{
							id: "session-1",
							title: "Session 1",
							updatedAt: 100,
							messageCount: 2,
						},
					],
					roots: true,
				});
			}),
		);
	});
});
