// src/lib/provider/provider-registry.ts
// ─── Provider Registry ─────────────────────────────────────────────────────
// Maps provider IDs to adapter instances. The OrchestrationEngine uses this
// to route commands to the correct adapter.

import { Context, Effect, Layer } from "effect";
import { createLogger } from "../logger.js";
import { ProviderNotRegistered } from "./errors.js";
import type { ProviderAdapter } from "./types.js";

const log = createLogger("provider-registry");

export class ProviderRegistryTag extends Context.Tag("ProviderRegistry")<
	ProviderRegistryTag,
	ProviderRegistry
>() {}

export const ProviderRegistryLive = (
	adapters: Iterable<ProviderAdapter> = [],
): Layer.Layer<ProviderRegistryTag> =>
	Layer.effect(
		ProviderRegistryTag,
		Effect.sync(() => new ProviderRegistry(adapters)),
	);

export class ProviderRegistry {
	private readonly adapters = new Map<string, ProviderAdapter>();

	constructor(adapters: Iterable<ProviderAdapter> = []) {
		for (const adapter of adapters) {
			this.registerAdapter(adapter);
		}
	}

	/** Register an adapter. Overwrites any existing adapter with the same providerId. */
	registerAdapter(adapter: ProviderAdapter): void {
		this.adapters.set(adapter.providerId, adapter);
		log.info(`Registered provider adapter: ${adapter.providerId}`);
	}

	/** Get an adapter by provider ID, or undefined if not registered. */
	getAdapter(providerId: string): ProviderAdapter | undefined {
		return this.adapters.get(providerId);
	}

	/** Get an adapter by provider ID, failing with a typed Effect error if absent. */
	getAdapterEffect(
		providerId: string,
	): Effect.Effect<ProviderAdapter, ProviderNotRegistered> {
		const adapter = this.adapters.get(providerId);
		return adapter
			? Effect.succeed(adapter)
			: Effect.fail(new ProviderNotRegistered({ providerId }));
	}

	/** Get an adapter by provider ID, throwing if not registered. */
	getAdapterOrThrow(providerId: string): ProviderAdapter {
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

	async shutdownAll(): Promise<void> {
		await Effect.runPromise(this.shutdownAllEffect());
	}
}
