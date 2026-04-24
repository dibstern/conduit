// ─── Effect Frontend Runtime ────────────────────────────────────────────────
// Long-lived ManagedRuntime singleton for the frontend. Individual WebSocket
// connections are managed as fibers within the runtime. On reconnect, only
// the stream fiber is interrupted — the runtime and its service graph persist.
//
// Lazy-loaded — not in the critical rendering path.

import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import type { RuntimeFiber } from "effect/Fiber";

// Layer is empty for now — will be populated in Task 7.2 when WebSocket
// message handling migrates to Effect Stream.
const TransportLayer = Layer.empty;

let runtime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeStreamFiber: RuntimeFiber<void, unknown> | null = null;

/** Get or create the long-lived runtime (app lifetime). */
export async function getRuntime() {
	if (!runtime) {
		runtime = ManagedRuntime.make(TransportLayer);
	}
	return runtime;
}

/** Interrupt the active stream fiber (connection lifetime). Called on disconnect/reconnect. */
export async function interruptStream() {
	if (activeStreamFiber) {
		const rt = await getRuntime();
		await rt.runPromise(Fiber.interrupt(activeStreamFiber));
		activeStreamFiber = null;
	}
}

/** Set the active stream fiber (called after forking a new WS stream). */
export function setActiveStreamFiber(fiber: RuntimeFiber<void, unknown>) {
	activeStreamFiber = fiber;
}

/** Dispose the entire runtime (page unload only). */
export async function disposeRuntime() {
	await interruptStream();
	if (runtime) {
		await runtime.dispose();
		runtime = null;
	}
}
