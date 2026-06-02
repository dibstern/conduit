import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { setDefaultAgent } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import {
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("agent selection state", () => {
	it.effect("uses the switched agent when sending the next prompt", () => {
		const api = makeMockOpenCodeAPI();
		vi.mocked(api.session.prompt).mockResolvedValue(undefined);
		const ws = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => []),
		});
		const sessionManagerService = makeMockSessionManagerService({
			recordMessageActivity: vi.fn(() => Effect.void),
		});

		return Effect.gen(function* () {
			const agentService = yield* AgentServiceTag;
			yield* agentService.switchAgent({
				clientId: "client-1",
				sessionId: "session-1",
				agentId: "plan",
			});
			yield* handleMessage("client-1", {
				text: "implement this",
				commandId: "cmd-agent-prompt-1",
			});

			expect(api.session.prompt).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({ agent: "plan" }),
			);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					makeTestHandlerLayer({
						api,
						wsHandler: ws,
						sessionManagerService,
					}),
				),
			),
		);
	});

	it.effect("uses the default agent when no session override exists", () => {
		const api = makeMockOpenCodeAPI();
		vi.mocked(api.session.prompt).mockResolvedValue(undefined);
		const ws = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => []),
		});
		const sessionManagerService = makeMockSessionManagerService({
			recordMessageActivity: vi.fn(() => Effect.void),
		});

		return Effect.gen(function* () {
			yield* setDefaultAgent("plan");
			yield* handleMessage("client-1", {
				text: "implement this",
				commandId: "cmd-agent-prompt-2",
			});

			expect(api.session.prompt).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({ agent: "plan" }),
			);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					makeTestHandlerLayer({
						api,
						wsHandler: ws,
						sessionManagerService,
					}),
				),
			),
		);
	});
});
