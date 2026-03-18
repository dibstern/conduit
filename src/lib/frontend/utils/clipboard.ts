// ─── Clipboard Utility ───────────────────────────────────────────────────────
// Copy text to clipboard with fallback for older browsers.

/**
 * Copy text to the system clipboard.
 * Uses the modern Clipboard API with textarea fallback.
 * Returns true on success, false on failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	// Modern Clipboard API
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to legacy method
		}
	}

	// Legacy fallback: temporary textarea
	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		textarea.style.left = "-9999px";
		document.body.appendChild(textarea);
		textarea.select();
		const success = document.execCommand("copy");
		document.body.removeChild(textarea);
		return success;
	} catch {
		return false;
	}
}
