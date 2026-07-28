// src/lib/provider/claude/claude-api-model-id.ts
// Pure derivation of the effective Claude API model id from a selected model
// and context-window option. Kept SDK-free so it can be imported by the durable
// command fingerprint canonicalizer without pulling in the Claude Agent SDK.

import type { ContextWindowOption } from "../types.js";

const OPTIONS_1M_DEFAULT: readonly ContextWindowOption[] = [
	{ value: "200k", label: "200k" },
	{ value: "1m", label: "1M", isDefault: true },
];

const OPTIONS_200K_DEFAULT: readonly ContextWindowOption[] = [
	{ value: "200k", label: "200k", isDefault: true },
	{ value: "1m", label: "1M" },
];

const CONTEXT_WINDOW_OPTIONS_BY_MODEL: Readonly<
	Record<string, readonly ContextWindowOption[] | undefined>
> = {
	"claude-fable-5": OPTIONS_1M_DEFAULT,
	"claude-opus-5": OPTIONS_1M_DEFAULT,
	"claude-opus-4-8": undefined,
	"claude-opus-4-7": undefined,
	"claude-opus-4-6": OPTIONS_1M_DEFAULT,
	"claude-opus-4-5": undefined,
	"claude-sonnet-5": OPTIONS_200K_DEFAULT,
	"claude-sonnet-4-6": OPTIONS_200K_DEFAULT,
	"claude-haiku-4-5": undefined,
	opus: OPTIONS_1M_DEFAULT,
	sonnet: OPTIONS_200K_DEFAULT,
	haiku: undefined,
};

export function contextWindowOptionsForModel(
	modelId: string,
): readonly ContextWindowOption[] | undefined {
	const normalizedModelId = modelId
		.toLowerCase()
		.replace(/\[1m\]$/, "")
		.replace(/-\d{8}$/, "");
	return CONTEXT_WINDOW_OPTIONS_BY_MODEL[normalizedModelId];
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
	if (modelId === undefined) return undefined;
	if (contextWindow === undefined || contextWindow === "") return modelId;
	const baseModelId = modelId.replace(/\[1m\]$/i, "");
	if (contextWindow === "1m" && modelHasSelectable1m(baseModelId)) {
		return `${baseModelId}[1m]`;
	}
	return baseModelId;
}

export function expectedClaudeReportedModelId(
	requestedModelId: string | undefined,
	contextWindow: string | undefined,
	catalogModels: readonly {
		readonly id: string;
		readonly resolvedModel?: string;
	}[],
): string | undefined {
	const outboundId = claudeApiModelId(requestedModelId, contextWindow);
	if (outboundId === undefined) return undefined;

	const exactMatch = catalogModels.find((model) => model.id === outboundId);
	if (exactMatch) {
		return exactMatch.resolvedModel || undefined;
	}

	const withoutContextSuffix = (modelId: string): string =>
		modelId.replace(/\[1m\]$/i, "");
	const outboundBaseId = withoutContextSuffix(outboundId);
	const outboundUses1m = outboundBaseId !== outboundId;
	let expectedModel: string | undefined;

	for (const model of catalogModels) {
		if (
			withoutContextSuffix(model.id) !== outboundBaseId ||
			!model.resolvedModel
		) {
			continue;
		}
		const resolvedBaseId = withoutContextSuffix(model.resolvedModel);
		const normalizedResolvedModel = outboundUses1m
			? `${resolvedBaseId}[1m]`
			: resolvedBaseId;
		if (
			expectedModel !== undefined &&
			expectedModel !== normalizedResolvedModel
		) {
			return undefined;
		}
		expectedModel = normalizedResolvedModel;
	}

	return expectedModel;
}
