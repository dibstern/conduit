// Long-lived ManagedRuntime singleton for the frontend. The RPC socket pair
// and its readers share the runtime's scope and reconnect within it.
//
// Lazy-loaded — not in the critical rendering path.

import { type Effect, ManagedRuntime } from "effect";
import { type WsRpcClients, WsRpcClientsLayer } from "./shared-client.js";

// The shared two-socket RPC client is the only transport-owned service. Its
// scope is the runtime's scope, so disposing the runtime closes both sockets.
const TransportLayer = WsRpcClientsLayer;

let runtime: ManagedRuntime.ManagedRuntime<WsRpcClients, never> | null = null;

/** Get or create the long-lived runtime (app lifetime). */
export async function getRuntime() {
	runtime ??= ManagedRuntime.make(TransportLayer);
	return runtime;
}

/** Run transport-owned effects through the app-lifetime frontend runtime. */
export async function runTransportEffect<A, E>(
	effect: Effect.Effect<A, E, WsRpcClients>,
): Promise<A> {
	const rt = await getRuntime();
	return await rt.runPromise(effect);
}

/** Dispose the entire runtime (page unload only). */
export async function disposeRuntime() {
	if (runtime) {
		await runtime.dispose();
		runtime = null;
	}
}
