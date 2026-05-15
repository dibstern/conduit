import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Ref } from "effect";
import { expect } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { RelayStateLive } from "../../../src/lib/domain/relay/Layers/relay-layer.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerStateTag } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { OverridesStateTag } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { SessionRegistryStateTag } from "../../../src/lib/domain/relay/Services/session-registry-state.js";
import { PollerStateTag } from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import { WsHandlerStateTag } from "../../../src/lib/domain/relay/Services/ws-handler-service.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const relayStateTestLayer = RelayStateLive.pipe(
	Layer.provide(
		Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
			Layer.succeed(LoggerTag, makeMockLogger()),
		),
	),
);

describe("Relay stack Layer composition", () => {
	it.scoped("RelayStateLive constructs all Effect-native state services", () =>
		Effect.gen(function* () {
			// Verify all state Tags are accessible through the composed Layer
			const registryRef = yield* SessionRegistryStateTag;
			const registry = yield* Ref.get(registryRef);
			expect(HashMap.size(registry)).toBe(0);

			const sessionRef = yield* SessionManagerStateTag;
			const sessionState = yield* Ref.get(sessionRef);
			expect(HashMap.size(sessionState.cachedParentMap)).toBe(0);

			const overridesRef = yield* OverridesStateTag;
			const overridesState = yield* Ref.get(overridesRef);
			expect(overridesState.sessions.size).toBe(0);

			const wsRef = yield* WsHandlerStateTag;
			const wsState = yield* Ref.get(wsRef);
			expect(HashMap.size(wsState)).toBe(0);

			const pollerRef = yield* PollerStateTag;
			const pollerState = yield* Ref.get(pollerRef);
			expect(Object.keys(pollerState.previousStatuses)).toHaveLength(0);
		}).pipe(Effect.provide(Layer.fresh(relayStateTestLayer))),
	);

	it.scoped("RelayStateLive composes with service dependencies provided", () =>
		Effect.gen(function* () {
			// Just verify construction succeeds — bridge layers not needed
			const ref = yield* SessionRegistryStateTag;
			expect(ref).toBeDefined();
		}).pipe(Effect.provide(Layer.fresh(relayStateTestLayer))),
	);
});
