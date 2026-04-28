// ─── Effect Frontend Runtime ────────────────────────────────────────────────
// Long-lived ManagedRuntime singleton for the frontend. Individual WebSocket
// connections are managed as fibers within the runtime. On reconnect, only
// the stream fiber is interrupted — the runtime and its service graph persist.
//
// Lazy-loaded — not in the critical rendering path.

import {
	Chunk,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	Option,
	Stream,
} from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { RelayMessage } from "../../shared-types.js";
import { decodeMessage, preloadDecoder } from "../effect-boundary.js";

// Frontend transport has no async service dependencies.
// ManagedRuntime is needed for fiber lifecycle (interrupt stream on reconnect).
// Extend if async services (logging, metrics) are added later.
const TransportLayer = Layer.empty;

let runtime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeStreamFiber: RuntimeFiber<void, unknown> | null = null;

void preloadDecoder();

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

/**
 * Create a Stream from an existing WebSocket's message events.
 * Does NOT manage connection lifecycle — ws.svelte.ts owns that.
 * Stream ends when WebSocket closes. Caller handles reconnect.
 */
export const wsMessageStream = (
	ws: WebSocket,
): Stream.Stream<RelayMessage, Error> =>
	Stream.async<RelayMessage, Error>((emit) => {
		const onMessage = (evt: MessageEvent) => {
			try {
				const raw = JSON.parse(evt.data);
				const parsed = decodeMessage(raw) as RelayMessage;
				emit(Effect.succeed(Chunk.of(parsed)));
			} catch {
				// Bad JSON — skip message, don't kill stream
			}
		};
		const onClose = () => emit(Effect.fail(Option.none()));
		const onError = () =>
			emit(Effect.fail(Option.some(new Error("WebSocket error"))));

		ws.addEventListener("message", onMessage);
		ws.addEventListener("close", onClose);
		ws.addEventListener("error", onError);

		return Effect.sync(() => {
			ws.removeEventListener("message", onMessage);
			ws.removeEventListener("close", onClose);
			ws.removeEventListener("error", onError);
		});
	});

/** Dispose the entire runtime (page unload only). */
export async function disposeRuntime() {
	await interruptStream();
	if (runtime) {
		await runtime.dispose();
		runtime = null;
	}
}
