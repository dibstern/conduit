// src/lib/provider/orchestration-wiring.ts
// Factory function to create the full orchestration layer (registry, provider
// instances, engine) from an OpenCodeClient. Used by relay-stack.ts to
// instantiate the provider layer alongside the existing relay pipeline.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Context, Effect, Layer, Option, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../contracts/account.js";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
import {
	type DaemonConfigLoadError,
	loadDaemonConfigResult,
} from "../daemon/config-persistence.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { InstanceManagementServiceTag } from "../domain/relay/Services/instance-management-service.js";
import { ProviderRuntimeIngestionTag } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { OrchestrationEngineTag } from "../domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import { createLogger } from "../logger.js";
import { ClaudeEventPersistEffectTag } from "../persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../persistence/effect/commit-and-signal.js";
import type { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import type { SSEEvent } from "../relay/opencode-events.js";
import { loadRelaySettings } from "../relay/relay-settings.js";
import { defaultClaudeSubagentSdk } from "./claude/claude-subagent-materializer.js";
import {
	ClaudeDriver,
	type ClaudeProviderInstanceDeps,
} from "./claude/index.js";
import { makeCursorProviderRuntime } from "./cursor/cursor-provider-runtime.js";
import {
	OpenCodeDriver,
	OpenCodeProviderInstance,
} from "./opencode-provider-instance.js";
import { OrchestrationEngine } from "./orchestration-engine.js";
import { CommandReadModelRepository } from "./orchestration-read-model.js";
import type {
	ProviderCommandInteractionSinkFactory,
	ProviderCommandStoreFailure,
} from "./orchestration-side-effect-reactor.js";
import { ProjectShellEnvResolver } from "./project-shell-env.js";
import { ProviderRegistry, ProviderRegistryTag } from "./provider-registry.js";
import {
	type ProviderSessionBindingReadModel,
	SqliteProviderSessionBindingReadModel,
} from "./provider-session-binding-read-model.js";
import type { TurnResult } from "./types.js";

const log = createLogger("orchestration-wiring");

export interface OrchestrationLayerOptions {
	readonly shellEnv?: ClaudeProviderInstanceDeps["shellEnv"];
	readonly prepareShellEnv?: ClaudeProviderInstanceDeps["prepareShellEnv"];
	readonly onBackgroundTask?: (
		input: import("../session/background-liveness.js").BackgroundTaskTransition,
	) => void;
	readonly client: OpenCodeAPI;
	readonly workspaceRoot?: string;
	readonly extraFolders?: readonly string[];
	readonly sessionBindingReadModel?: ProviderSessionBindingReadModel;
	readonly configDir?: string;
	/** Test seam: replaces the Claude SDK query() (E2E trace replay). */
	readonly claudeQueryFactory?: ClaudeProviderInstanceDeps["queryFactory"];
	readonly claudeGenerateTextQueryFactory?: ClaudeProviderInstanceDeps["generateTextQueryFactory"];
	readonly claudeSessionForkSdk?: ClaudeProviderInstanceDeps["sessionForkSdk"];
	/** Test seam: replaces the SDK's agent transcript reads (E2E trace replay). */
	readonly claudeSubagentSdk?: ClaudeProviderInstanceDeps["subagentSdk"];
	readonly claudeRunnerFactory?: ClaudeProviderInstanceDeps["runnerFactory"];
}

export interface OrchestrationRuntimeLayerOptions {
	readonly shellEnv?: ClaudeProviderInstanceDeps["shellEnv"];
	readonly prepareShellEnv?: ClaudeProviderInstanceDeps["prepareShellEnv"];
	readonly onBackgroundTask?: (
		input: import("../session/background-liveness.js").BackgroundTaskTransition,
	) => void;
	readonly workspaceRoot?: string;
	readonly extraFolders?: readonly string[];
	readonly configDir?: string;
	/** Test seam: replaces the Claude SDK query() (E2E trace replay). */
	readonly claudeQueryFactory?: ClaudeProviderInstanceDeps["queryFactory"];
	readonly claudeGenerateTextQueryFactory?: ClaudeProviderInstanceDeps["generateTextQueryFactory"];
	readonly claudeSessionForkSdk?: ClaudeProviderInstanceDeps["sessionForkSdk"];
	/** Test seam: replaces the SDK's agent transcript reads (E2E trace replay). */
	readonly claudeSubagentSdk?: ClaudeProviderInstanceDeps["subagentSdk"];
	readonly claudeRunnerFactory?: ClaudeProviderInstanceDeps["runnerFactory"];
}

export interface OrchestrationLayer {
	readonly engine: OrchestrationEngine;
	readonly registry: ProviderRegistry;
	readonly openCodeInstance: OpenCodeProviderInstance;
	/**
	 * Wire SSE session.status idle events to notifyTurnCompleted().
	 * Must be called once after the SSEStream is created so that
	 * OpenCodeProviderInstance.sendTurnEffect() deferred promises can resolve when
	 * the session transitions to idle.
	 */
	wireSSEToInstance(
		sseOn: (event: "event", handler: (e: unknown) => void) => void,
	): void;
	/**
	 * Deterministic quiescence seam: drain committed-but-unexecuted provider
	 * side effects through the reactor (crash recovery / test flush). Same-process
	 * dispatch already awaits its own execution.
	 */
	drainSideEffects(
		makeInteractions?: ProviderCommandInteractionSinkFactory,
	): Effect.Effect<void, ProviderCommandStoreFailure>;
}

const TURN_COMPLETE_RESULT: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};

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
	options: OrchestrationLayerOptions,
): Effect.Effect<
	OrchestrationComponents,
	DaemonConfigLoadError,
	| Scope.Scope
	| SqlClient.SqlClient
	| PersistenceProjectTag
	| AccountDirectory
	| OpenCodeInstancesTag
	| SessionWorkspaceTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
> =>
	Effect.gen(function* () {
		const registry = new ProviderRegistry();

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
		const instances = yield* OpenCodeInstancesTag;
		const accountDirectory = yield* AccountDirectory;
		const sessionWorkspace = yield* SessionWorkspaceTag;
		const instanceManagement = Option.getOrUndefined(
			yield* Effect.serviceOption(InstanceManagementServiceTag),
		);
		const clientForSession = (sessionId: string) =>
			Effect.gen(function* () {
				const boundInstanceId =
					yield* sessionBindingReadModel.getProviderForSession(sessionId);
				const account = yield* accountDirectory.resolve(
					boundInstanceId === undefined
						? { _tag: "DriverDefault", driver: "opencode" }
						: { _tag: "Id", id: boundInstanceId },
				);
				if (!PROVIDER_DRIVERS[account.driver].runsOpenCodeServer) {
					return yield* Effect.fail(
						new Error("OpenCode session requires an OpenCode account"),
					);
				}
				const directory = yield* sessionWorkspace.get(sessionId);
				return yield* instances.use(account.id, directory);
			});

		const openCodeInstance = (yield* OpenCodeDriver.create({
			client: options.client,
			...(options.workspaceRoot != null
				? { workspaceRoot: options.workspaceRoot }
				: {}),
			clientForSession,
			clientForAccount: (account, directory) =>
				instances.use(account.id, directory),
			instanceIdForSession: (sessionId) =>
				sessionBindingReadModel.getProviderForSession(sessionId),
			hasWorktreeToolForSession: (sessionId, account) =>
				(account
					? Effect.succeed(account.id)
					: sessionBindingReadModel.getProviderForSession(sessionId)
				).pipe(
					Effect.flatMap((instanceId) =>
						instanceManagement
							? instanceManagement.list().pipe(
									Effect.map((configured) =>
										configured.some(
											(instance) =>
												instance.id ===
													(instanceId ?? MANAGED_OPENCODE_ACCOUNT_ID) &&
												instance.managed,
										),
									),
									Effect.orElseSucceed(() => false),
								)
							: Effect.succeed(false),
					),
				),
		})) as OpenCodeProviderInstance;
		registry.registerInstance(openCodeInstance);

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
			const config = daemonConfig?.projects.find(
				(project) => resolve(project.path) === resolve(directory),
			);
			resolver.register(directory, config?.shellEnv);
			shellEnv = (projectDir) => resolver.get(projectDir);
			prepareShellEnv = (projectDir) => resolver.waitUntilReady(projectDir);
		}
		const claudeInstance = yield* ClaudeDriver.create({
			persistHandoffDelivered: persist.persistHandoffDelivered,
			shellEnv,
			...(prepareShellEnv ? { prepareShellEnv } : {}),
			...(options.onBackgroundTask
				? { onBackgroundTask: options.onBackgroundTask }
				: {}),
			workspaceRoot: options.workspaceRoot ?? process.cwd(),
			extraFolders: options.extraFolders ?? [],
			...(options.configDir !== undefined
				? { daemonConfigDir: options.configDir }
				: {}),
			claudeSettingsOverrides: () =>
				loadRelaySettings(options.configDir).claudeSettings,
			subagentSdk: options.claudeSubagentSdk ?? defaultClaudeSubagentSdk,
			...(options.claudeSessionForkSdk
				? { sessionForkSdk: options.claudeSessionForkSdk }
				: {}),
			persistUserMessage: persist.persistUserMessage,
			...(options.claudeQueryFactory
				? { queryFactory: options.claudeQueryFactory }
				: {}),
			...(options.claudeGenerateTextQueryFactory
				? { generateTextQueryFactory: options.claudeGenerateTextQueryFactory }
				: {}),
			...(options.claudeRunnerFactory
				? { runnerFactory: options.claudeRunnerFactory }
				: {}),
		});
		registry.registerInstance(claudeInstance);
		registry.registerInstance(
			yield* makeCursorProviderRuntime({
				workspaceRoot: options.workspaceRoot ?? process.cwd(),
				accounts: accountDirectory.snapshot,
				...(options.configDir !== undefined
					? { daemonConfigDir: options.configDir }
					: {}),
				persistUserMessage: persist.persistUserMessage,
			}),
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
			persistHandoffDelivered: persist.persistHandoffDelivered,
			...(options.claudeSessionForkSdk
				? { claudeSessionForkSdk: options.claudeSessionForkSdk }
				: {}),
		};
		const engine = new OrchestrationEngine({
			registry,
			accountDirectory,
			...(sessionBindingReadModel != null ? { sessionBindingReadModel } : {}),
			...(durableCommands != null ? { durableCommands } : {}),
		});
		return { engine, registry, openCodeInstance };
	});

function createOrchestrationView(
	components: OrchestrationComponents,
): OrchestrationLayer {
	const { openCodeInstance, engine, registry } = components;

	function wireSSEToInstance(
		sseOn: (event: "event", handler: (e: unknown) => void) => void,
	): void {
		sseOn("event", (raw) => {
			const event = raw as SSEEvent;
			if (event.type !== "session.status") return;
			const props = event.properties as Record<string, unknown> | undefined;
			const statusType = (props?.["status"] as { type?: string } | undefined)
				?.type;
			if (statusType !== "idle") return;
			const sessionId =
				(props?.["sessionID"] as string | undefined) ??
				(event as { sessionId?: string }).sessionId;
			if (sessionId) {
				try {
					openCodeInstance.notifyTurnCompleted(sessionId, TURN_COMPLETE_RESULT);
				} catch (err) {
					log.error(
						`notifyTurnCompleted failed for session ${sessionId}: ${err instanceof Error ? err.message : err}`,
					);
				}
			}
		});
	}

	return {
		engine,
		registry,
		openCodeInstance,
		wireSSEToInstance,
		drainSideEffects: (makeInteractions) =>
			engine.drainSideEffects(makeInteractions),
	};
}

export const makeOrchestrationRuntimeLayer = (
	options: OrchestrationRuntimeLayerOptions = {},
): Layer.Layer<
	ProviderRegistryTag | OrchestrationEngineTag,
	DaemonConfigLoadError,
	| OpenCodeAPITag
	| SqlClient.SqlClient
	| PersistenceProjectTag
	| AccountDirectory
	| OpenCodeInstancesTag
	| SessionWorkspaceTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
> => {
	const componentsLayer = Layer.effect(
		OrchestrationComponentsTag,
		Effect.gen(function* () {
			const client = yield* OpenCodeAPITag;
			const components = yield* createOrchestrationComponentsEffect({
				client,
				...(options.shellEnv && { shellEnv: options.shellEnv }),
				...(options.prepareShellEnv && {
					prepareShellEnv: options.prepareShellEnv,
				}),
				...(options.onBackgroundTask
					? { onBackgroundTask: options.onBackgroundTask }
					: {}),
				...(options.workspaceRoot != null
					? { workspaceRoot: options.workspaceRoot }
					: {}),
				extraFolders: options.extraFolders ?? [],
				...(options.configDir != null ? { configDir: options.configDir } : {}),
				...(options.claudeQueryFactory
					? { claudeQueryFactory: options.claudeQueryFactory }
					: {}),
				...(options.claudeGenerateTextQueryFactory
					? {
							claudeGenerateTextQueryFactory:
								options.claudeGenerateTextQueryFactory,
						}
					: {}),
				...(options.claudeSessionForkSdk
					? { claudeSessionForkSdk: options.claudeSessionForkSdk }
					: {}),
				...(options.claudeSubagentSdk
					? { claudeSubagentSdk: options.claudeSubagentSdk }
					: {}),
				...(options.claudeRunnerFactory
					? { claudeRunnerFactory: options.claudeRunnerFactory }
					: {}),
			});
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
