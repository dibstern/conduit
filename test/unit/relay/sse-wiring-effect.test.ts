import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	type EffectSSEWiringDeps,
	handleSSEEventEffect,
} from "../../../src/lib/relay/sse-wiring.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";

describe("handleSSEEventEffect", () => {
	it("clears processing timeout through Effect state for done messages", async () => {
		const deps = createMockSSEWiringDeps();
		const {
			processingTimeouts: _processingTimeouts,
			pendingInteractions: _pendingInteractions,
			sessionService: _sessionService,
			getSessionParentMap: _getSessionParentMap,
			...effectDeps
		} = deps satisfies EffectSSEWiringDeps;
		const translated: RelayMessage = {
			type: "done",
			sessionId: "session-1",
			code: 0,
		};
		vi.mocked(effectDeps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "session-1" },
		};

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"1 minute",
					() => Effect.void,
				);
				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);

				yield* handleSSEEventEffect(effectDeps, event);

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						PendingInteractionServiceLive,
						makeOverridesStateLive(),
						Layer.succeed(SessionManagerServiceTag, {
							getSessionParentMap: () => Effect.succeed(new Map()),
						} as never),
					),
				),
			),
		);

		expect(
			deps.processingTimeouts.clearProcessingTimeout,
		).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"session-1",
			translated,
		);
	});

	it("records message activity through SessionManagerServiceTag", async () => {
		const deps = createMockSSEWiringDeps();
		const {
			processingTimeouts: _processingTimeouts,
			pendingInteractions: _pendingInteractions,
			sessionService: _sessionService,
			getSessionParentMap: _getSessionParentMap,
			...effectDeps
		} = deps satisfies EffectSSEWiringDeps;
		const recordMessageActivity = vi.fn(() => Effect.void);
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "session-1",
			text: "hello",
		};
		vi.mocked(effectDeps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "session-1" },
		};

		await Effect.runPromise(
			handleSSEEventEffect(effectDeps, event).pipe(
				Effect.provide(
					Layer.mergeAll(
						PendingInteractionServiceLive,
						makeOverridesStateLive(),
						Layer.succeed(SessionManagerServiceTag, {
							recordMessageActivity,
							getSessionParentMap: () => Effect.succeed(new Map()),
						} as never),
					),
				),
			),
		);

		expect(recordMessageActivity).toHaveBeenCalledWith(
			"session-1",
			expect.any(Number),
		);
		expect(deps.sessionService.recordMessageActivity).not.toHaveBeenCalled();
	});
});
