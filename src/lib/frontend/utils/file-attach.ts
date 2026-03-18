// ─── File Attach Utilities ───────────────────────────────────────────────────
// Parse @references from text and build XML-wrapped messages.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileAttachment {
	path: string;
	type: "file" | "directory" | "binary";
	content?: string;
}

// ─── Parse @references ──────────────────────────────────────────────────────

/**
 * Extract all @file references from message text.
 * Matches @ at start of text or after whitespace, followed by a non-space path.
 * Ignores email-like patterns (word@word).
 */
export function parseAtReferences(text: string): string[] {
	const matches = text.matchAll(/(?:^|(?<=\s))@(\S+)/g);
	// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
	return [...matches].map((m) => m[1]!);
}

// ─── Build XML message ──────────────────────────────────────────────────────

/**
 * Build an XML-wrapped message with file attachments.
 * Returns plain text if no attachments are provided.
 */
export function buildAttachedMessage(
	text: string,
	attachments: FileAttachment[],
): string {
	if (attachments.length === 0) return text;

	const fileParts = attachments
		.map((a) => {
			if (a.type === "binary") {
				return `<file path="${a.path}" binary="true" />`;
			}
			if (a.type === "directory") {
				return `<directory path="${a.path}">\n${a.content}\n</directory>`;
			}
			return `<file path="${a.path}">\n${a.content}\n</file>`;
		})
		.join("\n");

	return `<attached-files>\n${fileParts}\n</attached-files>\n\n<user-message>\n${text}\n</user-message>`;
}
