// src/lib/provider/orchestration-wiring.ts
// Project orchestration borrows the daemon adapters and resolves ProviderCalls
// from project-owned workspace, account and shell environment state.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { AccountUnroutable } from "../contracts/limit-recovery.js";
import { SessionWorkspaceSchema } from "../contracts/session-workspace.js";
import {
	type DaemonConfigLoadError,
	loadDaemonConfigResult,
} from "../daemon/config-persistence.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { ProjectContext } from "../domain/daemon/Services/project-context.js";
import { ProviderAdapters } from "../domain/daemon/Services/provider-adapters.js";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import { ProviderRuntimeIngestionTag } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { OrchestrationEngineTag } from "../domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
import { ClaudeEventPersistEffectTag } from "../persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../persistence/effect/commit-and-signal.js";
import type { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import type { ProviderStateEffectTag } from "../persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { effectiveSessionFolders } from "../session/session-workspace.js";
import type { ClaudeSessionForkSdk } from "./claude/claude-session-fork.js";
import { ProviderInstanceFailure } from "./errors.js";
import { OpenCodeProviderInstance } from "./opencode-provider-instance.js";
import {
	OrchestrationEngine,
	type ProviderCallRequest,
} from "./orchestration-engine.js";
import { CommandReadModelRepository } from "./orchestration-read-model.js";
import type {
	ProviderCommandInteractionSinkFactory,
	ProviderCommandStoreFailure,
} from "./orchestration-side-effect-reactor.js";
import { ProjectShellEnvResolver } from "./project-shell-env.js";
import {
	type ProviderRegistry,
	ProviderRegistryTag,
} from "./provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "./provider-session-binding-read-model.js";
import type { ProviderCall } from "./types.js";

export interface OrchestrationRuntimeLayerOptions {
	readonly shellEnv?: (
		directory: string,
	) => Readonly<Record<string, string | undefined>>;
	readonly prepareShellEnv?: (directory: string) => Promise<boolean>;
	readonly workspaceRoot?: string;
	readonly extraFolders?: readonly string[];
	readonly configDir?: string;
	readonly claudeSessionForkSdk?: ClaudeSessionForkSdk;
}

export interface OrchestrationLayer {
	readonly engine: OrchestrationEngine;
	readonly registry: ProviderRegistry;
	readonly openCodeInstance: OpenCodeProviderInstance;
	/**
	 * Deterministic quiescence seam: drain committed-but-unexecuted provider
	 * side effects through the reactor (crash recovery / test flush). Same-process
	 * dispatch already awaits its own execution.
	 */
	drainSideEffects(
		makeInteractions?: ProviderCommandInteractionSinkFactory,
	): Effect.Effect<void, ProviderCommandStoreFailure>;
}

/**
 * Scoped orchestration components built by the relay runtime layer.
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
	DaemonConfigLoadError,
	| Scope.Scope
	| SqlClient.SqlClient
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

		// The relay's persistence SqlClient backs
		// the session binding read model and durable command receipts, so
		// orchestration shares the relay's single database connection.
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
			const daemonConfig = yield* Effect.suspend(() =>
				Effect.fromResult(loadDaemonConfigResult(options.configDir)),
			).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)));
			const config =
				daemonConfig?.projects.find((project) => project.slug === projectId) ??
				daemonConfig?.projects.find(
					(project) => resolve(project.path) === resolve(directory),
				);
			resolver.register(directory, config?.shellEnv, projectId);
			shellEnv = (projectDir) => resolver.get(projectDir, projectId);
			prepareShellEnv = (projectDir) =>
				resolver.waitUntilReady(projectDir, projectId);
		}
		const read = yield* ReadQueryEffectTag;
		const projectContexts = yield* Effect.serviceOption(ProjectContext);
		const projectRoot = options.workspaceRoot ?? process.cwd();
		const getShellEnv = shellEnv;
		const prepareEnvironment = prepareShellEnv;
		const resolveCallContext = (
			request: ProviderCallRequest,
		): Effect.Effect<ProviderCall, ProviderInstanceFailure> =>
			Effect.gen(function* () {
				const project = Option.isSome(projectContexts)
					? yield* (
							request.projectId
								? projectContexts.value.forProject(request.projectId)
								: request.sessionId
									? projectContexts.value.forSession(request.sessionId)
									: projectContexts.value.forProject(projectId)
						).pipe(
							Effect.catchTag("ProjectNotFound", (cause) =>
								// Cleanup retains admitted folders when its project has been removed.
								// Launches still require a registered project and current environment.
								request.projectId &&
								request.workspaceRoot &&
								request.extraFolders &&
								!request.requireRoutableAccount
									? Effect.succeed({
											projectId: request.projectId,
											mainFolder: request.workspaceRoot,
											extraFolders: request.extraFolders,
											shellEnv: Object.freeze({}),
										})
									: Effect.fail(cause),
							),
						)
					: undefined;
				const mainFolder = project?.mainFolder ?? projectRoot;
				const currentAccount = yield* accountDirectory
					.resolve({
						_tag: "Id",
						id:
							request.account?.id ??
							request.providerId ??
							(yield* sessionBindingReadModel.getProviderForSession(
								request.sessionId,
							)) ??
							"opencode",
					})
					.pipe(
						Effect.catchTag("AccountUnroutable", (cause) =>
							request.account && !request.requireRoutableAccount
								? Effect.succeed({ ...request.account, env: undefined })
								: Effect.fail(cause),
						),
					);
				const matches =
					!request.account ||
					(currentAccount.id === request.account.id &&
						currentAccount.driver === request.account.driver);
				if (request.account && request.requireRoutableAccount && !matches)
					return yield* Effect.fail(
						new AccountUnroutable({
							ref: { _tag: "Id", id: request.account.id },
						}),
					);
				const account = request.account
					? {
							...request.account,
							env: matches ? currentAccount.env : undefined,
						}
					: currentAccount;
				const session = request.sessionId
					? yield* read.getSession(request.sessionId)
					: undefined;
				const workspaceRoot =
					request.workspaceRoot ??
					(session
						? yield* sessionWorkspace.get(
								request.sessionId,
								undefined,
								mainFolder,
							)
						: mainFolder);
				const workspace = session?.workspace
					? yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(SessionWorkspaceSchema),
						)(session.workspace)
					: null;
				const extraFolders =
					request.extraFolders ??
					effectiveSessionFolders(
						[
							mainFolder,
							...(project?.extraFolders ?? options.extraFolders ?? []),
						],
						workspace,
					)
						.map(({ directory }) => directory)
						.filter((directory) => directory !== workspaceRoot);
				if (!project && request.prepareShellEnv && prepareEnvironment) {
					yield* Effect.tryPromise(() =>
						prepareEnvironment(workspaceRoot),
					).pipe(
						Effect.timeoutOption("10 seconds"),
						Effect.catch(() => Effect.void),
					);
				}
				const environment =
					project && Option.isSome(projectContexts)
						? (workspaceRoot !== project.mainFolder || request.prepareShellEnv
								? yield* projectContexts.value.forProject(project.projectId, {
										directory: workspaceRoot,
										prepareShellEnv: request.prepareShellEnv === true,
									})
								: project
							).shellEnv
						: getShellEnv(workspaceRoot);
				return Object.freeze({
					projectId: project?.projectId ?? projectId,
					sessionId: request.sessionId,
					account,
					workspaceRoot,
					extraFolders: Object.freeze([...extraFolders]),
					shellEnv: Object.freeze({ ...environment }),
				});
			}).pipe(
				Effect.mapError(
					(cause) =>
						new ProviderInstanceFailure({
							providerId:
								request.account?.driver ?? request.providerId ?? "unknown",
							operation: "resolveCallContext",
							cause,
						}),
				),
			);
		// Durable command receipts share the persistence SqlClient with the
		// session binding read model. `now`/`generateId` are supplied at this wiring edge
		// (wall clock + random) so core orchestration stays free of Date.now /
		// global randomness. The shared ProviderRuntimeIngestion is
		// handed to the engine's side-effect reactor so streamed provider output
		// is persisted exactly as the former inline path did.
		const ingestion = yield* ProviderRuntimeIngestionTag;
		// Narrow command read-model bootstrap: load only the command decision
		// snapshot (receipts + stale-command tombstones), never the full
		// relay/UI snapshot or message history.
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

function createOrchestrationView(
	components: OrchestrationComponents,
): OrchestrationLayer {
	const { openCodeInstance, engine, registry } = components;

	return {
		engine,
		registry,
		openCodeInstance,
		drainSideEffects: (makeInteractions) =>
			engine.drainSideEffects(makeInteractions),
	};
}

export const makeOrchestrationRuntimeLayer = (
	options: OrchestrationRuntimeLayerOptions = {},
): Layer.Layer<
	ProviderRegistryTag | OrchestrationEngineTag,
	DaemonConfigLoadError,
	| ProviderAdapters
	| SqlClient.SqlClient
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

export const getOrchestrationLayer = Effect.gen(function* () {
	const engine = yield* OrchestrationEngineTag;
	const registry = yield* ProviderRegistryTag;
	const openCodeInstance = yield* registry.getInstanceEffect("opencode");
	if (!(openCodeInstance instanceof OpenCodeProviderInstance)) {
		return yield* Effect.die(
			new Error("opencode provider is not an OpenCodeProviderInstance"),
		);
	}
	return createOrchestrationView({ engine, registry, openCodeInstance });
});
