// ─── Formatting Utilities ────────────────────────────────────────────────────
// Pure functions for text formatting. No DOM or framework dependencies.

/** Escape HTML entities to prevent XSS. */
export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Format bytes into human-readable file size. */
export function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const value = bytes / 1024 ** i;
	return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format a timestamp into a relative time string.
 * E.g. "just now", "2m ago", "3h ago", "Yesterday", "3d ago"
 */
export function formatTimeAgo(
	timestamp: string | number | undefined,
	now?: Date,
): string {
	if (timestamp === undefined) return "";

	const date =
		typeof timestamp === "number" ? new Date(timestamp) : new Date(timestamp);
	const ref = now ?? new Date();
	const diffMs = ref.getTime() - date.getTime();
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHr = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHr / 24);

	if (diffSec < 60) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	if (diffHr < 24) return `${diffHr}h ago`;
	if (diffDay === 1) return "Yesterday";
	if (diffDay < 30) return `${diffDay}d ago`;
	return date.toLocaleDateString();
}

/** Truncate a string to maxLen characters, adding ellipsis if needed. */
export function truncateTitle(title: string, maxLen = 40): string {
	if (title.length <= maxLen) return title;
	return `${title.slice(0, maxLen - 1)}…`;
}

/**
 * Generate a unique ID for messages, tools, etc.
 * Uses crypto.randomUUID if available, falls back to timestamp + random.
 */
export function generateUuid(): string {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Extract display text from a potentially XML-wrapped message.
 * Messages with @file references are sent as XML with <attached-files> and
 * <user-message> tags. This strips the wrapper for display, returning only
 * the user's original message. Non-wrapped text passes through unchanged.
 */
export function extractDisplayText(text: string): string {
	const match = text.match(/<user-message>\n([\s\S]*?)\n<\/user-message>/);
	// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
	return match ? match[1]! : text;
}
