// test/unit/provider/provider-registry.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAdapterFailure } from "../../../src/lib/provider/errors.js";
import {
	ProviderRegistry,
	ProviderRegistryLive,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";

const REPO_ROOT = process.cwd();

function makeStubInstance(providerId: string): ProviderInstance {
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

	it("registers and retrieves a provider instance", () => {
		const instance = makeStubInstance("opencode");
		registry.registerInstance(instance);

		const retrieved = registry.getInstance("opencode");
		expect(retrieved).toBe(instance);
		expect(registry.hasInstance("opencode")).toBe(true);
	});

	it("returns undefined for unknown provider", () => {
		expect(registry.getInstance("unknown")).toBeUndefined();
	});

	it("lists all registered providers", () => {
		registry.registerInstance(makeStubInstance("opencode"));
		registry.registerInstance(makeStubInstance("claude"));

		const providers = registry.listProviders();
		expect(providers).toEqual(["opencode", "claude"]);
	});

	it("returns empty list when no provider instances are registered", () => {
		expect(registry.listProviders()).toEqual([]);
	});

	it("overwrites provider instance with same providerId", () => {
		const first = makeStubInstance("opencode");
		const second = makeStubInstance("opencode");

		registry.registerInstance(first);
		registry.registerInstance(second);

		expect(registry.getInstance("opencode")).toBe(second);
		expect(registry.listProviders()).toEqual(["opencode"]);
	});

	it("removeInstance removes a registered provider instance", () => {
		registry.registerInstance(makeStubInstance("opencode"));
		registry.removeInstance("opencode");

		expect(registry.getInstance("opencode")).toBeUndefined();
		expect(registry.listProviders()).toEqual([]);
	});

	it("removeInstance is a no-op for unknown provider", () => {
		registry.removeInstance("unknown");
		expect(registry.listProviders()).toEqual([]);
	});

	it("getInstanceOrThrow throws for unknown provider", () => {
		expect(() => registry.getInstanceOrThrow("unknown")).toThrow(
			"No provider instance registered for provider: unknown",
		);
	});

	it("getInstanceOrThrow returns instance for known provider", () => {
		const instance = makeStubInstance("opencode");
		registry.registerInstance(instance);
		expect(registry.getInstanceOrThrow("opencode")).toBe(instance);
	});

	it("shutdownAllEffect calls shutdownEffect on all provider instances", async () => {
		const a1 = makeStubInstance("opencode");
		const a2 = makeStubInstance("claude");
		registry.registerInstance(a1);
		registry.registerInstance(a2);

		await Effect.runPromise(registry.shutdownAllEffect());

		expect(a1.shutdownEffect).toHaveBeenCalledTimes(1);
		expect(a2.shutdownEffect).toHaveBeenCalledTimes(1);
	});

	it("shutdownAllEffect uses the provider instance Effect boundary", async () => {
		const shutdown = vi.fn(() => {
			throw new Error("legacy Promise shutdown should not be called");
		});
		const shutdownEffect = vi.fn(() => Effect.void);
		registry.registerInstance({
			...makeStubInstance("claude"),
			shutdown,
			shutdownEffect,
		} as ProviderInstance & {
			shutdown: typeof shutdown;
			shutdownEffect: typeof shutdownEffect;
		});

		await Effect.runPromise(registry.shutdownAllEffect());

		expect(shutdown).not.toHaveBeenCalled();
		expect(shutdownEffect).toHaveBeenCalledTimes(1);
	});

	it("shutdownAllEffect continues even if one provider instance fails", async () => {
		const a1 = makeStubInstance("opencode");
		const a2 = makeStubInstance("claude");
		(a1.shutdownEffect as ReturnType<typeof vi.fn>).mockReturnValue(
			Effect.fail(
				new ProviderAdapterFailure({
					providerId: "opencode",
					operation: "shutdown",
					cause: new Error("boom"),
				}),
			),
		);
		registry.registerInstance(a1);
		registry.registerInstance(a2);

		// Should not throw
		await Effect.runPromise(registry.shutdownAllEffect());

		expect(a1.shutdownEffect).toHaveBeenCalledTimes(1);
		expect(a2.shutdownEffect).toHaveBeenCalledTimes(1);
	});

	it("provides registered provider instances through the Effect service layer", async () => {
		const instance = makeStubInstance("claude");

		const resolved = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ProviderRegistryTag;
				return yield* service.getInstanceEffect("claude");
			}).pipe(Effect.provide(ProviderRegistryLive([instance]))),
		);

		expect(resolved).toBe(instance);
	});

	it("fails typed Effect lookup when the layer-backed service lacks the instance", async () => {
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ProviderRegistryTag;
				return yield* Effect.exit(service.getInstanceEffect("missing"));
			}).pipe(Effect.provide(ProviderRegistryLive([]))),
		);

		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(exit.cause.toString()).toContain("ProviderNotRegistered");
			expect(exit.cause.toString()).toContain("missing");
		}
	});

	it("creates fresh registry state for fresh Layer acquisitions", async () => {
		const instance = makeStubInstance("claude");
		const layer = ProviderRegistryLive([]);

		const first = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ProviderRegistryTag;
				service.registerInstance(instance);
				return service.hasInstance("claude");
			}).pipe(Effect.provide(Layer.fresh(layer))),
		);

		const second = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ProviderRegistryTag;
				return service.hasInstance("claude");
			}).pipe(Effect.provide(Layer.fresh(layer))),
		);

		expect(first).toBe(true);
		expect(second).toBe(false);
	});

	it("does not expose adapter-named registry shims", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/provider/provider-registry.ts"),
			"utf8",
		);
		expect(source).not.toMatch(
			/\b(?:registerAdapter|getAdapter|getAdapterEffect|getAdapterOrThrow|hasAdapter|removeAdapter)\b/,
		);
	});
});
