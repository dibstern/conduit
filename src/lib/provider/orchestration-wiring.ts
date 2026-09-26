// src/lib/provider/orchestration-wiring.ts
// ─── Orchestration Wiring ───────────────────────────────────────────────────
// Factory function to create the full orchestration layer (registry, provider
// instances, engine) from an OpenCodeClient. Used by relay-stack.ts to
// instantiate the provider layer alongside the existing relay pipeline.

import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, type Scope } from "effect";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { OpenCodeInstanceClientsTag } from "../domain/relay/Services/opencode-instance-clients.js";
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
import { ClaudeDriver, ClaudeProviderInstance } from "./claude/index.js";
import {
	OpenCodeDriver,
	OpenCodeProviderInstance,
} from "./opencode-provider-instance.js";
import { OrchestrationEngine } from "./orchestration-engine.js";
import { CommandReadModelRepository } from "./orchestration-read-model.js";
import { ProviderRegistry, ProviderRegistryTag } from "./provider-registry.js";
import {
	type ProviderSessionBindingReadModel,
	SqliteProviderSessionBindingReadModel,
} from "./provider-session-binding-read-model.js";
import type { TurnResult } from "./types.js";

const log = createLogger("orchestration-wiring");

export interface OrchestrationLayerOptions {
	readonly onBackgroundTask?: (
		input: import("../session/background-liveness.js").BackgroundTaskTransition,
	) => void;
	readonly client: OpenCodeAPI;
	readonly workspaceRoot?: string;
	readonly projectKey?: string;
	readonly sessionBindingReadModel?: ProviderSessionBindingReadModel;
	readonly configDir?: string;
}

export interface OrchestrationRuntimeLayerOptions {
	readonly onBackgroundTask?: (
		input: import("../session/background-liveness.js").BackgroundTaskTransition,
	) => void;
	readonly workspaceRoot?: string;
	readonly projectKey?: string;
	readonly configDir?: string;
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
	drainSideEffects(): Effect.Effect<void, unknown>;
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

function createOrchestrationComponents(
	options: OrchestrationLayerOptions,
): OrchestrationComponents {
	const registry = new ProviderRegistry();

	const openCodeInstance = new OpenCodeProviderInstance({
		client: options.client,
		...(options.workspaceRoot != null
			? { workspaceRoot: options.workspaceRoot }
			: {}),
	});

	registry.registerInstance(openCodeInstance);

	const claudeInstance = new ClaudeProviderInstance({
		workspaceRoot: options.workspaceRoot ?? process.cwd(),
		claudeSettingsOverrides: () =>
			loadRelaySettings(options.configDir).claudeSettings,
	});
	registry.registerInstance(claudeInstance);

	const engine = new OrchestrationEngine({
		registry,
		resolveProviderDriver: (providerId) =>
			resolveProviderRoutingDriver(
				loadDaemonConfig(options.configDir),
				providerId,
			),
		...(options.sessionBindingReadModel != null
			? { sessionBindingReadModel: options.sessionBindingReadModel }
			: {}),
	});

	return { engine, registry, openCodeInstance };
}

const createOrchestrationComponentsEffect = (
	options: OrchestrationLayerOptions,
): Effect.Effect<OrchestrationComponents, never, Scope.Scope> =>
	Effect.gen(function* () {
		const registry = new ProviderRegistry();

		// The relay's persistence SqlClient (when persistence is configured) backs
		// the session binding read model and durable command receipts, so
		// orchestration shares the relay's single database connection.
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
		const sql = sqlOption._tag === "Some" ? sqlOption.value : undefined;
		const sessionBindingReadModel =
			sql != null ? new SqliteProviderSessionBindingReadModel(sql) : undefined;

		// Phase 4.4: sessions bound to a NAMED OpenCode instance route their
		// provider calls to that instance's client. The binding is set before
		// sendTurn dispatches (orchestration-engine binds session→providerId),
		// so a session-keyed resolver over the binding read model is correct
		// for sendTurn/interrupt/permission/question alike.
		const instanceClientsOption = yield* Effect.serviceOption(
			OpenCodeInstanceClientsTag,
		);
		const clientForSession =
			instanceClientsOption._tag === "Some" && sessionBindingReadModel != null
				? (sessionId: string) =>
						sessionBindingReadModel
							.getProviderForSession(sessionId)
							.pipe(
								Effect.flatMap((boundInstanceId) =>
									boundInstanceId == null
										? Effect.succeed(undefined)
										: instanceClientsOption.value.clientFor(boundInstanceId),
								),
							)
				: undefined;

		const openCodeInstance = (yield* OpenCodeDriver.create({
			client: options.client,
			...(options.workspaceRoot != null
				? { workspaceRoot: options.workspaceRoot }
				: {}),
			...(clientForSession != null ? { clientForSession } : {}),
		})) as OpenCodeProviderInstance;
		registry.registerInstance(openCodeInstance);

		const persistOption = yield* Effect.serviceOption(
			ClaudeEventPersistEffectTag,
		);
		const materializeSubagents =
			persistOption._tag === "Some"
				? makeClaudeSubagentMaterializer({
						sdk: defaultClaudeSubagentSdk,
						persist: persistOption.value,
					})
				: undefined;
		const claudeInstance = yield* ClaudeDriver.create({
			...(options.onBackgroundTask
				? { onBackgroundTask: options.onBackgroundTask }
				: {}),
			workspaceRoot: options.workspaceRoot ?? process.cwd(),
			claudeSettingsOverrides: () =>
				loadRelaySettings(options.configDir).claudeSettings,
			...(materializeSubagents ? { materializeSubagents } : {}),
		});
		registry.registerInstance(claudeInstance);
		// Durable command receipts share the persistence SqlClient with the
		// session binding read model. `now`/`generateId` are supplied at this wiring edge
		// (wall clock + random) so core orchestration stays free of Date.now /
		// global randomness. The shared ProviderRuntimeIngestion (when present) is
		// handed to the engine's side-effect reactor so streamed provider output
		// is persisted exactly as the former inline path did.
		const ingestionOption = yield* Effect.serviceOption(
			ProviderRuntimeIngestionTag,
		);
		// Narrow command read-model bootstrap: load only the command decision
		// snapshot (receipts + stale-command tombstones), never the full
		// relay/UI snapshot or message history.
		const durableCommands =
			sql != null
				? {
						sql,
						snapshot: yield* new CommandReadModelRepository(sql)
							.bootstrap()
							.pipe(Effect.orDie),
						projectKey:
							options.projectKey ?? options.workspaceRoot ?? process.cwd(),
						now: () => Date.now(),
						generateId: () => `disp_${randomUUID()}`,
						...(ingestionOption._tag === "Some"
							? { ingestion: ingestionOption.value }
							: {}),
					}
				: undefined;
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

/**
 * Create an imperative view over orchestration components.
 *
 * Kept for narrow unit tests and compatibility surfaces. Production relay
 * wiring uses makeOrchestrationRuntimeLayer() so provider instance shutdown is
 * owned by the relay runtime Scope.
 */
export function createOrchestrationLayer(
	options: OrchestrationLayerOptions,
): OrchestrationLayer {
	return createOrchestrationView(createOrchestrationComponents(options));
}

export const makeOrchestrationRuntimeLayer = (
	options: OrchestrationRuntimeLayerOptions = {},
): Layer.Layer<
	ProviderRegistryTag | OrchestrationEngineTag,
	never,
	OpenCodeAPITag
> => {
	const componentsLayer = Layer.scoped(
		OrchestrationComponentsTag,
		Effect.gen(function* () {
			const client = yield* OpenCodeAPITag;
			const components = yield* createOrchestrationComponentsEffect({
				client,
				...(options.onBackgroundTask
					? { onBackgroundTask: options.onBackgroundTask }
					: {}),
				...(options.workspaceRoot != null
					? { workspaceRoot: options.workspaceRoot }
					: {}),
				...(options.projectKey != null
					? { projectKey: options.projectKey }
					: {}),
				...(options.configDir != null ? { configDir: options.configDir } : {}),
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
