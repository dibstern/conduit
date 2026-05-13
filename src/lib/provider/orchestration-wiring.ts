// src/lib/provider/orchestration-wiring.ts
// ─── Orchestration Wiring ───────────────────────────────────────────────────
// Factory function to create the full orchestration layer (registry, adapter,
// engine) from an OpenCodeClient. Used by relay-stack.ts to instantiate the
// provider layer alongside the existing relay pipeline.

import { Context, Effect, Layer } from "effect";
import { OrchestrationEngineTag } from "../effect/services.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import { createLogger } from "../logger.js";
import type { SSEEvent } from "../relay/opencode-events.js";
import { ClaudeAdapter } from "./claude/index.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { OrchestrationEngine } from "./orchestration-engine.js";
import { ProviderRegistry, ProviderRegistryTag } from "./provider-registry.js";
import type { TurnResult } from "./types.js";

const log = createLogger("orchestration-wiring");

export interface OrchestrationLayerOptions {
	readonly client: OpenCodeAPI;
	readonly workspaceRoot?: string;
}

export interface OrchestrationLayer {
	readonly engine: OrchestrationEngine;
	readonly registry: ProviderRegistry;
	readonly adapter: OpenCodeAdapter;
	/**
	 * Wire SSE session.status idle events to notifyTurnCompleted().
	 * Must be called once after the SSEStream is created so that
	 * OpenCodeAdapter.sendTurnEffect() deferred promises can resolve when
	 * the session transitions to idle.
	 */
	wireSSEToAdapter(
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
	readonly adapter: OpenCodeAdapter;
}

class OrchestrationComponentsTag extends Context.Tag("OrchestrationComponents")<
	OrchestrationComponentsTag,
	OrchestrationComponents
>() {}

function createOrchestrationComponents(
	options: OrchestrationLayerOptions,
): OrchestrationComponents {
	const registry = new ProviderRegistry();

	const adapter = new OpenCodeAdapter({
		client: options.client,
		...(options.workspaceRoot != null
			? { workspaceRoot: options.workspaceRoot }
			: {}),
	});

	registry.registerAdapter(adapter);

	const claudeAdapter = new ClaudeAdapter({
		workspaceRoot: options.workspaceRoot ?? process.cwd(),
	});
	registry.registerAdapter(claudeAdapter);

	const engine = new OrchestrationEngine({ registry });

	return { engine, registry, adapter };
}

function createOrchestrationView(
	components: OrchestrationComponents,
): OrchestrationLayer {
	const { adapter, engine, registry } = components;

	function wireSSEToAdapter(
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
					adapter.notifyTurnCompleted(sessionId, TURN_COMPLETE_RESULT);
				} catch (err) {
					log.error(
						`notifyTurnCompleted failed for session ${sessionId}: ${err instanceof Error ? err.message : err}`,
					);
				}
			}
		});
	}

	return { engine, registry, adapter, wireSSEToAdapter };
}

/**
 * Create an imperative view over orchestration components.
 *
 * Kept for narrow unit tests and compatibility surfaces. Production relay
 * wiring uses makeOrchestrationRuntimeLayer() so adapter shutdown is owned by
 * the relay runtime Scope.
 */
export function createOrchestrationLayer(
	options: OrchestrationLayerOptions,
): OrchestrationLayer {
	return createOrchestrationView(createOrchestrationComponents(options));
}

export const makeOrchestrationRuntimeLayer = (
	options: OrchestrationLayerOptions,
): Layer.Layer<ProviderRegistryTag | OrchestrationEngineTag> => {
	const componentsLayer = Layer.scoped(
		OrchestrationComponentsTag,
		Effect.gen(function* () {
			const components = createOrchestrationComponents(options);
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
	const adapter = yield* registry.getAdapterEffect("opencode");
	if (!(adapter instanceof OpenCodeAdapter)) {
		return yield* Effect.dieMessage(
			"opencode provider is not an OpenCodeAdapter",
		);
	}
	return createOrchestrationView({ engine, registry, adapter });
});
