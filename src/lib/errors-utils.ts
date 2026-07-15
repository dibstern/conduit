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

const MAX_ERROR_CAUSE_DEPTH = 8;
const GENERIC_EFFECT_ERROR_MESSAGE = "An error has occurred";

function isMeaningfulErrorMessage(message: string): boolean {
	const trimmed = message.trim();
	return trimmed !== "" && trimmed !== GENERIC_EFFECT_ERROR_MESSAGE;
}

function findCauseMessage(error: Error): string {
	let detail = error.message;
	let current: unknown = error.cause;
	const visited = new Set<Error>([error]);

	for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth++) {
		if (typeof current === "string") {
			if (current.trim()) detail = current;
			break;
		}
		if (!(current instanceof Error) || visited.has(current)) break;

		visited.add(current);
		if (isMeaningfulErrorMessage(current.message)) detail = current.message;
		current = current.cause;
	}

	return detail;
}

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
	if (err instanceof Error) {
		return isMeaningfulErrorMessage(err.message)
			? err.message
			: findCauseMessage(err);
	}
	if (typeof err === "string") return err;
	return "Unknown error";
}
