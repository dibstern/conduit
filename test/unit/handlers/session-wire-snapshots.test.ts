import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { handleViewSession } from "../../../src/lib/handlers/session.js";
import {
	makeMockOpenCodeAPI,
	makeMockSessionManagerShape,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("ViewSession handler", () => {
	it("does not query OpenCode session models", async () => {
		const wsHandler = makeMockWebSocketHandler();
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "get").mockRejectedValue(
			new Error("ViewSession metadata must not query OpenCode session models"),
		);
		vi.spyOn(api.permission, "list").mockResolvedValue([]);
		vi.spyOn(api.question, "list").mockResolvedValue([]);
		const sessionMgr = makeMockSessionManagerShape({
			loadPreRenderedHistory: vi.fn(async () => ({
				messages: [],
				hasMore: false,
				total: 0,
			})),
		});

		await Effect.runPromise(
			handleViewSession("client-1", { sessionId: "session-1" }).pipe(
				Effect.provide(makeTestHandlerLayer({ api, wsHandler, sessionMgr })),
			),
		);

		expect(api.session.get).not.toHaveBeenCalled();
	});
});
