// src/lib/provider/provider-registry.ts
// ─── Provider Registry ─────────────────────────────────────────────────────
// Maps provider IDs to scoped provider instances. The OrchestrationEngine uses
// this to route commands to the correct provider instance.

import { Context, Effect, Layer } from "effect";
import { createLogger } from "../logger.js";
import { ProviderNotRegistered } from "./errors.js";
import type { ProviderInstance } from "./types.js";

const log = createLogger("provider-registry");

export class ProviderRegistryTag extends Context.Tag("ProviderRegistry")<
	ProviderRegistryTag,
	ProviderRegistry
>() {}

export const ProviderRegistryLive = (
	instances: Iterable<ProviderInstance> = [],
): Layer.Layer<ProviderRegistryTag> =>
	Layer.effect(
		ProviderRegistryTag,
		Effect.sync(() => new ProviderRegistry(instances)),
	);

export class ProviderRegistry {
	private readonly instances = new Map<string, ProviderInstance>();

	constructor(instances: Iterable<ProviderInstance> = []) {
		for (const instance of instances) {
			this.registerInstance(instance);
		}
	}

	registerInstance(instance: ProviderInstance): void {
		this.instances.set(instance.providerId, instance);
		log.info(`Registered provider instance: ${instance.providerId}`);
	}

	/** Compatibility shim while callers move to registerInstance(). */
	registerAdapter(instance: ProviderInstance): void {
		this.registerInstance(instance);
	}

	/** Get a provider instance by provider ID, or undefined if not registered. */
	getInstance(providerId: string): ProviderInstance | undefined {
		return this.instances.get(providerId);
	}

	/** Compatibility shim while callers move to getInstance(). */
	getAdapter(providerId: string): ProviderInstance | undefined {
		return this.getInstance(providerId);
	}

	/** Get a provider instance by provider ID, failing with a typed Effect error if absent. */
	getInstanceEffect(
		providerId: string,
	): Effect.Effect<ProviderInstance, ProviderNotRegistered> {
		const instance = this.instances.get(providerId);
		return instance
			? Effect.succeed(instance)
			: Effect.fail(new ProviderNotRegistered({ providerId }));
	}

	/** Compatibility shim while callers move to getInstanceEffect(). */
	getAdapterEffect(
		providerId: string,
	): Effect.Effect<ProviderInstance, ProviderNotRegistered> {
		return this.getInstanceEffect(providerId);
	}

	/** Get a provider instance by provider ID, throwing if not registered. */
	getInstanceOrThrow(providerId: string): ProviderInstance {
		const instance = this.instances.get(providerId);
		if (!instance) {
			throw new ProviderNotRegistered({ providerId });
		}
		return instance;
	}

	/** Compatibility shim while callers move to getInstanceOrThrow(). */
	getAdapterOrThrow(providerId: string): ProviderInstance {
		return this.getInstanceOrThrow(providerId);
	}

	/** Check if an instance is registered for the given provider ID. */
	hasInstance(providerId: string): boolean {
		return this.instances.has(providerId);
	}

	/** Compatibility shim while callers move to hasInstance(). */
	hasAdapter(providerId: string): boolean {
		return this.hasInstance(providerId);
	}

	/** Remove a provider instance by provider ID. No-op if not registered. */
	removeInstance(providerId: string): void {
		this.instances.delete(providerId);
	}

	/** Compatibility shim while callers move to removeInstance(). */
	removeAdapter(providerId: string): void {
		this.removeInstance(providerId);
	}

	/** List all registered provider IDs. */
	listProviders(): string[] {
		return [...this.instances.keys()];
	}

	/**
	 * Shutdown all registered provider instances. Continues on individual failures so
	 * cleanup behaves like finalizers: best-effort, logged, never masking caller
	 * shutdown.
	 */
	shutdownAllEffect(): Effect.Effect<void> {
		return Effect.forEach(
			[...this.instances.values()],
			(instance) =>
				instance
					.shutdownEffect()
					.pipe(
						Effect.catchAll((error) =>
							Effect.sync(() =>
								log.warn(`Provider instance shutdown failed: ${error}`),
							),
						),
					),
			{ concurrency: 4, discard: true },
		);
	}
}
