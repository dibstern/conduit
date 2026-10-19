// Long-lived ManagedRuntime singleton for the frontend. The RPC socket pair
// and its readers share the runtime's scope and reconnect within it.
//
// Lazy-loaded — not in the critical rendering path.

import { type Effect, Layer, ManagedRuntime, Scheduler } from "effect";
import { type WsRpcClients, WsRpcClientsLayer } from "./shared-client.js";

// Browsers have no setImmediate, so Effect 4 dispatches every fiber hop with
// setTimeout(0): hidden tabs throttle that to a second or more, and a paused
// test clock freezes it. A MessageChannel task is neither clamped nor faked.
const setImmediate = (task: () => void): (() => void) => {
	const { port1, port2 } = new MessageChannel();
	port1.onmessage = () => {
		port1.close();
		task();
	};
	port2.postMessage(undefined);
	return () => port1.close();
};

// The shared two-socket RPC client is the only transport-owned service. Its
// scope is the runtime's scope, so disposing the runtime closes both sockets.
// The scheduler is provided to it as well, so its long-lived readers use it.
const TransportLayer = WsRpcClientsLayer.pipe(
	Layer.provideMerge(
		Layer.succeed(
			Scheduler.Scheduler,
			new Scheduler.MixedScheduler("async", setImmediate),
		),
	),
);

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
