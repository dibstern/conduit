// src/lib/provider/orchestration-wiring.ts
// ─── Orchestration Wiring ───────────────────────────────────────────────────
// Factory function to create the full orchestration layer (registry, provider
// instances, engine) from an OpenCodeClient. Used by relay-stack.ts to
// instantiate the provider layer alongside the existing relay pipeline.

import { Context, Effect, Layer, type Scope } from "effect";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { OrchestrationEngineTag } from "../domain/relay/Services/services.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import { createLogger } from "../logger.js";
import { ClaudeEventPersistEffectTag } from "../persistence/effect/claude-event-persist-effect.js";
import { SqliteClient } from "../persistence/sqlite-client.js";
import type { SSEEvent } from "../relay/opencode-events.js";
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
import { ProviderRegistry, ProviderRegistryTag } from "./provider-registry.js";
import {
	type ProviderSessionBindingReadModel,
	SqliteProviderSessionBindingReadModel,
} from "./provider-session-binding-read-model.js";
import type { TurnResult } from "./types.js";

const log = createLogger("orchestration-wiring");

export interface OrchestrationLayerOptions {
	readonly client: OpenCodeAPI;
	readonly workspaceRoot?: string;
	readonly persistenceDbPath?: string;
	readonly sessionBindingReadModel?: ProviderSessionBindingReadModel;
}

export interface OrchestrationRuntimeLayerOptions {
	readonly workspaceRoot?: string;
	readonly persistenceDbPath?: string;
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
	});
	registry.registerInstance(claudeInstance);

	const engine = new OrchestrationEngine({
		registry,
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
		const openCodeInstance = (yield* OpenCodeDriver.create({
			client: options.client,
			...(options.workspaceRoot != null
				? { workspaceRoot: options.workspaceRoot }
				: {}),
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
			workspaceRoot: options.workspaceRoot ?? process.cwd(),
			...(materializeSubagents ? { materializeSubagents } : {}),
		});
		registry.registerInstance(claudeInstance);

		const persistenceDbPath = options.persistenceDbPath;
		const sessionBindingDb =
			persistenceDbPath != null
				? yield* Effect.sync(() => SqliteClient.open(persistenceDbPath))
				: undefined;
		if (sessionBindingDb != null) {
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => sessionBindingDb.close()),
			);
		}
		const sessionBindingReadModel =
			sessionBindingDb != null
				? new SqliteProviderSessionBindingReadModel(sessionBindingDb)
				: undefined;
		const engine = new OrchestrationEngine({
			registry,
			...(sessionBindingReadModel != null ? { sessionBindingReadModel } : {}),
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

	return { engine, registry, openCodeInstance, wireSSEToInstance };
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
				...(options.workspaceRoot != null
					? { workspaceRoot: options.workspaceRoot }
					: {}),
				...(options.persistenceDbPath != null
					? { persistenceDbPath: options.persistenceDbPath }
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
