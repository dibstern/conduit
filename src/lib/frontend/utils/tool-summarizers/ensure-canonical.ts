import type { CanonicalToolInput } from "../../../persistence/events.js";
// Import OpenCode normalizer as default -- it handles camelCase passthrough
import { normalizeToolInput } from "../../../provider/opencode/normalize-tool-input.js";

/**
 * Ensure input has CanonicalToolInput shape.
 * If input already has a `tool` discriminant, pass through.
 * If input is raw (pre-normalization / historical), normalize it.
 * If input is null/undefined, return Unknown fallback.
 */
export function ensureCanonical(
	name: string,
	input: unknown,
): CanonicalToolInput {
	if (!input || typeof input !== "object") {
		return { tool: "Unknown", name, raw: {} };
	}
	const record = input as Record<string, unknown>;
	if (typeof record["tool"] === "string") {
		return record as unknown as CanonicalToolInput;
	}
	return normalizeToolInput(name, record);
}
