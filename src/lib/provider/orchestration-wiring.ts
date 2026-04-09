// src/lib/provider/orchestration-wiring.ts
// ─── Orchestration Wiring ───────────────────────────────────────────────────
// Factory function to create the full orchestration layer (registry, adapter,
// engine) from an OpenCodeClient. Used by relay-stack.ts to instantiate the
// provider layer alongside the existing relay pipeline.

import type { OpenCodeClient } from "../instance/opencode-client.js";
import type { OpenCodeEvent } from "../types.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { OrchestrationEngine } from "./orchestration-engine.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { TurnResult } from "./types.js";

export interface OrchestrationLayerOptions {
	readonly client: OpenCodeClient;
	readonly workspaceRoot?: string;
}

export interface OrchestrationLayer {
	readonly engine: OrchestrationEngine;
	readonly registry: ProviderRegistry;
	readonly adapter: OpenCodeAdapter;
	/**
	 * Wire SSE session.status idle events to notifyTurnCompleted().
	 * Must be called once after the SSEConsumer is created so that
	 * OpenCodeAdapter.sendTurn() deferred promises can resolve when
	 * the session transitions to idle.
	 */
	wireSSEToAdapter(
		sseOn: (event: "event", handler: (e: OpenCodeEvent) => void) => void,
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
 * Create the full orchestration layer.
 *
 * Instantiates the ProviderRegistry, registers the OpenCodeAdapter,
 * and creates the OrchestrationEngine. The layer sits alongside the
 * existing relay pipeline -- it doesn't replace it yet.
 */
export function createOrchestrationLayer(
	options: OrchestrationLayerOptions,
): OrchestrationLayer {
	const registry = new ProviderRegistry();

	const adapter = new OpenCodeAdapter({
		client: options.client,
		...(options.workspaceRoot != null
			? { workspaceRoot: options.workspaceRoot }
			: {}),
	});

	registry.registerAdapter(adapter);

	const engine = new OrchestrationEngine({ registry });

	function wireSSEToAdapter(
		sseOn: (event: "event", handler: (e: OpenCodeEvent) => void) => void,
	): void {
		sseOn("event", (event) => {
			if (event.type !== "session.status") return;
			const props = (event as { properties?: Record<string, unknown> })
				.properties;
			const statusType = (props?.["status"] as { type?: string } | undefined)
				?.type;
			if (statusType !== "idle") return;
			const sessionId =
				(props?.["sessionID"] as string | undefined) ??
				(event as { sessionId?: string }).sessionId;
			if (sessionId) {
				adapter.notifyTurnCompleted(sessionId, TURN_COMPLETE_RESULT);
			}
		});
	}

	return { engine, registry, adapter, wireSSEToAdapter };
}
