// test/unit/provider/provider-registry.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderAdapter } from "../../../src/lib/provider/types.js";

function makeStubAdapter(providerId: string): ProviderAdapter {
	return {
		providerId,
		discover: vi.fn(async () => ({
			models: [],
			supportsTools: false,
			supportsThinking: false,
			supportsPermissions: false,
			supportsQuestions: false,
			supportsAttachments: false,
			supportsFork: false,
			supportsRevert: false,
			commands: [],
		})),
		sendTurn: vi.fn(),
		interruptTurn: vi.fn(),
		resolvePermission: vi.fn(),
		resolveQuestion: vi.fn(),
		shutdown: vi.fn(),
		endSession: vi.fn(),
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

	it("shutdownAll calls shutdown on all adapters", async () => {
		const a1 = makeStubAdapter("opencode");
		const a2 = makeStubAdapter("claude");
		registry.registerAdapter(a1);
		registry.registerAdapter(a2);

		await registry.shutdownAll();

		expect(a1.shutdown).toHaveBeenCalledTimes(1);
		expect(a2.shutdown).toHaveBeenCalledTimes(1);
	});

	it("shutdownAll continues even if one adapter fails", async () => {
		const a1 = makeStubAdapter("opencode");
		const a2 = makeStubAdapter("claude");
		// biome-ignore lint/suspicious/noExplicitAny: accessing vi.fn mock method
		(a1.shutdown as any).mockRejectedValue(new Error("boom"));
		registry.registerAdapter(a1);
		registry.registerAdapter(a2);

		// Should not throw
		await registry.shutdownAll();

		expect(a1.shutdown).toHaveBeenCalledTimes(1);
		expect(a2.shutdown).toHaveBeenCalledTimes(1);
	});
});
