// test/unit/handlers/handlers-reload.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleReloadProviderSession } from "../../../src/lib/handlers/reload.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

function makeMockEngine(): { dispatch: ReturnType<typeof vi.fn> } {
	return {
		dispatch: vi.fn(async () => undefined),
	};
}

describe("handleReloadProviderSession", () => {
	let deps: HandlerDeps;
	let engine: ReturnType<typeof makeMockEngine>;

	beforeEach(() => {
		engine = makeMockEngine();
		deps = createMockHandlerDeps({
			orchestrationEngine: engine as unknown as NonNullable<
				HandlerDeps["orchestrationEngine"]
			>,
		});
		// Make handleGetModels cheap (empty providers list so no claude dispatch path)
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		vi.mocked(deps.client.app.commands).mockResolvedValue([]);
	});

	it("returns NO_SESSION error when no active session", async () => {
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);

		await handleReloadProviderSession(deps, "client-1", {});

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "system_error",
				code: "NO_SESSION",
			}),
		);
		expect(engine.dispatch).not.toHaveBeenCalled();
	});

	it("dispatches end_session for the active session", async () => {
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(
			"active-session",
		);

		await handleReloadProviderSession(deps, "client-1", {});

		expect(engine.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "end_session",
				sessionId: "active-session",
			}),
		);
	});

	it("continues to discovery (and reload ack) even if endSession throws", async () => {
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(
			"active-session",
		);
		engine.dispatch.mockRejectedValueOnce(new Error("adapter blew up"));

		await handleReloadProviderSession(deps, "client-1", {});

		// Models and commands still fetched
		expect(deps.client.provider.list).toHaveBeenCalled();
		expect(deps.client.app.commands).toHaveBeenCalled();

		// Ack still sent
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "provider_session_reloaded",
				sessionId: "active-session",
			}),
		);
	});

	it("sends provider_session_reloaded to the client", async () => {
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-ack");

		await handleReloadProviderSession(deps, "client-1", {});

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "provider_session_reloaded",
				sessionId: "session-ack",
			}),
		);
	});

	it("legacy path (no engine) still runs discovery and acks", async () => {
		const depsNoEngine = createMockHandlerDeps();
		vi.mocked(depsNoEngine.client.provider.list).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		vi.mocked(depsNoEngine.client.app.commands).mockResolvedValue([]);
		vi.mocked(depsNoEngine.wsHandler.getClientSession).mockReturnValue(
			"legacy-session",
		);

		await handleReloadProviderSession(depsNoEngine, "client-1", {});

		expect(depsNoEngine.client.provider.list).toHaveBeenCalled();
		expect(depsNoEngine.client.app.commands).toHaveBeenCalled();
		expect(depsNoEngine.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "provider_session_reloaded",
				sessionId: "legacy-session",
			}),
		);
	});
});
