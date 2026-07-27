import { describe, expect, it } from "vitest";
import {
	claudeApiModelId,
	contextWindowOptionsForModel,
	modelHasSelectable1m,
} from "../../../../src/lib/provider/claude/claude-api-model-id.js";

describe("Claude context-window model capabilities", () => {
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
});
