import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	defaultInstanceIdForDriver,
	InstanceModelSelectionSchema,
	isKnownDriverKind,
	ProviderInstanceSchema,
} from "../../../src/lib/contracts/provider-instance.js";

describe("provider-instance contracts", () => {
	it("defaultInstanceIdForDriver is the identity mapping for known drivers", () => {
		expect(defaultInstanceIdForDriver("claude")).toBe("claude");
		expect(defaultInstanceIdForDriver("opencode")).toBe("opencode");
	});

	it("isKnownDriverKind distinguishes the closed known set from unknown strings", () => {
		expect(isKnownDriverKind("claude")).toBe(true);
		expect(isKnownDriverKind("opencode")).toBe(true);
		expect(isKnownDriverKind("gemini")).toBe(false);
		expect(isKnownDriverKind(42)).toBe(false);
	});

	it("decodes the legacy { provider, model } selection to { instanceId, model }", () => {
		const decode = Schema.decodeUnknownSync(InstanceModelSelectionSchema);
		expect(decode({ provider: "claude", model: "claude-sonnet-4-5" })).toEqual({
			instanceId: "claude",
			model: "claude-sonnet-4-5",
		});
		// The instance-native wire shape passes through unchanged.
		expect(decode({ instanceId: "opencode", model: "grok-code" })).toEqual({
			instanceId: "opencode",
			model: "grok-code",
		});
	});

	it("decodes a ProviderInstance with an unknown driver kind without throwing", () => {
		const decode = Schema.decodeUnknownSync(ProviderInstanceSchema);
		expect(() =>
			decode({
				id: "gemini",
				name: "Gemini",
				driver: "gemini",
				available: false,
				models: [],
				agents: [],
				displayName: "Gemini",
				status: "error",
			}),
		).not.toThrow();
	});
});
