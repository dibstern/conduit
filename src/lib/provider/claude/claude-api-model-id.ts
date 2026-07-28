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
	// The catalog's "default" entry resolves to whichever model Claude Code
	// recommends, so conduit cannot say which windows it offers. Present and
	// explicitly undefined: no selector, by decision rather than by omission.
	default: undefined,
};

function normalizeModelId(modelId: string): string {
	return modelId
		.toLowerCase()
		.replace(/\[1m\]$/, "")
		.replace(/-\d{8}$/, "");
}

export function contextWindowOptionsForModel(
	modelId: string,
): readonly ContextWindowOption[] | undefined {
	return CONTEXT_WINDOW_OPTIONS_BY_MODEL[normalizeModelId(modelId)];
}

/**
 * Whether the table has a row for this model at all.
 *
 * A row set to `undefined` is a decision — this model has no selectable 1M
 * window. A *missing* key is a gap, and it fails silently twice over: the
 * selector never renders, and `claudeApiModelId` quietly drops a user's "1m"
 * request. Only a caller that sees the live catalog can tell the two apart, so
 * it gets the key-presence check and warns on the gap.
 */
export function hasContextWindowRow(modelId: string): boolean {
	return Object.hasOwn(
		CONTEXT_WINDOW_OPTIONS_BY_MODEL,
		normalizeModelId(modelId),
	);
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
