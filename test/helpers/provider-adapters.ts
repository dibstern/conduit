import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	type Scope,
} from "effect";
import { SqlClient } from "effect/sql";
import type { ProjectShellEnvSnapshot } from "../../src/lib/contracts/project-shell-env.js";
import { makeProviderAdaptersLive } from "../../src/lib/domain/daemon/Layers/provider-adapters-layer.js";
import { AccountDirectory } from "../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigSnapshotTag } from "../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../../src/lib/domain/daemon/Services/daemon-orchestration.js";
import {
	type ProjectRegistryState,
	ProjectRegistryTag,
} from "../../src/lib/domain/daemon/Services/project-registry-service.js";
import { ProviderAdapters } from "../../src/lib/domain/daemon/Services/provider-adapters.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../src/lib/domain/daemon/Services/session-activity.js";
import { AttachmentStoreTag } from "../../src/lib/domain/persistence/Services/attachment-store.js";
import { PersistenceProjectTag } from "../../src/lib/domain/persistence/Services/persistence-service.js";
import { PortWatcher } from "../../src/lib/domain/persistence/Services/port-watcher.js";
import { ProviderRuntimeIngestionTag } from "../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import {
	ConfigTag,
	OrchestrationEngineTag,
} from "../../src/lib/domain/project-services/Services/services.js";
import { SessionWorkspaceTag } from "../../src/lib/domain/project-services/Services/session-workspace.js";
import { ClaudeEventPersistEffectTag } from "../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import type { EventStoreEffectTag } from "../../src/lib/persistence/effect/event-store-effect.js";
import {
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../src/lib/persistence/effect/live.js";
import type { ProjectionRunnerEffectTag } from "../../src/lib/persistence/effect/projection-runner-effect.js";
import type { ProviderStateEffectTag } from "../../src/lib/persistence/effect/provider-state-effect.js";
import type { ReadQueryEffectTag } from "../../src/lib/persistence/effect/read-query-effect.js";
import type { ClaudeProviderInstanceDeps } from "../../src/lib/provider/claude/claude-provider-runtime.js";
import type { ClaudeSessionForkSdk } from "../../src/lib/provider/claude/claude-session-fork.js";
import { CursorAccountResources } from "../../src/lib/provider/cursor/cursor-account-resources.js";
import { createCursorSdkPort } from "../../src/lib/provider/cursor/cursor-sdk.js";
import { ProviderInstanceFailure } from "../../src/lib/provider/errors.js";
import { OpenCodeProviderInstance } from "../../src/lib/provider/opencode-provider-instance.js";
import { OrchestrationEngine } from "../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../src/lib/provider/orchestration-read-model.js";
import { makeProviderCallContextResolver } from "../../src/lib/provider/orchestration-wiring.js";
import { ProjectShellEnvResolver } from "../../src/lib/provider/project-shell-env.js";
import {
	type ProviderRegistry,
	ProviderRegistryTag,
} from "../../src/lib/provider/provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "../../src/lib/provider/provider-session-binding-read-model.js";
import type { ProjectServicesConfig } from "../../src/lib/types.js";
import { cursorAccountResourcesFixture } from "./cursor-account-resources-fixture.js";

export interface TestAdapterOptions {
	readonly configDir?: string;
	readonly workspaceRoot?: string;
	readonly projectId?: string;
	readonly claudeSdk?: Partial<NonNullable<ProjectServicesConfig["claudeSdk"]>>;
	readonly claudeQueryFactory?: ClaudeProviderInstanceDeps["queryFactory"];
	readonly claudeRunnerFactory?: ClaudeProviderInstanceDeps["runnerFactory"];
}

/** The real daemon owner, supplied with this fixture's store and project registry. */
export function makeTestProviderAdaptersLayer(
	options: TestAdapterOptions = {},
) {
	const projectId = options.projectId ?? "test-project";
	const configDir = options.configDir ?? "/tmp/conduit-test-adapters";
	const sdk =
		options.claudeSdk ??
		(options.claudeQueryFactory
			? { query: options.claudeQueryFactory }
			: undefined);
	const owner = makeProviderAdaptersLive(configDir, {
		...(sdk ? { claudeSdk: sdk } : {}),
		...(options.claudeRunnerFactory
			? { claudeRunnerFactory: options.claudeRunnerFactory }
			: {}),
	}).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.succeed(PortWatcher)({
					mark: () => Effect.succeed({ kind: "unclaimed" } as const),
					known: () => true,
				}),
				Layer.effect(
					CursorAccountResources,
					Effect.gen(function* () {
						const shared = yield* Effect.serviceOption(CursorAccountResources);
						return Option.isSome(shared)
							? shared.value
							: cursorAccountResourcesFixture(createCursorSdkPort());
					}),
				),
				Layer.effect(
					DaemonConfigRefTag,
					Effect.gen(function* () {
						const shared = yield* Effect.serviceOption(DaemonConfigRefTag);
						return Option.isSome(shared)
							? shared.value
							: yield* Ref.make(makeDaemonConfigFromOptions({}));
					}),
				),
				Layer.effect(
					PersistenceStore,
					Effect.context<PersistenceStoreContext>(),
				),
				Layer.effect(
					SessionActivityTag,
					Effect.gen(function* () {
						const shared = yield* Effect.serviceOption(SessionActivityTag);
						return Option.isSome(shared)
							? shared.value
							: yield* makeSessionActivity;
					}),
				),
				Layer.effect(
					ProjectRegistryTag,
					Ref.make<ProjectRegistryState>(
						HashMap.make([
							projectId,
							{
								_tag: "Registering" as const,
								project: {
									slug: projectId,
									title: projectId,
									folders: [options.workspaceRoot ?? configDir] as const,
								},
							},
						]),
					),
				),
			),
		),
	);
	return Layer.effect(
		ProviderAdapters,
		Effect.gen(function* () {
			const adapters = yield* ProviderAdapters;
			const projects = yield* ProjectRegistryTag;
			return {
				...adapters,
				registerProject: (id, context, onBackgroundWorkChanged) =>
					Effect.gen(function* () {
						const config = Context.getOption(context, ConfigTag);
						if (Option.isSome(config))
							yield* Ref.update(projects, (current) =>
								HashMap.set(current, id, {
									_tag: "Registering",
									project: {
										slug: id,
										title: id,
										folders: [config.value.projectDir],
									},
								}),
							);
						yield* adapters.registerProject(
							id,
							context,
							onBackgroundWorkChanged,
						);
					}),
			} satisfies ProviderAdapters["Service"];
		}),
	).pipe(Layer.provide(owner));
}

export interface OrchestrationRuntimeLayerOptions {
	readonly shellEnv?: (directory: string) => ProjectShellEnvSnapshot;
	readonly prepareShellEnv?: (directory: string) => Promise<boolean>;
	readonly workspaceRoot?: string;
	readonly extraFolders?: readonly string[];
	readonly configDir?: string;
	readonly claudeSessionForkSdk?: ClaudeSessionForkSdk;
}

/**
 * Scoped orchestration components built by a test's own orchestration runtime layer.
 */
interface OrchestrationComponents {
	readonly engine: OrchestrationEngine;
	readonly registry: ProviderRegistry;
	readonly openCodeInstance: OpenCodeProviderInstance;
}

class OrchestrationComponentsTag extends Context.Service<
	OrchestrationComponentsTag,
	OrchestrationComponents
>()("OrchestrationComponents") {}

const createOrchestrationComponentsEffect = (
	options: OrchestrationRuntimeLayerOptions,
): Effect.Effect<
	OrchestrationComponents,
	Error,
	| Scope.Scope
	| SqlClient.SqlClient
	| AttachmentStoreTag
	| PersistenceProjectTag
	| AccountDirectory
	| ProviderAdapters
	| SessionWorkspaceTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
	| ProviderStateEffectTag
	| ReadQueryEffectTag
> =>
	Effect.gen(function* () {
		const { registry } = yield* ProviderAdapters;
		const daemon = yield* Effect.serviceOption(DaemonOrchestration);
		if (Option.isSome(daemon)) {
			const openCodeInstance = yield* registry
				.getInstanceEffect("opencode")
				.pipe(Effect.orDie);
			if (!(openCodeInstance instanceof OpenCodeProviderInstance))
				return yield* Effect.fail(
					new ProviderInstanceFailure({
						providerId: "opencode",
						operation: "createOrchestration",
						cause: "opencode provider is not an OpenCodeProviderInstance",
					}),
				);
			return { engine: daemon.value.engine, registry, openCodeInstance };
		}
		const configRef = yield* Effect.serviceOption(DaemonConfigRefTag);

		// The project's persistence SqlClient backs
		// the session binding read model and durable command receipts, so
		// orchestration shares the project's single database connection.
		const sql = yield* SqlClient.SqlClient;
		const { projectId } = yield* PersistenceProjectTag;
		const sessionBindingReadModel = new SqliteProviderSessionBindingReadModel(
			sql,
		);

		// Sends use their admitted account snapshot. Other session operations
		// resolve the historical binding through the in-memory directory.
		const accountDirectory = yield* AccountDirectory;
		const sessionWorkspace = yield* SessionWorkspaceTag;

		const persist = yield* ClaudeEventPersistEffectTag;
		let shellEnv = options.shellEnv;
		let prepareShellEnv = options.prepareShellEnv;
		if (!shellEnv) {
			const resolver = yield* Effect.acquireRelease(
				Effect.sync(() => new ProjectShellEnvResolver()),
				(value) => Effect.sync(() => value.close()),
			);
			const directory = options.workspaceRoot ?? process.cwd();
			const snapshot = yield* Effect.serviceOption(ConfigSnapshotTag);
			const daemonConfig = Option.isSome(snapshot)
				? yield* snapshot.value.build
				: undefined;
			const config =
				daemonConfig?.projects.find((project) => project.slug === projectId) ??
				daemonConfig?.projects.find(
					(project) => resolve(project.path) === resolve(directory),
				);
			resolver.register(directory, config?.shellEnv, projectId);
			shellEnv = (projectDir) => resolver.getSnapshot(projectDir, projectId);
			prepareShellEnv = (projectDir) =>
				resolver.waitUntilReady(projectDir, projectId);
		}
		const resolveCallContext = yield* makeProviderCallContextResolver({
			projectId,
			sessionWorkspace,
			sessionBindingReadModel,
			shellEnv,
			...(prepareShellEnv ? { prepareShellEnv } : {}),
			...(options.workspaceRoot
				? { workspaceRoot: options.workspaceRoot }
				: {}),
			extraFolders: options.extraFolders ?? [],
		});
		// Durable command receipts share the persistence SqlClient with the
		// session binding read model. `now`/`generateId` are supplied at this wiring edge
		// (wall clock + random) so core orchestration stays free of Date.now /
		// global randomness. The shared ProviderRuntimeIngestion is
		// handed to the engine's side-effect reactor so streamed provider output
		// is persisted exactly as the former inline path did.
		const ingestion = yield* ProviderRuntimeIngestionTag;
		// Narrow command read-model bootstrap: load only the command decision
		// snapshot (receipts + stale-command tombstones), never the full
		// project/UI snapshot or message history.
		const durableCommands = {
			sql,
			snapshot: yield* new CommandReadModelRepository(sql, projectId)
				.bootstrap()
				.pipe(Effect.orDie),
			projectKey: projectId,
			now: () => Date.now(),
			generateId: () => `disp_${randomUUID()}`,
			ingestion,
			// A send_turn's input.sent projects and announces with its outbox row.
			write: (yield* makeCommitAndSignal).write,
			persistUserMessage: persist.persistUserMessage,
			...(options.claudeSessionForkSdk
				? { claudeSessionForkSdk: options.claudeSessionForkSdk }
				: {}),
		};
		const engine = new OrchestrationEngine({
			registry,
			attachmentStore: yield* AttachmentStoreTag,
			...(Option.isSome(configRef) && {
				autoSettleAfterDays: Ref.get(configRef.value).pipe(
					Effect.map((config) => config.autoSettleAfterDays),
				),
			}),
			accountDirectory,
			resolveCallContext,
			...(sessionBindingReadModel != null ? { sessionBindingReadModel } : {}),
			...(durableCommands != null ? { durableCommands } : {}),
		});
		const openCodeInstance = yield* registry
			.getInstanceEffect("opencode")
			.pipe(Effect.orDie);
		if (!(openCodeInstance instanceof OpenCodeProviderInstance))
			return yield* Effect.die(
				new Error("opencode provider is not an OpenCodeProviderInstance"),
			);
		return { engine, registry, openCodeInstance };
	});

/** A project's orchestration: the daemon's engine when the test provides one, otherwise its own. */
const makeOrchestrationRuntimeLayer = (
	options: OrchestrationRuntimeLayerOptions = {},
): Layer.Layer<
	ProviderRegistryTag | OrchestrationEngineTag,
	Error,
	| ProviderAdapters
	| SqlClient.SqlClient
	| AttachmentStoreTag
	| PersistenceProjectTag
	| AccountDirectory
	| SessionWorkspaceTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
	| ProviderStateEffectTag
	| ReadQueryEffectTag
> => {
	const componentsLayer = Layer.effect(
		OrchestrationComponentsTag,
		Effect.gen(function* () {
			const components = yield* createOrchestrationComponentsEffect(options);
			if (Option.isNone(yield* Effect.serviceOption(DaemonOrchestration)))
				yield* Effect.addFinalizer(() => components.engine.shutdownEffect());
			return components;
		}),
	);
	const registryLayer = Layer.effect(
		ProviderRegistryTag,
		Effect.map(OrchestrationComponentsTag, (components) => components.registry),
	);
	const engineLayer = Layer.effect(
		OrchestrationEngineTag,
		Effect.map(OrchestrationComponentsTag, (components) => components.engine),
	);

	return Layer.mergeAll(registryLayer, engineLayer).pipe(
		Layer.provide(componentsLayer),
	);
};

export function makeTestOrchestrationRuntimeLayer(
	options: OrchestrationRuntimeLayerOptions & TestAdapterOptions = {},
) {
	return makeOrchestrationRuntimeLayer(options).pipe(
		Layer.provideMerge(makeTestProviderAdaptersLayer(options)),
	);
}
