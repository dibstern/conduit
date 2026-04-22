import type { ToolSummarizer } from "./types.js";
import { unknownSummarizer } from "./unknown.js";

// Registry: populated by per-tool modules via registerSummarizer().
const SUMMARIZERS = new Map<string, ToolSummarizer>([
	["Unknown", unknownSummarizer],
]);

/**
 * Look up the summarizer for a tool name.
 * Falls through to Unknown summarizer if no match -- never returns undefined.
 */
export function lookupSummarizer(name: string): ToolSummarizer {
	return SUMMARIZERS.get(name) ?? unknownSummarizer;
}

/** Register a summarizer (used by per-tool modules at import time). */
export function registerSummarizer(summarizer: ToolSummarizer): void {
	SUMMARIZERS.set(summarizer.tool, summarizer);
}
