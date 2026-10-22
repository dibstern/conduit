import { dirname } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Option } from "effect";
import { accountsStateFromConfig } from "../../src/lib/account-directory.js";
import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
} from "../../src/lib/daemon/config-persistence.js";
import { makeStandaloneOpenCodeInstancesLive } from "../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import {
	AccountDirectory,
	makeAccountDirectory,
} from "../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { ProviderAdapters } from "../../src/lib/domain/daemon/Services/provider-adapters.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../src/lib/domain/daemon/Services/session-activity.js";
import {
	makePersistenceStoreLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../src/lib/persistence/effect/live.js";
import { makeClaudeSessionRunner } from "../../src/lib/provider/claude/claude-provider-runtime.js";
import { sdkDefaultClaudeConfigDir } from "../../src/lib/provider/claude/claude-sdk-env.js";
import {
	createProjectRelay,
	createRelayStack,
	type RelayStackConfig,
} from "../../src/lib/relay/relay-stack.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";
import { makeTestProviderAdaptersLayer } from "./provider-adapters.js";

type OwnerConfig = Pick<
	ProjectRelayConfig,
	| "configDir"
	| "persistenceDbPath"
	| "projectDir"
	| "slug"
	| "openCodeInstances"
	| "opencodeUrl"
	| "opencodeAuth"
	| "log"
> &
	Pick<RelayStackConfig, "daemonConfigContext" | "claudeSdk" | "titleQuery">;

function makeTestAdapterRuntime(config: OwnerConfig) {
	const shared = config.daemonConfigContext ?? Context.empty();
	const configDir = config.configDir ?? dirname(config.persistenceDbPath);
	const inheritedStore = Context.getOption(shared, PersistenceStore);
	const store = Option.isSome(inheritedStore)
		? Layer.succeedContext(inheritedStore.value)
		: makePersistenceStoreLayer(config.persistenceDbPath);
	const accounts = Layer.effect(
		AccountDirectory,
		Effect.gen(function* () {
			const loaded = yield* Effect.fromResult(
				loadDaemonConfigResult(configDir),
			).pipe(
				Effect.catchTag("NotFound", () =>
					Effect.succeed(defaultDaemonConfig()),
				),
			);
			return makeAccountDirectory(
				Effect.succeed(
					accountsStateFromConfig(
						loaded,
						sdkDefaultClaudeConfigDir(`${configDir}/test-home/.claude`),
					),
				),
			);
		}),
	);
	const inheritedAccounts = Context.getOption(shared, AccountDirectory);
	const accountLayer = Option.isSome(inheritedAccounts)
		? Layer.succeed(AccountDirectory, inheritedAccounts.value)
		: accounts;
	const instances = config.openCodeInstances
		? Layer.succeed(OpenCodeInstancesTag, config.openCodeInstances)
		: makeStandaloneOpenCodeInstancesLive(config).pipe(
				Layer.provide(accountLayer),
			);
	const inheritedActivity = Context.getOption(shared, SessionActivityTag);
	const deps = Layer.mergeAll(
		store,
		Option.isSome(inheritedActivity)
			? Layer.succeed(SessionActivityTag, inheritedActivity.value)
			: Layer.effect(SessionActivityTag, makeSessionActivity),
		accountLayer,
		instances,
	);
	return ManagedRuntime.make(
		makeTestProviderAdaptersLayer({
			configDir,
			projectId: config.slug,
			workspaceRoot: config.projectDir,
			...(config.claudeSdk
				? { claudeRunnerFactory: makeClaudeSessionRunner }
				: {}),
			...(config.claudeSdk || config.titleQuery
				? {
						claudeSdk: {
							...config.claudeSdk,
							...(config.titleQuery ? { titleQuery: config.titleQuery } : {}),
						},
					}
				: {}),
		}).pipe(Layer.provideMerge(deps)),
	);
}

/** Standalone tests own the same adapter layer and store that a daemon owns. */
export async function createTestProjectRelay(config: ProjectRelayConfig) {
	const shared = config.daemonConfigContext ?? Context.empty();
	if (Option.isSome(Context.getOption(shared, ProviderAdapters)))
		return createProjectRelay(config);
	const runtime = makeTestAdapterRuntime(config);
	try {
		const context = await runtime.context();
		const storeContext = await runtime.runPromise(
			Effect.context<PersistenceStoreContext>(),
		);
		const relay = await createProjectRelay({
			...config,
			openCodeInstances: Context.get(context, OpenCodeInstancesTag),
			daemonConfigContext: Context.merge(shared, context).pipe(
				Context.add(PersistenceStore, storeContext),
			),
		});
		return {
			...relay,
			stop: async () => {
				try {
					await relay.stop();
				} finally {
					await runtime.dispose();
				}
			},
		};
	} catch (error) {
		await runtime.dispose();
		throw error;
	}
}

export async function createTestRelayStack(config: RelayStackConfig) {
	const shared = config.daemonConfigContext ?? Context.empty();
	if (Option.isSome(Context.getOption(shared, ProviderAdapters)))
		return createRelayStack(config);
	const runtime = makeTestAdapterRuntime(config);
	try {
		const context = await runtime.context();
		const storeContext = await runtime.runPromise(
			Effect.context<PersistenceStoreContext>(),
		);
		const stack = await createRelayStack({
			...config,
			daemonConfigContext: Context.merge(shared, context).pipe(
				Context.add(PersistenceStore, storeContext),
			),
		});
		return {
			...stack,
			stop: async () => {
				try {
					await stack.stop();
				} finally {
					await runtime.dispose();
				}
			},
		};
	} catch (error) {
		await runtime.dispose();
		throw error;
	}
}
