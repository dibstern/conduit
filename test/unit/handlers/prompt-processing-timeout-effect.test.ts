import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { ProviderTurnServiceLive } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	cancelSessionById,
	handleMessage,
} from "../../../src/lib/handlers/prompt.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { makeMockSessionManagerService } from "../../helpers/mock-factories.js";

const config = {
	opencodeUrl: "http://127.0.0.1:1",
	projectDir: "/tmp/conduit-timeout-test",
	slug: "timeout-test",
	noServer: true,
} satisfies Partial<ProjectRelayConfig>;

function makeWsHandler() {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => "session-1"),
		getClientsForSession: vi.fn(() => ["client-1"]),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 1),
		getClientIds: vi.fn(() => ["client-1"]),
		handleUpgrade: vi.fn(),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
	};
}

describe("prompt processing timeouts through Effect state", () => {
	it.effect("starts a processing timeout when a prompt is sent", () => {
		const ws = makeWsHandler();
		const client = {
			session: { prompt: vi.fn(async () => undefined) },
		} as unknown as OpenCodeAPI;
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, createSilentLogger()),
			Layer.succeed(ConfigTag, config as ProjectRelayConfig),
			Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
			PendingInteractionServiceLive,
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* handleMessage("client-1", {
				text: "hello",
				commandId: "cmd-timeout-send",
			});

			expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"clears the processing timeout when the active prompt is cancelled",
		() => {
			const ws = makeWsHandler();
			const client = {
				session: { abort: vi.fn(async () => undefined) },
			} as unknown as OpenCodeAPI;
			const baseLayer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, createSilentLogger()),
				Layer.succeed(ConfigTag, config as ProjectRelayConfig),
				Layer.succeed(
					SessionManagerServiceTag,
					makeMockSessionManagerService(),
				),
				PendingInteractionServiceLive,
				makeOverridesStateLive(),
			);
			const layer = Layer.provideMerge(ProviderTurnServiceLive, baseLayer);

			return Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* cancelSessionById("client-1", "session-1", "cmd-cancel-test");

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
			}).pipe(Effect.provide(layer));
		},
	);
});
