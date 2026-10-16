import { Deferred, Effect, Layer, Ref } from "effect";
import type { AccountsState } from "../../src/lib/account-directory.js";
import { CategorySetLive } from "../../src/lib/domain/daemon/Layers/category-set-layer.js";
import { ShutdownSignalTag } from "../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { DaemonWsRpcHandlersLive } from "../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { KeepAwakeTag } from "../../src/lib/domain/daemon/Layers/keep-awake-layer.js";
import { OpenCodeInstancesLive } from "../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import { PortScannerTag } from "../../src/lib/domain/daemon/Layers/port-scanner-layer.js";
import { TailscaleCliTag } from "../../src/lib/domain/daemon/Layers/tailscale-serve-layer.js";
import type { AccountDirectory } from "../../src/lib/domain/daemon/Services/account-directory.js";
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
	type DaemonInstanceConfig,
	type DaemonState,
	type DaemonStateTag,
	makeDaemonStateLive,
} from "../../src/lib/domain/daemon/Services/daemon-state.js";
import { InstanceHealthCheckLive } from "../../src/lib/domain/daemon/Services/instance-health-service.js";
import {
	type InstanceManagerStateTag,
	makeInstanceManagerStateLive,
} from "../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	MessageSurfacingSettings,
	type MessageSurfacingSettingsOptions,
	makeMessageSurfacingSettings,
} from "../../src/lib/domain/daemon/Services/message-surfacing-settings.js";
import {
	makeProjectRegistryLive,
	type ProjectRegistryTag,
} from "../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	makeRelayCacheLive,
	type RelayFactory,
} from "../../src/lib/domain/daemon/Services/relay-cache.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../src/lib/domain/daemon/Services/session-activity.js";
import { makeSessionDirectoryLive } from "../../src/lib/domain/daemon/Services/session-directory.js";
import {
	makeUsage,
	Usage,
} from "../../src/lib/domain/daemon/Services/usage.js";
import { AuthManagerFromConfigLive } from "../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	type ClaudeConfigDir,
	configuredClaudeConfigDir,
} from "../../src/lib/provider/claude/claude-sdk-env.js";
import {
	BrowserRpcConnectionsLive,
	RpcCaller,
} from "../../src/lib/server/ws-rpc.js";
import type { StoredProject } from "../../src/lib/types.js";

export const makeDaemonRpcTestLayer = (
	projects: ReadonlyArray<StoredProject> = [],
	factory: RelayFactory = () => Effect.die("Unexpected relay startup"),
	options: {
		config?: Partial<DaemonRuntimeConfig>;
		configDir?: string;
		messageSurfacing?: MessageSurfacingSettingsOptions;
		instances?: ReadonlyArray<DaemonInstanceConfig>;
		launchLogin?: ClaudeConfigDir;
		accountsState?: AccountsState;
		tailscaleCli?: Layer.Layer<TailscaleCliTag>;
		persistence?: Layer.Layer<
			ConfigPersistenceTag,
			never,
			| DaemonStateTag
			| DaemonConfigRefTag
			| AccountDirectory
			| ProjectRegistryTag
			| InstanceManagerStateTag
		>;
	} = {},
) => {
	const base = Layer.mergeAll(
		Layer.effect(
			MessageSurfacingSettings,
			makeMessageSurfacingSettings(
				options.configDir ?? "/tmp/daemon-rpc-fixture",
				options.messageSurfacing ?? { env: {} },
			),
		),
		CategorySetLive(options.configDir ?? "/tmp/daemon-rpc-fixture"),
		makeSessionDirectoryLive(
			options.configDir ?? "/tmp/daemon-rpc-fixture",
			projects,
		),
		Layer.effect(SessionActivityTag, makeSessionActivity),
		makeProjectRegistryLive(projects),
		makeRelayCacheLive(factory),
		DaemonEventBusLive,
		BrowserRpcConnectionsLive,
		options.tailscaleCli ??
			Layer.succeed(TailscaleCliTag, {
				exec: () => Effect.succeed('{"BackendState":"Stopped"}'),
			}),
		Layer.succeed(RpcCaller, { kind: "cli" }),
		InstanceHealthCheckLive,
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
				const command = yield* Ref.make<string | null>(null);
				return {
					activate: () => Ref.set(active, true),
					deactivate: () => Ref.set(active, false),
					setCommand: (executable, args) =>
						Ref.set(command, [executable, ...args].join(" ")),
					getCommand: () => Ref.get(command),
					isActive: () => Ref.get(active),
					isSupported: () => Effect.succeed(true),
				};
			}),
		),
		makeInstanceManagerStateLive(undefined, options.instances ?? [], {
			...(options.accountsState !== undefined && {
				accountsState: options.accountsState,
			}),
			launchLogin:
				options.launchLogin ??
				configuredClaudeConfigDir("/tmp/daemon-rpc-fixture/claude"),
		}),
		Layer.scoped(
			Usage,
			makeUsage({ accounts: Effect.succeed([]), readers: {} }),
		),
		Layer.succeed(PortScannerTag, {
			getKnownPorts: () => Effect.succeed(new Set<number>()),
			scanNow: () => Effect.succeed({ discovered: [], lost: [], active: [] }),
		}),
	);
	const dependencies = OpenCodeInstancesLive.pipe(
		Layer.provideMerge(
			Layer.merge(
				AuthManagerFromConfigLive,
				options.persistence ?? ConfigPersistenceNoopLive,
			).pipe(Layer.provideMerge(base)),
		),
	);
	return DaemonWsRpcHandlersLive.pipe(
		Layer.provideMerge(DaemonHandleLive.pipe(Layer.provideMerge(dependencies))),
	);
};
