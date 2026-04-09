// ─── Content Truncation ──────────────────────────────────────────────────────
// Utilities for truncating large tool result content before relay to clients.
// Full content is preserved in the SQLite tool_content table for on-demand fetch.

import type { RelayMessage } from "../shared-types.js";

/** Default truncation threshold in characters (~50KB). */
export const TRUNCATION_THRESHOLD = 50_000;

/** Suffix appended to truncated content. */
const TRUNCATION_SUFFIX = "\n\n[truncated]";

export interface TruncateResult {
	content: string;
	isTruncated: boolean;
	fullContentLength?: number;
}

/**
 * Truncate content if it exceeds the threshold.
 * Returns the (possibly truncated) content, a flag, and the original length
 * when truncated.
 */
export function truncateContent(
	content: string,
	threshold = TRUNCATION_THRESHOLD,
): TruncateResult {
	if (content.length <= threshold) {
		return { content, isTruncated: false };
	}

	// When the threshold is smaller than the suffix, just slice to threshold.
	const suffixFits = threshold > TRUNCATION_SUFFIX.length;
	const truncated = suffixFits
		? content.slice(0, threshold - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
		: content.slice(0, threshold);

	return {
		content: truncated,
		isTruncated: true,
		fullContentLength: content.length,
	};
}

/** A tool_result RelayMessage (narrowed). */
type ToolResultMessage = Extract<RelayMessage, { type: "tool_result" }>;

export interface TruncateToolResultResult {
	/** The (possibly truncated) tool_result message. */
	truncated: ToolResultMessage;
	/** The full original content, or undefined if no truncation occurred. */
	fullContent: string | undefined;
}

/**
 * Process a tool_result RelayMessage, truncating its content if over threshold.
 * Returns the modified message and the full content (if truncated).
 */
export function truncateToolResult(
	msg: ToolResultMessage,
): TruncateToolResultResult {
	const { content, isTruncated, fullContentLength } = truncateContent(
		msg.content,
	);

	if (!isTruncated) {
		return { truncated: msg, fullContent: undefined };
	}

	return {
		truncated: {
			...msg,
			content,
			isTruncated: true,
			...(fullContentLength != null && { fullContentLength }),
		},
		fullContent: msg.content,
	};
}
