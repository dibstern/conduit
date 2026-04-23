// ─── Error Utility Functions ────────────────────────────────────────────────
// Extracted from errors.ts — pure utility functions used across the codebase.

const SENSITIVE_KEYS = new Set([
	"pin",
	"password",
	"token",
	"secret",
	"authorization",
	"cookie",
]);

/** Redact sensitive values from a context object */
export function redactSensitive(
	obj: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (SENSITIVE_KEYS.has(key.toLowerCase())) {
			result[key] = "[REDACTED]";
		} else if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			result[key] = redactSensitive(value as Record<string, unknown>);
		} else {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Extract a log-safe error detail string from any caught value.
 * For errors with a responseBody property, includes the body for diagnostics.
 */
export function formatErrorDetail(err: unknown): string {
	if (
		err instanceof Error &&
		"responseBody" in err &&
		(err as { responseBody: unknown }).responseBody
	) {
		const body = (err as { responseBody: unknown }).responseBody;
		const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
		return `${err.message} — ${bodyStr}`;
	}
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "Unknown error";
}
