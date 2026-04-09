// src/lib/provider/orchestration-wiring.ts
// ─── Orchestration Wiring ───────────────────────────────────────────────────
// Factory function to create the full orchestration layer (registry, adapter,
// engine) from an OpenCodeClient. Used by relay-stack.ts to instantiate the
// provider layer alongside the existing relay pipeline.

import type { OpenCodeClient } from "../instance/opencode-client.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { OrchestrationEngine } from "./orchestration-engine.js";
import { ProviderRegistry } from "./provider-registry.js";

export interface OrchestrationLayerOptions {
	readonly client: OpenCodeClient;
	readonly workspaceRoot?: string;
}

export interface OrchestrationLayer {
	readonly engine: OrchestrationEngine;
	readonly registry: ProviderRegistry;
	readonly adapter: OpenCodeAdapter;
}

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

	return { engine, registry, adapter };
}
