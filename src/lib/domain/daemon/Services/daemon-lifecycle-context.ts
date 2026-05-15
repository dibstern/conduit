import { Context, Effect, Layer } from "effect";
import type { DaemonLifecycleContext } from "../../../daemon/daemon-lifecycle.js";

export class DaemonLifecycleContextTag extends Context.Tag(
	"DaemonLifecycleContext",
)<DaemonLifecycleContextTag, DaemonLifecycleContext>() {}

export const makeDaemonLifecycleContext = (
	socketPath: string,
): DaemonLifecycleContext => ({
	httpServer: null,
	upgradeServer: null,
	onboardingServer: null,
	ipcServer: null,
	ipcClients: new Set(),
	clientCount: 0,
	socketPath,
	router: null,
});

export const DaemonLifecycleContextLive = (socketPath: string) =>
	Layer.effect(
		DaemonLifecycleContextTag,
		Effect.sync(() => makeDaemonLifecycleContext(socketPath)),
	);
