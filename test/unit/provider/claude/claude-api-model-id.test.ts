import { describe, expect, it } from "vitest";
import {
	claudeApiModelId,
	contextWindowOptionsForModel,
	expectedClaudeReportedModelId,
	hasContextWindowRow,
	modelHasSelectable1m,
} from "../../../../src/lib/provider/claude/claude-api-model-id.js";

describe("hasContextWindowRow", () => {
	// A row set to undefined is a decision; a missing key is a gap that fails
	// silently twice (no selector renders, and a requested 1M is dropped).
	it.each([
		"claude-opus-5",
		"claude-haiku-4-5",
		"opus",
		"haiku",
		"default",
	])("reports a row for the catalogued id %s", (modelId) => {
		expect(hasContextWindowRow(modelId)).toBe(true);
	});

	it("normalizes the same way the lookup does", () => {
		expect(hasContextWindowRow("opus[1m]")).toBe(true);
		expect(hasContextWindowRow("OPUS")).toBe(true);
		expect(hasContextWindowRow("claude-haiku-4-5-20251001")).toBe(true);
	});

	it("reports no row for an id the table has never seen", () => {
		expect(hasContextWindowRow("claude-opus-9")).toBe(false);
		expect(hasContextWindowRow("gpt-5")).toBe(false);
	});

	it("distinguishes a missing row from an explicitly undefined one", () => {
		expect(contextWindowOptionsForModel("haiku")).toBeUndefined();
		expect(contextWindowOptionsForModel("claude-opus-9")).toBeUndefined();
		expect(hasContextWindowRow("haiku")).toBe(true);
		expect(hasContextWindowRow("claude-opus-9")).toBe(false);
	});
});

describe("Claude context-window model capabilities", () => {
	const options1mDefault = [
		{ value: "200k", label: "200k" },
		{ value: "1m", label: "1M", isDefault: true },
	];
	const options200kDefault = [
		{ value: "200k", label: "200k", isDefault: true },
		{ value: "1m", label: "1M" },
	];

	it.each([
		"claude-fable-5",
		"claude-opus-5",
		"claude-opus-4-6",
		"claude-sonnet-5",
		"claude-sonnet-4-6",
	])("%s exposes a selectable 1M option", (modelId) => {
		expect(contextWindowOptionsForModel(modelId)).toContainEqual({
			value: "1m",
			label: "1M",
			...(modelId.startsWith("claude-opus") || modelId === "claude-fable-5"
				? { isDefault: true }
				: {}),
		});
		expect(modelHasSelectable1m(modelId)).toBe(true);
		expect(claudeApiModelId(modelId, "1m")).toBe(`${modelId}[1m]`);
	});

	it.each([
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-opus-4-5",
		"claude-haiku-4-5",
		"claude-sonnet-4-5",
	])("%s has no selectable 1M option or suffix", (modelId) => {
		expect(contextWindowOptionsForModel(modelId)).toBeUndefined();
		expect(modelHasSelectable1m(modelId)).toBe(false);
		expect(claudeApiModelId(modelId, "1m")).toBe(modelId);
	});

	it("keeps the base model id for non-1M selections", () => {
		expect(claudeApiModelId("claude-sonnet-5", "200k")).toBe("claude-sonnet-5");
		expect(claudeApiModelId("claude-sonnet-5", undefined)).toBe(
			"claude-sonnet-5",
		);
		expect(claudeApiModelId(undefined, "1m")).toBeUndefined();
	});

	it.each([
		["opus", options1mDefault, true],
		["sonnet", options200kDefault, true],
		["default", undefined, false],
		["haiku", undefined, false],
		["opus[1m]", options1mDefault, true],
		["claude-fable-5[1m]", options1mDefault, true],
		["claude-haiku-4-5-20251001", undefined, false],
		["claude-haiku-4-5-20251001[1m]", undefined, false],
		["claude-sonnet-5-20260101", options200kDefault, true],
		["OPUS[1M]", options1mDefault, true],
	] as const)("normalizes %s to its context-window capability", (modelId, expectedOptions, expectedSelectable1m) => {
		expect(contextWindowOptionsForModel(modelId)).toEqual(expectedOptions);
		expect(modelHasSelectable1m(modelId)).toBe(expectedSelectable1m);
	});

	it.each([
		["sonnet", "1m", "sonnet[1m]"],
		["sonnet", "200k", "sonnet"],
		["sonnet", undefined, "sonnet"],
		["opus", "1m", "opus[1m]"],
		["opus", "200k", "opus"],
		["opus[1m]", "1m", "opus[1m]"],
		["opus[1m]", "200k", "opus"],
		["opus[1m]", undefined, "opus[1m]"],
		["claude-sonnet-5", "1m", "claude-sonnet-5[1m]"],
		["claude-sonnet-5[1m]", "200k", "claude-sonnet-5"],
		["claude-fable-5[1m]", "1m", "claude-fable-5[1m]"],
		["claude-fable-5[1m]", "200k", "claude-fable-5"],
		["haiku", "1m", "haiku"],
		["haiku[1m]", "1m", "haiku"],
		["haiku[1m]", undefined, "haiku[1m]"],
		["claude-haiku-4-5-20251001", "1m", "claude-haiku-4-5-20251001"],
		[undefined, "1m", undefined],
	] as const)("derives the API model id from %s with %s context", (modelId, contextWindow, expected) => {
		expect(claudeApiModelId(modelId, contextWindow)).toBe(expected);
	});
});

describe("expectedClaudeReportedModelId", () => {
	const probedCatalog = [
		{ id: "default", resolvedModel: "claude-opus-5[1m]" },
		{ id: "opus[1m]", resolvedModel: "claude-opus-5[1m]" },
		{ id: "claude-fable-5[1m]", resolvedModel: "claude-fable-5" },
		{ id: "sonnet", resolvedModel: "claude-sonnet-5" },
		{ id: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
	] as const;

	it.each([
		["default", undefined, "claude-opus-5[1m]"],
		["opus[1m]", undefined, "claude-opus-5[1m]"],
		["claude-fable-5[1m]", undefined, "claude-fable-5"],
		["sonnet", undefined, "claude-sonnet-5"],
		["haiku", undefined, "claude-haiku-4-5-20251001"],
		["sonnet", "1m", "claude-sonnet-5[1m]"],
		["opus", undefined, "claude-opus-5"],
		["haiku[1m]", undefined, "claude-haiku-4-5-20251001[1m]"],
		["claude-fable-5[1m]", undefined, "claude-fable-5"],
	] as const)("maps requested %s with %s context to the probed report %s", (requestedModelId, contextWindow, expected) => {
		expect(
			expectedClaudeReportedModelId(
				requestedModelId,
				contextWindow,
				probedCatalog,
			),
		).toBe(expected);
	});

	it("returns undefined without a requested id", () => {
		expect(
			expectedClaudeReportedModelId(undefined, "1m", probedCatalog),
		).toBeUndefined();
	});

	it("returns undefined for an empty catalog", () => {
		expect(
			expectedClaudeReportedModelId("sonnet", undefined, []),
		).toBeUndefined();
	});

	it("does not infer from an exact catalog id without resolvedModel", () => {
		expect(
			expectedClaudeReportedModelId("sonnet", undefined, [{ id: "sonnet" }]),
		).toBeUndefined();
	});

	it("ignores a suffix-equivalent entry without resolvedModel", () => {
		expect(
			expectedClaudeReportedModelId("opus", undefined, [{ id: "opus[1m]" }]),
		).toBeUndefined();
	});

	it("returns undefined for conflicting suffix-equivalent results", () => {
		expect(
			expectedClaudeReportedModelId("sonnet", "1m", [
				{ id: "sonnet", resolvedModel: "claude-sonnet-5" },
				{ id: "sonnet[1M]", resolvedModel: "claude-sonnet-4-6[1m]" },
			]),
		).toBeUndefined();
	});

	it("accepts identical normalized suffix-equivalent results", () => {
		expect(
			expectedClaudeReportedModelId("sonnet", "1m", [
				{ id: "sonnet", resolvedModel: "claude-sonnet-5" },
				{ id: "sonnet[1M]", resolvedModel: "claude-sonnet-5[1m]" },
			]),
		).toBe("claude-sonnet-5[1m]");
	});

	it("removes a requested 1M suffix for a 200k override", () => {
		expect(
			expectedClaudeReportedModelId("sonnet[1m]", "200k", [
				{ id: "sonnet[1m]", resolvedModel: "claude-sonnet-5[1m]" },
			]),
		).toBe("claude-sonnet-5");
	});

	it("gives an exact Fable entry precedence over suffix-equivalent candidates", () => {
		expect(
			expectedClaudeReportedModelId("claude-fable-5[1m]", undefined, [
				{
					id: "claude-fable-5[1m]",
					resolvedModel: "claude-fable-5",
				},
				{
					id: "claude-fable-5",
					resolvedModel: "claude-fable-5[1m]",
				},
			]),
		).toBe("claude-fable-5");
	});
});
