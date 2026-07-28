// src/lib/provider/claude/claude-api-model-id.ts
// Pure derivation of the effective Claude API model id from a selected model
// and context-window option. Kept SDK-free so it can be imported by the durable
// command fingerprint canonicalizer without pulling in the Claude Agent SDK.

import type { ContextWindowOption } from "../types.js";

const CONTEXT_WINDOW_OPTIONS_BY_MODEL: Readonly<
	Record<string, readonly ContextWindowOption[] | undefined>
> = {
	"claude-fable-5": [
		{ value: "200k", label: "200k" },
		{ value: "1m", label: "1M", isDefault: true },
	],
	"claude-opus-5": [
		{ value: "200k", label: "200k" },
		{ value: "1m", label: "1M", isDefault: true },
	],
	"claude-opus-4-8": undefined,
	"claude-opus-4-7": undefined,
	"claude-opus-4-6": [
		{ value: "200k", label: "200k" },
		{ value: "1m", label: "1M", isDefault: true },
	],
	"claude-opus-4-5": undefined,
	"claude-sonnet-5": [
		{ value: "200k", label: "200k", isDefault: true },
		{ value: "1m", label: "1M" },
	],
	"claude-sonnet-4-6": [
		{ value: "200k", label: "200k", isDefault: true },
		{ value: "1m", label: "1M" },
	],
	"claude-haiku-4-5": undefined,
};

export function contextWindowOptionsForModel(
	modelId: string,
): readonly ContextWindowOption[] | undefined {
	return CONTEXT_WINDOW_OPTIONS_BY_MODEL[modelId.toLowerCase()];
}

export function modelHasSelectable1m(modelId: string): boolean {
	return (
		contextWindowOptionsForModel(modelId)?.some(
			(option) => option.value === "1m",
		) ?? false
	);
}

export function claudeApiModelId(
	modelId: string | undefined,
	contextWindow: string | undefined,
): string | undefined {
	if (!modelId) return undefined;
	if (contextWindow === "1m" && modelHasSelectable1m(modelId)) {
		return `${modelId}[1m]`;
	}
	return modelId;
}
