// src/lib/provider/provider-registry.ts
// ─── Provider Registry ─────────────────────────────────────────────────────
// Maps provider IDs to adapter instances. The OrchestrationEngine uses this
// to route commands to the correct adapter.

import { createLogger } from "../logger.js";
import type { ProviderAdapter } from "./types.js";

const log = createLogger("provider-registry");

export class ProviderRegistry {
	private readonly adapters = new Map<string, ProviderAdapter>();

	/** Register an adapter. Overwrites any existing adapter with the same providerId. */
	registerAdapter(adapter: ProviderAdapter): void {
		this.adapters.set(adapter.providerId, adapter);
		log.info(`Registered provider adapter: ${adapter.providerId}`);
	}

	/** Get an adapter by provider ID, or undefined if not registered. */
	getAdapter(providerId: string): ProviderAdapter | undefined {
		return this.adapters.get(providerId);
	}

	/** Get an adapter by provider ID, throwing if not registered. */
	getAdapterOrThrow(providerId: string): ProviderAdapter {
		const adapter = this.adapters.get(providerId);
		if (!adapter) {
			throw new Error(`No adapter registered for provider: ${providerId}`);
		}
		return adapter;
	}

	/** Check if an adapter is registered for the given provider ID. */
	hasAdapter(providerId: string): boolean {
		return this.adapters.has(providerId);
	}

	/** Remove an adapter by provider ID. No-op if not registered. */
	removeAdapter(providerId: string): void {
		this.adapters.delete(providerId);
	}

	/** List all registered provider IDs. */
	listProviders(): string[] {
		return [...this.adapters.keys()];
	}

	/** Shutdown all registered adapters. Continues on individual failures. */
	async shutdownAll(): Promise<void> {
		const results = await Promise.allSettled(
			[...this.adapters.values()].map((adapter) => adapter.shutdown()),
		);
		for (const result of results) {
			if (result.status === "rejected") {
				log.warn(`Adapter shutdown failed: ${result.reason}`);
			}
		}
	}
}
