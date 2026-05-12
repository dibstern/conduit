// test/unit/provider/provider-registry.test.ts

import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAdapterFailure } from "../../../src/lib/provider/errors.js";
import {
	ProviderRegistry,
	ProviderRegistryLive,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import type { ProviderAdapter } from "../../../src/lib/provider/types.js";

function makeStubAdapter(providerId: string): ProviderAdapter {
	return {
		providerId,
		discoverEffect: vi.fn(() =>
			Effect.succeed({
				models: [],
				supportsTools: false,
				supportsThinking: false,
				supportsPermissions: false,
				supportsQuestions: false,
				supportsAttachments: false,
				supportsFork: false,
				supportsRevert: false,
				commands: [],
			}),
		),
		sendTurnEffect: vi.fn(() => Effect.die("not implemented")),
		interruptTurnEffect: vi.fn(() => Effect.void),
		resolvePermissionEffect: vi.fn(() => Effect.void),
		resolveQuestionEffect: vi.fn(() => Effect.void),
		shutdownEffect: vi.fn(() => Effect.void),
		endSessionEffect: vi.fn(() => Effect.void),
	};
}

describe("ProviderRegistry", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		registry = new ProviderRegistry();
	});

	it("registers and retrieves an adapter", () => {
		const adapter = makeStubAdapter("opencode");
		registry.registerAdapter(adapter);

		const retrieved = registry.getAdapter("opencode");
		expect(retrieved).toBe(adapter);
	});

	it("returns undefined for unknown provider", () => {
		expect(registry.getAdapter("unknown")).toBeUndefined();
	});

	it("lists all registered providers", () => {
		registry.registerAdapter(makeStubAdapter("opencode"));
		registry.registerAdapter(makeStubAdapter("claude"));

		const providers = registry.listProviders();
		expect(providers).toEqual(["opencode", "claude"]);
	});

	it("returns empty list when no adapters registered", () => {
		expect(registry.listProviders()).toEqual([]);
	});

	it("overwrites adapter with same providerId", () => {
		const first = makeStubAdapter("opencode");
		const second = makeStubAdapter("opencode");

		registry.registerAdapter(first);
		registry.registerAdapter(second);

		expect(registry.getAdapter("opencode")).toBe(second);
		expect(registry.listProviders()).toEqual(["opencode"]);
	});

	it("hasAdapter returns true for registered adapter", () => {
		registry.registerAdapter(makeStubAdapter("opencode"));
		expect(registry.hasAdapter("opencode")).toBe(true);
		expect(registry.hasAdapter("claude")).toBe(false);
	});

	it("removeAdapter removes a registered adapter", () => {
		registry.registerAdapter(makeStubAdapter("opencode"));
		registry.removeAdapter("opencode");

		expect(registry.getAdapter("opencode")).toBeUndefined();
		expect(registry.listProviders()).toEqual([]);
	});

	it("removeAdapter is a no-op for unknown provider", () => {
		registry.removeAdapter("unknown"); // Should not throw
		expect(registry.listProviders()).toEqual([]);
	});

	it("getAdapterOrThrow throws for unknown provider", () => {
		expect(() => registry.getAdapterOrThrow("unknown")).toThrow(
			"No adapter registered for provider: unknown",
		);
	});

	it("getAdapterOrThrow returns adapter for known provider", () => {
		const adapter = makeStubAdapter("opencode");
		registry.registerAdapter(adapter);
		expect(registry.getAdapterOrThrow("opencode")).toBe(adapter);
	});

	it("shutdownAll calls shutdownEffect on all adapters", async () => {
		const a1 = makeStubAdapter("opencode");
		const a2 = makeStubAdapter("claude");
		registry.registerAdapter(a1);
		registry.registerAdapter(a2);

		await registry.shutdownAll();

		expect(a1.shutdownEffect).toHaveBeenCalledTimes(1);
		expect(a2.shutdownEffect).toHaveBeenCalledTimes(1);
	});

	it("shutdownAll uses the adapter Effect boundary", async () => {
		const shutdown = vi.fn(() => {
			throw new Error("legacy Promise shutdown should not be called");
		});
		const shutdownEffect = vi.fn(() => Effect.void);
		registry.registerAdapter({
			...makeStubAdapter("claude"),
			shutdown,
			shutdownEffect,
		} as ProviderAdapter & {
			shutdown: typeof shutdown;
			shutdownEffect: typeof shutdownEffect;
		});

		await registry.shutdownAll();

		expect(shutdown).not.toHaveBeenCalled();
		expect(shutdownEffect).toHaveBeenCalledTimes(1);
	});

	it("shutdownAll continues even if one adapter fails", async () => {
		const a1 = makeStubAdapter("opencode");
		const a2 = makeStubAdapter("claude");
		(a1.shutdownEffect as ReturnType<typeof vi.fn>).mockReturnValue(
			Effect.fail(
				new ProviderAdapterFailure({
					providerId: "opencode",
					operation: "shutdown",
					cause: new Error("boom"),
				}),
			),
		);
		registry.registerAdapter(a1);
		registry.registerAdapter(a2);

		// Should not throw
		await registry.shutdownAll();

		expect(a1.shutdownEffect).toHaveBeenCalledTimes(1);
		expect(a2.shutdownEffect).toHaveBeenCalledTimes(1);
	});

	it("provides registered adapters through the Effect service layer", async () => {
		const adapter = makeStubAdapter("claude");

		const resolved = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ProviderRegistryTag;
				return yield* service.getAdapterEffect("claude");
			}).pipe(Effect.provide(ProviderRegistryLive([adapter]))),
		);

		expect(resolved).toBe(adapter);
	});

	it("fails typed Effect lookup when the layer-backed service lacks the adapter", async () => {
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ProviderRegistryTag;
				return yield* Effect.exit(service.getAdapterEffect("missing"));
			}).pipe(Effect.provide(ProviderRegistryLive([]))),
		);

		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(exit.cause.toString()).toContain("ProviderNotRegistered");
			expect(exit.cause.toString()).toContain("missing");
		}
	});

	it("creates fresh registry state for fresh Layer acquisitions", async () => {
		const adapter = makeStubAdapter("claude");
		const layer = ProviderRegistryLive([]);

		const first = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ProviderRegistryTag;
				service.registerAdapter(adapter);
				return service.hasAdapter("claude");
			}).pipe(Effect.provide(Layer.fresh(layer))),
		);

		const second = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ProviderRegistryTag;
				return service.hasAdapter("claude");
			}).pipe(Effect.provide(Layer.fresh(layer))),
		);

		expect(first).toBe(true);
		expect(second).toBe(false);
	});
});
