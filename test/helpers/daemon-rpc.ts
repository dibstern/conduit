import { Effect, Layer } from "effect";
import { DaemonWsRpcHandlersLive } from "../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { PortScannerTag } from "../../src/lib/domain/daemon/Layers/port-scanner-layer.js";
import { ConfigPersistenceNoopLive } from "../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeInstanceManagerStateLive } from "../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { makeProjectRegistryLive } from "../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	makeRelayCacheLive,
	type RelayFactory,
} from "../../src/lib/domain/daemon/Services/relay-cache.js";
import type { StoredProject } from "../../src/lib/types.js";

export const makeDaemonRpcTestLayer = (
	projects: ReadonlyArray<StoredProject> = [],
	factory: RelayFactory = () => Effect.die("Unexpected relay startup"),
) =>
	DaemonWsRpcHandlersLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				makeProjectRegistryLive(projects),
				makeRelayCacheLive(factory),
				DaemonEventBusLive,
				ConfigPersistenceNoopLive,
				DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 0 })),
				makeInstanceManagerStateLive(),
				Layer.succeed(PortScannerTag, {
					getKnownPorts: () => Effect.succeed(new Set<number>()),
					scanNow: () =>
						Effect.succeed({ discovered: [], lost: [], active: [] }),
				}),
			),
		),
	);
