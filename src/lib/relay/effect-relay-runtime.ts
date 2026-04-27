// ─── Effect Relay Runtime ───────────────────────────────────────────────────
// ManagedRuntime bridge that wraps existing imperative service instances in an
// Effect Layer and provides a runtime for running Effect handlers.
//
// This is the bridge between the imperative world (relay-stack.ts creates
// services) and the Effect world (handlers use Tags). The runtime lives for
// the relay's lifetime.
//
// Created ALONGSIDE relay-stack.ts — does NOT modify existing wiring.

import { type Effect, ManagedRuntime } from "effect";
import { type HandlerLayerDeps, makeHandlerLayer } from "../effect/layers.js";
import { dispatchMessageEffect } from "../handlers/index.js";

/**
 * Creates a ManagedRuntime for the relay stack.
 *
 * Wraps existing imperative service instances in an Effect Layer
 * and provides a runtime for running Effect handlers.
 *
 * @param deps - Already-constructed service instances (from relay-stack.ts)
 * @returns An object with the runtime, a dispatch helper, and a dispose method
 */
export function createRelayRuntime(deps: HandlerLayerDeps) {
	const handlerLayer = makeHandlerLayer(deps);
	const runtime = ManagedRuntime.make(handlerLayer);

	return {
		/** The underlying ManagedRuntime instance. */
		runtime,

		/** Run a synchronous Effect program with the handler layer context. */
		// biome-ignore lint/suspicious/noExplicitAny: ManagedRuntime provides all Tags — callers pass effects with various R types
		runSync: <A, E>(effect: Effect.Effect<A, E, any>) =>
			runtime.runSync(effect),

		/** Dispatch a message through the Effect handler pipeline. */
		dispatch: (clientId: string, type: string, raw: unknown) =>
			runtime.runPromise(dispatchMessageEffect(clientId, type, raw)),

		/** Dispose the runtime (call on relay shutdown). */
		dispose: () => runtime.dispose(),
	};
}

/** Return type of createRelayRuntime for external use. */
export type RelayRuntime = ReturnType<typeof createRelayRuntime>;
