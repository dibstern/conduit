import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	LoggerTag,
	OpenCodeAPITag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/effect/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
} from "../../../src/lib/effect/session-overrides-state.js";
import {
	handleAskUserResponse,
	handleQuestionReject,
} from "../../../src/lib/handlers/permissions.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeMockSessionManagerService } from "../../helpers/mock-factories.js";

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

describe("permission/question processing timeouts through Effect state", () => {
	it.effect(
		"restarts the processing timeout after answering a question",
		() => {
			const client = {
				question: { reply: vi.fn(async () => undefined) },
			} as unknown as OpenCodeAPI;
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, makeWsHandler()),
				Layer.succeed(LoggerTag, createSilentLogger()),
				Layer.succeed(
					SessionManagerServiceTag,
					makeMockSessionManagerService(),
				),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* handleAskUserResponse("client-1", {
					toolId: "que-1",
					answers: { "0": "Yes" },
				});

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"restarts the processing timeout after rejecting a question",
		() => {
			const client = {
				question: { reject: vi.fn(async () => undefined) },
			} as unknown as OpenCodeAPI;
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, makeWsHandler()),
				Layer.succeed(LoggerTag, createSilentLogger()),
				Layer.succeed(
					SessionManagerServiceTag,
					makeMockSessionManagerService(),
				),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* handleQuestionReject("client-1", { toolId: "que-1" });

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
			}).pipe(Effect.provide(layer));
		},
	);
});
