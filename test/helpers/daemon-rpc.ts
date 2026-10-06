import { Deferred, Effect, Layer, Ref } from "effect";
import { ShutdownSignalTag } from "../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { DaemonWsRpcHandlersLive } from "../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { KeepAwakeTag } from "../../src/lib/domain/daemon/Layers/keep-awake-layer.js";
import { OpenCodeInstancesLive } from "../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import { PortScannerTag } from "../../src/lib/domain/daemon/Layers/port-scanner-layer.js";
import {
	ConfigPersistenceNoopLive,
	type ConfigPersistenceTag,
} from "../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	type DaemonConfigRefTag,
	type DaemonRuntimeConfig,
	makeDaemonConfigFromOptions,
} from "../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonHandleLive } from "../../src/lib/domain/daemon/Services/daemon-handle.js";
import { DaemonLifecycleContextLive } from "../../src/lib/domain/daemon/Services/daemon-lifecycle-context.js";
import { DaemonEventBusLive } from "../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	type DaemonState,
	type DaemonStateTag,
	makeDaemonStateLive,
} from "../../src/lib/domain/daemon/Services/daemon-state.js";
import { DaemonWsClientRegistryLive } from "../../src/lib/domain/daemon/Services/daemon-ws-client-registry.js";
import { InstanceHealthCheckLive } from "../../src/lib/domain/daemon/Services/instance-health-service.js";
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
	options: {
		config?: Partial<DaemonRuntimeConfig>;
		configDir?: string;
		persistence?: Layer.Layer<
			ConfigPersistenceTag,
			never,
			DaemonStateTag | DaemonConfigRefTag
		>;
	} = {},
) => {
	const base = Layer.mergeAll(
		makeProjectRegistryLive(projects),
		makeRelayCacheLive(factory),
		DaemonEventBusLive,
		InstanceHealthCheckLive,
		DaemonWsClientRegistryLive,
		DaemonConfigRefLive({
			...makeDaemonConfigFromOptions({ port: 0 }),
			...options.config,
		}),
		makeDaemonStateLive({
			port: 0,
			configDir: options.configDir ?? "/tmp/daemon-rpc-fixture",
			socketPath: "/tmp/daemon-rpc-fixture/relay.sock",
		} satisfies Partial<DaemonState>),
		DaemonLifecycleContextLive("/tmp/daemon-rpc-fixture/relay.sock"),
		Layer.effect(ShutdownSignalTag, Deferred.make<"restart" | "stop">()),
		Layer.effect(
			KeepAwakeTag,
			Effect.gen(function* () {
				const active = yield* Ref.make(false);
				return {
					activate: () => Ref.set(active, true),
					deactivate: () => Ref.set(active, false),
					isActive: () => Ref.get(active),
					isSupported: () => Effect.succeed(true),
				};
			}),
		),
		makeInstanceManagerStateLive(),
		Layer.succeed(PortScannerTag, {
			getKnownPorts: () => Effect.succeed(new Set<number>()),
			scanNow: () => Effect.succeed({ discovered: [], lost: [], active: [] }),
		}),
	);
	const dependencies = OpenCodeInstancesLive.pipe(
		Layer.provideMerge(
			(options.persistence ?? ConfigPersistenceNoopLive).pipe(
				Layer.provideMerge(base),
			),
		),
	);
	return DaemonWsRpcHandlersLive.pipe(
		Layer.provideMerge(DaemonHandleLive.pipe(Layer.provideMerge(dependencies))),
	);
};
