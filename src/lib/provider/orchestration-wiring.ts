// src/lib/provider/orchestration-wiring.ts
// Factory function to create the full orchestration layer (registry, provider
// instances, engine) from an OpenCodeClient. Used by relay-stack.ts to
// instantiate the provider layer alongside the existing relay pipeline.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, type Scope } from "effect";
import { defaultInstanceIdForDriver } from "../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { ProviderRuntimeIngestionTag } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { OrchestrationEngineTag } from "../domain/relay/Services/services.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import { createLogger } from "../logger.js";
import { ClaudeEventPersistEffectTag } from "../persistence/effect/claude-event-persist-effect.js";
import type { SSEEvent } from "../relay/opencode-events.js";
import { loadRelaySettings } from "../relay/relay-settings.js";
import {
	defaultClaudeSubagentSdk,
	makeClaudeSubagentMaterializer,
} from "./claude/claude-subagent-materializer.js";
import {
	ClaudeDriver,
	type ClaudeProviderInstanceDeps,
} from "./claude/index.js";
import {
	OpenCodeDriver,
	OpenCodeProviderInstance,
} from "./opencode-provider-instance.js";
import { OrchestrationEngine } from "./orchestration-engine.js";
import { CommandReadModelRepository } from "./orchestration-read-model.js";
import type { ProviderCommandStoreFailure } from "./orchestration-side-effect-reactor.js";
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
	readonly projectKey?: string;
	readonly sessionBindingReadModel?: ProviderSessionBindingReadModel;
	readonly configDir?: string;
	/** Test seam: replaces the Claude SDK query() (E2E trace replay). */
	readonly claudeQueryFactory?: ClaudeProviderInstanceDeps["queryFactory"];
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
	readonly projectKey?: string;
	readonly configDir?: string;
	/** Test seam: replaces the Claude SDK query() (E2E trace replay). */
	readonly claudeQueryFactory?: ClaudeProviderInstanceDeps["queryFactory"];
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
	drainSideEffects(): Effect.Effect<void, ProviderCommandStoreFailure>;
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

class OrchestrationComponentsTag extends Context.Tag("OrchestrationComponents")<
	OrchestrationComponentsTag,
	OrchestrationComponents
>() {}

const createOrchestrationComponentsEffect = (
	options: OrchestrationLayerOptions,
): Effect.Effect<
	OrchestrationComponents,
	never,
	| Scope.Scope
	| SqlClient.SqlClient
	| OpenCodeInstancesTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
> =>
	Effect.gen(function* () {
		const registry = new ProviderRegistry();

		// The relay's persistence SqlClient backs
		// the session binding read model and durable command receipts, so
		// orchestration shares the relay's single database connection.
		const sql = yield* SqlClient.SqlClient;
		const sessionBindingReadModel = new SqliteProviderSessionBindingReadModel(
			sql,
		);

		// Every session's provider calls run on its bound OpenCode instance.
		// The binding is set before sendTurn dispatches (orchestration-engine
		// binds session→providerId), so a session-keyed resolver over the
		// binding read model is correct for sendTurn/interrupt/permission/question.
		const instances = yield* OpenCodeInstancesTag;
		const clientForSession = (sessionId: string) =>
			sessionBindingReadModel
				.getProviderForSession(sessionId)
				.pipe(
					Effect.flatMap((boundInstanceId) =>
						instances.use(
							boundInstanceId ?? defaultInstanceIdForDriver("opencode"),
						),
					),
				);

		const openCodeInstance = (yield* OpenCodeDriver.create({
			client: options.client,
			...(options.workspaceRoot != null
				? { workspaceRoot: options.workspaceRoot }
				: {}),
			clientForSession,
		})) as OpenCodeProviderInstance;
		registry.registerInstance(openCodeInstance);

		const persist = yield* ClaudeEventPersistEffectTag;
		const materializeSubagents = makeClaudeSubagentMaterializer({
			sdk: defaultClaudeSubagentSdk,
			persist,
		});
		let shellEnv = options.shellEnv;
		let prepareShellEnv = options.prepareShellEnv;
		if (!shellEnv) {
			const resolver = yield* Effect.acquireRelease(
				Effect.sync(() => new ProjectShellEnvResolver()),
				(value) => Effect.sync(() => value.close()),
			);
			const directory = options.workspaceRoot ?? process.cwd();
			const config = loadDaemonConfig(options.configDir)?.projects.find(
				(project) => resolve(project.path) === resolve(directory),
			);
			resolver.register(directory, config?.shellEnv);
			shellEnv = (projectDir) => resolver.get(projectDir);
			prepareShellEnv = (projectDir) => resolver.waitUntilReady(projectDir);
		}
		const claudeInstance = yield* ClaudeDriver.create({
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
			materializeSubagents,
			...(options.claudeQueryFactory
				? { queryFactory: options.claudeQueryFactory }
				: {}),
			...(options.claudeRunnerFactory
				? { runnerFactory: options.claudeRunnerFactory }
				: {}),
		});
		registry.registerInstance(claudeInstance);
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
			snapshot: yield* new CommandReadModelRepository(sql)
				.bootstrap()
				.pipe(Effect.orDie),
			projectKey: options.projectKey ?? options.workspaceRoot ?? process.cwd(),
			now: () => Date.now(),
			generateId: () => `disp_${randomUUID()}`,
			ingestion,
		};
		const engine = new OrchestrationEngine({
			registry,
			resolveProviderDriver: (providerId) =>
				resolveProviderRoutingDriver(
					loadDaemonConfig(options.configDir),
					providerId,
				),
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
		drainSideEffects: () => engine.drainSideEffects(),
	};
}

export const makeOrchestrationRuntimeLayer = (
	options: OrchestrationRuntimeLayerOptions = {},
): Layer.Layer<
	ProviderRegistryTag | OrchestrationEngineTag,
	never,
	| OpenCodeAPITag
	| SqlClient.SqlClient
	| OpenCodeInstancesTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
> => {
	const componentsLayer = Layer.scoped(
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
				...(options.projectKey != null
					? { projectKey: options.projectKey }
					: {}),
				...(options.configDir != null ? { configDir: options.configDir } : {}),
				...(options.claudeQueryFactory
					? { claudeQueryFactory: options.claudeQueryFactory }
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
		return yield* Effect.dieMessage(
			"opencode provider is not an OpenCodeProviderInstance",
		);
	}
	return createOrchestrationView({ engine, registry, openCodeInstance });
});
