import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	isKnownDriverKind,
	PROVIDER_DRIVERS,
	ProviderInstanceSchema,
} from "../../../src/lib/contracts/provider-instance.js";

describe("provider-instance contracts", () => {
	it.each([
		["claude", "native"],
		["opencode", "queue"],
		["cursor", "native"],
	] as const)("%s pins steering to %s and keeps prompts volatile", (driver, steering) => {
		expect(PROVIDER_DRIVERS[driver].steering).toBe(steering);
		expect(PROVIDER_DRIVERS[driver].promptsSurviveRestart).toBe(false);
	});

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
