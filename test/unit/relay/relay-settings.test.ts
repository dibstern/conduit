import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadRelaySettings,
	parseDefaultModel,
	saveRelaySettings,
} from "../../../src/lib/relay/relay-settings.js";

describe("relay-settings", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "relay-settings-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("loadRelaySettings", () => {
		it("returns empty settings when file does not exist", () => {
			const settings = loadRelaySettings(tempDir);
			expect(settings).toEqual({});
		});

		it("parses valid JSON settings", () => {
			writeFileSync(
				join(tempDir, "settings.jsonc"),
				JSON.stringify({ defaultModel: "anthropic/claude-sonnet-4-20250514" }),
			);
			const settings = loadRelaySettings(tempDir);
			expect(settings.defaultModel).toBe("anthropic/claude-sonnet-4-20250514");
		});

		it("strips JSONC comments before parsing", () => {
			writeFileSync(
				join(tempDir, "settings.jsonc"),
				'{\n  // Default model\n  "defaultModel": "openai/gpt-4o" /* inline */\n}',
			);
			const settings = loadRelaySettings(tempDir);
			expect(settings.defaultModel).toBe("openai/gpt-4o");
		});

		it("returns empty settings on corrupt file", () => {
			writeFileSync(join(tempDir, "settings.jsonc"), "not json{{{");
			const settings = loadRelaySettings(tempDir);
			expect(settings).toEqual({});
		});
	});

	describe("saveRelaySettings", () => {
		it("creates the file with correct content", () => {
			saveRelaySettings({ defaultModel: "anthropic/claude-opus-4-6" }, tempDir);
			const content = readFileSync(join(tempDir, "settings.jsonc"), "utf-8");
			expect(JSON.parse(content)).toEqual({
				defaultModel: "anthropic/claude-opus-4-6",
			});
		});

		it("creates the directory if missing", () => {
			const nested = join(tempDir, "nested", "dir");
			saveRelaySettings({ defaultModel: "test/model" }, nested);
			const content = readFileSync(join(nested, "settings.jsonc"), "utf-8");
			expect(JSON.parse(content).defaultModel).toBe("test/model");
		});

		it("overwrites existing settings atomically", () => {
			saveRelaySettings({ defaultModel: "old/model" }, tempDir);
			saveRelaySettings({ defaultModel: "new/model" }, tempDir);
			const settings = loadRelaySettings(tempDir);
			expect(settings.defaultModel).toBe("new/model");
		});
	});

	describe("parseDefaultModel", () => {
		it("splits provider/model string into ModelOverride", () => {
			expect(parseDefaultModel("anthropic/claude-opus-4-6")).toEqual({
				providerID: "anthropic",
				modelID: "claude-opus-4-6",
			});
		});

		it("returns undefined for empty string", () => {
			expect(parseDefaultModel("")).toBeUndefined();
		});

		it("returns undefined for undefined", () => {
			expect(parseDefaultModel(undefined)).toBeUndefined();
		});

		it("returns undefined for string without slash", () => {
			expect(parseDefaultModel("just-model")).toBeUndefined();
		});

		it("returns undefined for string starting with slash", () => {
			expect(parseDefaultModel("/model")).toBeUndefined();
		});

		it("handles model IDs with multiple slashes (e.g. org/sub/model)", () => {
			expect(parseDefaultModel("openai/gpt-4o")).toEqual({
				providerID: "openai",
				modelID: "gpt-4o",
			});
		});
	});

	describe("defaultVariants persistence", () => {
		it("saves and loads defaultVariants", () => {
			saveRelaySettings(
				{
					defaultModel: "anthropic/claude-opus-4-6",
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			const settings = loadRelaySettings(tempDir);
			expect(settings.defaultVariants).toEqual({
				"anthropic/claude-opus-4-6": "high",
			});
		});

		it("preserves defaultVariants when saving only defaultModel", () => {
			saveRelaySettings(
				{
					defaultModel: "anthropic/claude-opus-4-6",
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			// Second save with only defaultModel — should merge, not overwrite
			saveRelaySettings({ defaultModel: "openai/gpt-4o" }, tempDir);
			const settings = loadRelaySettings(tempDir);
			expect(settings.defaultModel).toBe("openai/gpt-4o");
			expect(settings.defaultVariants).toEqual({
				"anthropic/claude-opus-4-6": "high",
			});
		});

		it("merges new defaultVariants entries with existing", () => {
			saveRelaySettings(
				{
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			saveRelaySettings(
				{
					defaultVariants: { "openai/gpt-4o": "medium" },
				},
				tempDir,
			);
			const settings = loadRelaySettings(tempDir);
			expect(settings.defaultVariants).toEqual({
				"anthropic/claude-opus-4-6": "high",
				"openai/gpt-4o": "medium",
			});
		});

		it("overwrites variant for same model key", () => {
			saveRelaySettings(
				{
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			saveRelaySettings(
				{
					defaultVariants: { "anthropic/claude-opus-4-6": "low" },
				},
				tempDir,
			);
			const settings = loadRelaySettings(tempDir);
			expect(settings.defaultVariants?.["anthropic/claude-opus-4-6"]).toBe(
				"low",
			);
		});

		it("returns undefined for missing defaultVariants field", () => {
			saveRelaySettings({ defaultModel: "anthropic/claude-opus-4-6" }, tempDir);
			const settings = loadRelaySettings(tempDir);
			expect(settings.defaultVariants).toBeUndefined();
		});

		it("round-trip: persisted variant survives restart", () => {
			saveRelaySettings(
				{
					defaultModel: "anthropic/claude-opus-4-6",
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			const loaded = loadRelaySettings(tempDir);
			const modelKey = loaded.defaultModel ?? "";
			expect(loaded.defaultVariants?.[modelKey]).toBe("high");
		});
	});

	describe("round-trip: save → load → parse", () => {
		it("persisted default model survives restart", () => {
			saveRelaySettings({ defaultModel: "anthropic/claude-opus-4-6" }, tempDir);
			const loaded = loadRelaySettings(tempDir);
			const parsed = parseDefaultModel(loaded.defaultModel);
			expect(parsed).toEqual({
				providerID: "anthropic",
				modelID: "claude-opus-4-6",
			});
		});
	});
});
