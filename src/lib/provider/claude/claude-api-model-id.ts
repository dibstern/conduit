// src/lib/provider/claude/claude-api-model-id.ts
// Pure derivation of the effective Claude API model id from a selected model
// and context-window option. Kept SDK-free so it can be imported by the durable
// command fingerprint canonicalizer without pulling in the Claude Agent SDK.

export function supportsMillionTokenContext(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return normalized === "sonnet" || /^claude-.*sonnet(?:-|$)/.test(normalized);
}

export function claudeApiModelId(
	modelId: string | undefined,
	contextWindow: string | undefined,
): string | undefined {
	if (!modelId) return undefined;
	if (contextWindow === "1m" && supportsMillionTokenContext(modelId)) {
		return `${modelId}[1m]`;
	}
	return modelId;
}
