import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

describe("CLAUDE_TRUST_TIERED_SETTINGS_KEYS", () => {
	// Settings has an index signature, and autoMode exists only in the CLI
	// bundle. Check the source literals against the pinned bundle without
	// importing the contract or its runtime dependencies.
	it("names keys the pinned SDK bundle still recognises", () => {
		const contractSource = readFileSync(
			new URL(
				"../../../../src/lib/contracts/claude-settings.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(contractSource).not.toContain("defaultPermissionMode");
		const declaration = contractSource.match(
			/export const CLAUDE_TRUST_TIERED_SETTINGS_KEYS[^=]*=\s*\[([\s\S]*?)\];/,
		)?.[1];
		expect(
			declaration,
			"trust-tiered settings must be a literal list",
		).toBeDefined();
		const keys = Array.from(
			(declaration ?? "").matchAll(/"([^"\n]+)"/g),
			(match) => match[1],
		);
		expect(keys.length).toBeGreaterThan(0);
		const bundle = readFileSync(
			createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
			"utf8",
		);

		for (const key of keys) {
			expect(bundle, `${key} missing from the SDK bundle`).toContain(key);
		}
	});
});
