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
import {
	decodeMessage,
	ProtocolDecodeError,
	preloadDecoder,
} from "../effect-boundary.js";

// Frontend transport has no async service dependencies.
// ManagedRuntime is needed for fiber lifecycle (interrupt stream on reconnect).
// Extend if async services (logging, metrics) are added later.
const TransportLayer = Layer.empty;

let runtime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeStreamFiber: RuntimeFiber<void, unknown> | null = null;

void preloadDecoder();

export class TransportSocketError extends Error {
	readonly _tag = "TransportSocketError";

	constructor(message: string) {
		super(message);
		this.name = "TransportSocketError";
	}
}

/** Get or create the long-lived runtime (app lifetime). */
export async function getRuntime() {
	if (!runtime) {
		runtime = ManagedRuntime.make(TransportLayer);
	}
	return runtime;
}

/** Run transport-owned effects through the app-lifetime frontend runtime. */
export async function runTransportEffect<A, E>(
	effect: Effect.Effect<A, E, never>,
): Promise<A> {
	const rt = await getRuntime();
	return await rt.runPromise(effect);
}

/** Interrupt the active stream fiber (connection lifetime). Called on disconnect/reconnect. */
export async function interruptStream() {
	if (activeStreamFiber) {
		const fiber = activeStreamFiber;
		await runTransportEffect(Fiber.interrupt(fiber));
		if (activeStreamFiber === fiber) {
			activeStreamFiber = null;
		}
	}
}

/** Whether a WebSocket stream fiber is currently registered. */
export function hasActiveStreamFiber(): boolean {
	return activeStreamFiber !== null;
}

/** Set the active stream fiber (called after forking a new WS stream). */
export function setActiveStreamFiber(fiber: RuntimeFiber<void, unknown>) {
	activeStreamFiber = fiber;
	fiber.addObserver(() => {
		if (activeStreamFiber === fiber) {
			activeStreamFiber = null;
		}
	});
}

export interface WsProtocolError {
	kind: "invalid_json" | "invalid_message";
	detail: string;
	data?: string;
	raw?: unknown;
	messageType?: string;
	cause?: unknown;
}

export interface WsMessageStreamOptions {
	onProtocolError?: (error: WsProtocolError) => void;
}

/**
 * Create a Stream from an existing WebSocket's message events.
 * Does NOT manage connection lifecycle — ws.svelte.ts owns that.
 * Stream ends when WebSocket closes. Caller handles reconnect.
 */
export const wsMessageStream = (
	ws: WebSocket,
	options: WsMessageStreamOptions = {},
): Stream.Stream<RelayMessage, TransportSocketError> =>
	Stream.async<RelayMessage, TransportSocketError>((emit) => {
		const onMessage = (evt: MessageEvent) => {
			let raw: unknown;
			try {
				raw = JSON.parse(evt.data);
				const parsed = decodeMessage(raw) as RelayMessage;
				emit(Effect.succeed(Chunk.of(parsed)));
			} catch (err) {
				if (err instanceof SyntaxError) {
					options.onProtocolError?.({
						kind: "invalid_json",
						detail: "Invalid WebSocket JSON payload",
						...(typeof evt.data === "string" ? { data: evt.data } : {}),
						cause: err,
					});
					return;
				}
				if (err instanceof ProtocolDecodeError) {
					options.onProtocolError?.({
						kind: "invalid_message",
						detail: err.message,
						raw: err.raw,
						messageType: err.messageType,
						cause: err.cause,
					});
					return;
				}
				options.onProtocolError?.({
					kind: "invalid_message",
					detail: "Failed to decode WebSocket payload",
					raw,
					cause: err,
				});
			}
		};
		const onClose = () => emit(Effect.fail(Option.none()));
		const onError = () =>
			emit(
				Effect.fail(Option.some(new TransportSocketError("WebSocket error"))),
			);

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
