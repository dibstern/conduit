import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadGlobalSettings,
	parseDefaultModel,
	saveGlobalSettings,
} from "../../../src/lib/daemon/global-settings.js";

describe("global-settings", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "global-settings-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("loadGlobalSettings", () => {
		it("returns empty settings when file does not exist", () => {
			const settings = loadGlobalSettings(tempDir);
			expect(settings).toEqual({});
		});

		it("parses valid JSON settings", () => {
			writeFileSync(
				join(tempDir, "settings.jsonc"),
				JSON.stringify({ defaultModel: "anthropic/claude-sonnet-4-20250514" }),
			);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.defaultModel).toBe("anthropic/claude-sonnet-4-20250514");
		});

		it("strips JSONC comments before parsing", () => {
			writeFileSync(
				join(tempDir, "settings.jsonc"),
				'{\n  // Default model\n  "defaultModel": "openai/gpt-4o" /* inline */\n}',
			);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.defaultModel).toBe("openai/gpt-4o");
		});

		it("returns empty settings on corrupt file", () => {
			writeFileSync(join(tempDir, "settings.jsonc"), "not json{{{");
			const settings = loadGlobalSettings(tempDir);
			expect(settings).toEqual({});
		});
	});

	describe("saveGlobalSettings", () => {
		it("creates the file with correct content", () => {
			saveGlobalSettings(
				{ defaultModel: "anthropic/claude-opus-4-6" },
				tempDir,
			);
			const content = readFileSync(join(tempDir, "settings.jsonc"), "utf-8");
			expect(JSON.parse(content)).toEqual({
				defaultModel: "anthropic/claude-opus-4-6",
			});
		});

		it("creates the directory if missing", () => {
			const nested = join(tempDir, "nested", "dir");
			saveGlobalSettings({ defaultModel: "test/model" }, nested);
			const content = readFileSync(join(nested, "settings.jsonc"), "utf-8");
			expect(JSON.parse(content).defaultModel).toBe("test/model");
		});

		it("overwrites existing settings atomically", () => {
			saveGlobalSettings({ defaultModel: "old/model" }, tempDir);
			saveGlobalSettings({ defaultModel: "new/model" }, tempDir);
			const settings = loadGlobalSettings(tempDir);
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
			saveGlobalSettings(
				{
					defaultModel: "anthropic/claude-opus-4-6",
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.defaultVariants).toEqual({
				"anthropic/claude-opus-4-6": "high",
			});
		});

		it("preserves defaultVariants when saving only defaultModel", () => {
			saveGlobalSettings(
				{
					defaultModel: "anthropic/claude-opus-4-6",
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			// Second save with only defaultModel — should merge, not overwrite
			saveGlobalSettings({ defaultModel: "openai/gpt-4o" }, tempDir);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.defaultModel).toBe("openai/gpt-4o");
			expect(settings.defaultVariants).toEqual({
				"anthropic/claude-opus-4-6": "high",
			});
		});

		it("merges new defaultVariants entries with existing", () => {
			saveGlobalSettings(
				{
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			saveGlobalSettings(
				{
					defaultVariants: { "openai/gpt-4o": "medium" },
				},
				tempDir,
			);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.defaultVariants).toEqual({
				"anthropic/claude-opus-4-6": "high",
				"openai/gpt-4o": "medium",
			});
		});

		it("overwrites variant for same model key", () => {
			saveGlobalSettings(
				{
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			saveGlobalSettings(
				{
					defaultVariants: { "anthropic/claude-opus-4-6": "low" },
				},
				tempDir,
			);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.defaultVariants?.["anthropic/claude-opus-4-6"]).toBe(
				"low",
			);
		});

		it("returns undefined for missing defaultVariants field", () => {
			saveGlobalSettings(
				{ defaultModel: "anthropic/claude-opus-4-6" },
				tempDir,
			);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.defaultVariants).toBeUndefined();
		});

		it("round-trip: persisted variant survives restart", () => {
			saveGlobalSettings(
				{
					defaultModel: "anthropic/claude-opus-4-6",
					defaultVariants: { "anthropic/claude-opus-4-6": "high" },
				},
				tempDir,
			);
			const loaded = loadGlobalSettings(tempDir);
			const modelKey = loaded.defaultModel ?? "";
			expect(loaded.defaultVariants?.[modelKey]).toBe("high");
		});
	});

	describe("defaultPermissionMode persistence", () => {
		it("drops a hand-edited mode the rest of the system cannot interpret", () => {
			writeFileSync(
				join(tempDir, "settings.jsonc"),
				JSON.stringify({
					defaultModel: "openai/gpt-4o",
					defaultPermissionMode: "Full access",
				}),
			);

			const settings = loadGlobalSettings(tempDir);

			expect(settings.defaultPermissionMode).toBeUndefined();
			expect(settings.defaultModel).toBe("openai/gpt-4o");
		});

		it("keeps every mode the approvals picker offers", () => {
			for (const mode of ["ask", "acceptEdits", "auto", "full"] as const) {
				writeFileSync(
					join(tempDir, "settings.jsonc"),
					JSON.stringify({ defaultPermissionMode: mode }),
				);
				expect(loadGlobalSettings(tempDir).defaultPermissionMode).toBe(mode);
			}
		});

		it("round-trips without replacing other persisted fields", () => {
			saveGlobalSettings(
				{
					defaultModel: "claude/claude-sonnet-4-7",
					defaultVariants: { "claude/claude-sonnet-4-7": "high" },
					hiddenModels: ["openai/gpt-4o"],
					claudeSettings: { autoCompactEnabled: false },
				},
				tempDir,
			);

			saveGlobalSettings({ defaultPermissionMode: "auto" }, tempDir);

			expect(loadGlobalSettings(tempDir)).toEqual({
				defaultModel: "claude/claude-sonnet-4-7",
				defaultPermissionMode: "auto",
				defaultVariants: { "claude/claude-sonnet-4-7": "high" },
				hiddenModels: ["openai/gpt-4o"],
				claudeSettings: { autoCompactEnabled: false },
			});
		});
	});

	// Failure cases: invalid hand edits must not leak an unknown mode; saving a
	// session default must retain the other persisted defaults and survive reload.
	describe("defaultSessionMode persistence", () => {
		it("drops invalid modes while preserving other persisted fields", () => {
			writeFileSync(
				join(tempDir, "settings.jsonc"),
				JSON.stringify({
					defaultSessionMode: "sometimes",
					defaultPermissionMode: "auto",
				}),
			);
			expect(loadGlobalSettings(tempDir)).toEqual({
				defaultPermissionMode: "auto",
			});
		});

		it.each([
			"local",
			"worktree",
		] as const)("round-trips %s without replacing other persisted fields", (mode) => {
			saveGlobalSettings({ defaultModel: "openai/gpt-4o" }, tempDir);
			saveGlobalSettings({ defaultSessionMode: mode }, tempDir);
			expect(loadGlobalSettings(tempDir)).toEqual({
				defaultModel: "openai/gpt-4o",
				defaultSessionMode: mode,
			});
		});
	});

	describe("round-trip: save → load → parse", () => {
		it("persisted default model survives restart", () => {
			saveGlobalSettings(
				{ defaultModel: "anthropic/claude-opus-4-6" },
				tempDir,
			);
			const loaded = loadGlobalSettings(tempDir);
			const parsed = parseDefaultModel(loaded.defaultModel);
			expect(parsed).toEqual({
				providerID: "anthropic",
				modelID: "claude-opus-4-6",
			});
		});
	});

	describe("hidden entries persistence", () => {
		it("saves and loads hiddenModels and hiddenAgents", () => {
			saveGlobalSettings(
				{
					hiddenModels: ["openai/gpt-4o", "claude/claude-haiku-4"],
					hiddenAgents: ["opencode/plan"],
				},
				tempDir,
			);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.hiddenModels).toEqual([
				"openai/gpt-4o",
				"claude/claude-haiku-4",
			]);
			expect(settings.hiddenAgents).toEqual(["opencode/plan"]);
		});

		it("replaces (not merges) hidden lists on save", () => {
			saveGlobalSettings({ hiddenModels: ["a/b", "c/d"] }, tempDir);
			saveGlobalSettings({ hiddenModels: ["e/f"] }, tempDir);
			expect(loadGlobalSettings(tempDir).hiddenModels).toEqual(["e/f"]);
		});

		it("clears a hidden list when saving an empty array", () => {
			saveGlobalSettings({ hiddenAgents: ["opencode/plan"] }, tempDir);
			saveGlobalSettings({ hiddenAgents: [] }, tempDir);
			expect(loadGlobalSettings(tempDir).hiddenAgents).toEqual([]);
		});

		it("preserves hidden lists when saving unrelated fields", () => {
			saveGlobalSettings({ hiddenModels: ["a/b"] }, tempDir);
			saveGlobalSettings({ defaultModel: "openai/gpt-4o" }, tempDir);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.hiddenModels).toEqual(["a/b"]);
			expect(settings.defaultModel).toBe("openai/gpt-4o");
		});

		it("preserves defaultModel/defaultVariants when saving hidden lists", () => {
			saveGlobalSettings(
				{
					defaultModel: "openai/gpt-4o",
					defaultVariants: { "openai/gpt-4o": "high" },
				},
				tempDir,
			);
			saveGlobalSettings({ hiddenModels: ["a/b"] }, tempDir);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.defaultModel).toBe("openai/gpt-4o");
			expect(settings.defaultVariants).toEqual({ "openai/gpt-4o": "high" });
			expect(settings.hiddenModels).toEqual(["a/b"]);
		});

		it("returns undefined hidden lists when never saved", () => {
			saveGlobalSettings({ defaultModel: "a/b" }, tempDir);
			const settings = loadGlobalSettings(tempDir);
			expect(settings.hiddenModels).toBeUndefined();
			expect(settings.hiddenAgents).toBeUndefined();
		});
	});

	describe("Claude settings overrides persistence", () => {
		it("round-trips and replaces the open JSON-valued record", () => {
			saveGlobalSettings(
				{
					claudeSettings: {
						autoCompactEnabled: false,
						attribution: { commit: "Generated by Conduit" },
					},
				},
				tempDir,
			);
			saveGlobalSettings(
				{ claudeSettings: { alwaysThinkingEnabled: true } },
				tempDir,
			);

			expect(loadGlobalSettings(tempDir).claudeSettings).toEqual({
				alwaysThinkingEnabled: true,
			});
		});
	});
});
