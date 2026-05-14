// src/lib/provider/provider-registry.ts
// ─── Provider Registry ─────────────────────────────────────────────────────
// Maps provider IDs to adapter instances. The OrchestrationEngine uses this
// to route commands to the correct adapter.

import { Context, Effect, Layer } from "effect";
import { createLogger } from "../logger.js";
import { ProviderNotRegistered } from "./errors.js";
import type { ProviderAdapter, ProviderInstance } from "./types.js";

const log = createLogger("provider-registry");

export class ProviderRegistryTag extends Context.Tag("ProviderRegistry")<
	ProviderRegistryTag,
	ProviderRegistry
>() {}

export const ProviderRegistryLive = (
	adapters: Iterable<ProviderInstance> = [],
): Layer.Layer<ProviderRegistryTag> =>
	Layer.effect(
		ProviderRegistryTag,
		Effect.sync(() => new ProviderRegistry(adapters)),
	);

export class ProviderRegistry {
	private readonly adapters = new Map<string, ProviderInstance>();

	constructor(adapters: Iterable<ProviderInstance> = []) {
		for (const adapter of adapters) {
			this.registerInstance(adapter);
		}
	}

	registerInstance(instance: ProviderInstance): void {
		this.adapters.set(instance.providerId, instance);
		log.info(`Registered provider instance: ${instance.providerId}`);
	}

	/** Register an adapter. Overwrites any existing adapter with the same providerId. */
	registerAdapter(adapter: ProviderAdapter): void {
		this.registerInstance(adapter);
	}

	/** Get an adapter by provider ID, or undefined if not registered. */
	getAdapter(providerId: string): ProviderInstance | undefined {
		return this.adapters.get(providerId);
	}

	/** Get an adapter by provider ID, failing with a typed Effect error if absent. */
	getAdapterEffect(
		providerId: string,
	): Effect.Effect<ProviderInstance, ProviderNotRegistered> {
		const adapter = this.adapters.get(providerId);
		return adapter
			? Effect.succeed(adapter)
			: Effect.fail(new ProviderNotRegistered({ providerId }));
	}

	/** Get an adapter by provider ID, throwing if not registered. */
	getAdapterOrThrow(providerId: string): ProviderInstance {
		const adapter = this.adapters.get(providerId);
		if (!adapter) {
			throw new ProviderNotRegistered({ providerId });
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

	/**
	 * Shutdown all registered adapters. Continues on individual failures so
	 * cleanup behaves like finalizers: best-effort, logged, never masking caller
	 * shutdown.
	 */
	shutdownAllEffect(): Effect.Effect<void> {
		return Effect.forEach(
			[...this.adapters.values()],
			(adapter) =>
				adapter
					.shutdownEffect()
					.pipe(
						Effect.catchAll((error) =>
							Effect.sync(() => log.warn(`Adapter shutdown failed: ${error}`)),
						),
					),
			{ concurrency: 4, discard: true },
		);
	}
}
