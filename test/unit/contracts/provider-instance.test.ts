import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	isKnownDriverKind,
	ProviderInstanceSchema,
} from "../../../src/lib/contracts/provider-instance.js";

describe("provider-instance contracts", () => {
	it("isKnownDriverKind distinguishes the closed known set from unknown strings", () => {
		expect(isKnownDriverKind("claude")).toBe(true);
		expect(isKnownDriverKind("opencode")).toBe(true);
		expect(isKnownDriverKind("gemini")).toBe(false);
		expect(isKnownDriverKind(42)).toBe(false);
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
