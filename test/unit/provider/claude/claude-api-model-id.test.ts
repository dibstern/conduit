import { describe, expect, it } from "vitest";
import {
	claudeApiModelId,
	contextWindowOptionsForModel,
	modelHasSelectable1m,
} from "../../../../src/lib/provider/claude/claude-api-model-id.js";

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
