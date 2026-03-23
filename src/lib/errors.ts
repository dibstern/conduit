// ─── Error Handling Foundation (Ticket 0.5, 6.2) ─────────────────────────────

import type { RelayMessage } from "./shared-types.js";

const SENSITIVE_KEYS = new Set([
	"pin",
	"password",
	"token",
	"secret",
	"authorization",
	"cookie",
]);

// ─── Error Codes (AC3) ──────────────────────────────────────────────────────
// Standard error codes for common failure scenarios. Extensible — add new
// codes as needed, but prefer reusing existing ones for consistency.

export type ErrorCode =
	| "AUTH_REQUIRED"
	| "AUTH_FAILED"
	| "SESSION_NOT_FOUND"
	| "SESSION_CREATE_FAILED"
	| "SESSION_ERROR"
	| "PROMPT_FAILED"
	| "SEND_FAILED"
	| "MODEL_SWITCH_FAILED"
	| "MODEL_ERROR"
	| "AGENT_SWITCH_FAILED"
	| "FILE_NOT_FOUND"
	| "FILE_READ_FAILED"
	| "PTY_CONNECT_FAILED"
	| "PTY_CREATE_FAILED"
	| "HANDLER_ERROR"
	| "UNKNOWN_MESSAGE_TYPE"
	| "PARSE_ERROR"
	| "INTERNAL_ERROR"
	| "INIT_FAILED"
	| "CONNECTION_LOST"
	| "RATE_LIMITED"
	| "PERMISSION_DENIED"
	| "REWIND_FAILED"
	| "PROCESSING_TIMEOUT"
	| "NO_SESSION"
	| "INVALID_REQUEST"
	| "NOT_SUPPORTED"
	| "ADD_PROJECT_FAILED"
	| "REMOVE_PROJECT_FAILED"
	| "RENAME_PROJECT_FAILED"
	| "INVALID_MESSAGE"
	// Infrastructure codes (used by subclasses)
	| "OPENCODE_UNREACHABLE"
	| "OPENCODE_API_ERROR"
	| "SSE_DISCONNECTED"
	| "WEBSOCKET_ERROR"
	| "CONFIG_INVALID";

/** Base error class for all relay errors */
export class RelayError extends Error {
	readonly code: ErrorCode;
	readonly statusCode: number;
	readonly userVisible: boolean;
	readonly context: Record<string, unknown>;

	constructor(
		message: string,
		options: {
			code: ErrorCode;
			statusCode?: number;
			userVisible?: boolean;
			context?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, { cause: options.cause });
		this.name = "RelayError";
		this.code = options.code;
		this.statusCode = options.statusCode ?? 500;
		this.userVisible = options.userVisible ?? true;
		this.context = options.context ?? {};
	}

	/** HTTP JSON response shape */
	toJSON(): { error: { code: string; message: string; details?: unknown } } {
		const details =
			Object.keys(this.context).length > 0 ? this.context : undefined;
		return {
			error: {
				code: this.code,
				message: this.message,
				...(details ? { details } : {}),
			},
		};
	}

	/** WebSocket error message shape (AC1: consistent { type, code, message }) */
	toWebSocket(): { type: "error"; code: string; message: string } {
		return {
			type: "error",
			code: this.code,
			message: this.message,
		};
	}

	/** Alias for toWebSocket() — returns a RelayMessage error variant (AC1). */
	toMessage(): Extract<RelayMessage, { type: "error" }> {
		return {
			type: "error",
			code: this.code,
			message: this.message,
		};
	}

	/** Log-safe representation (redacts sensitive data) (AC6) */
	toLog(): Record<string, unknown> {
		return {
			code: this.code,
			message: this.message,
			context: redactSensitive(this.context),
			...(this.cause instanceof Error
				? { cause: { message: this.cause.message, stack: this.cause.stack } }
				: {}),
		};
	}

	/**
	 * Create a RelayError from any caught value (AC4: error translation).
	 * Replaces the standalone `buildErrorResponse()` utility — same behavior
	 * but produces a proper RelayError instance instead of a plain object.
	 */
	static fromCaught(
		err: unknown,
		code: ErrorCode,
		prefix?: string,
	): RelayError {
		const detail = formatErrorDetail(err);
		const message = prefix ? `${prefix}: ${detail}` : detail;
		const cause = err instanceof Error ? err : undefined;
		return new RelayError(message, {
			code,
			...(cause != null && { cause }),
		});
	}
}

export class OpenCodeConnectionError extends RelayError {
	constructor(
		message: string,
		options?: { cause?: Error; context?: Record<string, unknown> },
	) {
		super(message, {
			code: "OPENCODE_UNREACHABLE",
			statusCode: 502,
			...(options?.cause != null && { cause: options.cause }),
			context: options?.context ?? {},
		});
		this.name = "OpenCodeConnectionError";
	}
}

export class OpenCodeApiError extends RelayError {
	readonly endpoint: string;
	readonly responseStatus: number;
	readonly responseBody: unknown;

	constructor(
		message: string,
		options: {
			endpoint: string;
			responseStatus: number;
			responseBody?: unknown;
			cause?: Error;
		},
	) {
		// For 4xx client errors, include the response body in the message
		// so callers see actionable details (e.g. Zod validation errors)
		let enrichedMessage = message;
		if (
			options.responseBody &&
			options.responseStatus >= 400 &&
			options.responseStatus < 500
		) {
			const bodyStr =
				typeof options.responseBody === "string"
					? options.responseBody
					: JSON.stringify(options.responseBody);
			if (bodyStr.length <= 500) {
				enrichedMessage = `${message}: ${bodyStr}`;
			}
		}

		super(enrichedMessage, {
			code: "OPENCODE_API_ERROR",
			statusCode: options.responseStatus >= 500 ? 502 : options.responseStatus,
			context: {
				endpoint: options.endpoint,
				responseStatus: options.responseStatus,
				responseBody: options.responseBody,
			},
			...(options.cause != null && { cause: options.cause }),
		});
		this.name = "OpenCodeApiError";
		this.endpoint = options.endpoint;
		this.responseStatus = options.responseStatus;
		this.responseBody = options.responseBody;
	}
}

export class SSEConnectionError extends RelayError {
	constructor(
		message: string,
		options?: { cause?: Error; context?: Record<string, unknown> },
	) {
		super(message, {
			code: "SSE_DISCONNECTED",
			statusCode: 502,
			...(options?.cause != null && { cause: options.cause }),
			context: options?.context ?? {},
		});
		this.name = "SSEConnectionError";
	}
}

export class WebSocketError extends RelayError {
	constructor(
		message: string,
		options?: { cause?: Error; context?: Record<string, unknown> },
	) {
		super(message, {
			code: "WEBSOCKET_ERROR",
			statusCode: 400,
			...(options?.cause != null && { cause: options.cause }),
			context: options?.context ?? {},
		});
		this.name = "WebSocketError";
	}
}

export class AuthenticationError extends RelayError {
	constructor(
		message: string,
		options?: { cause?: Error; context?: Record<string, unknown> },
	) {
		super(message, {
			code: "AUTH_FAILED",
			statusCode: 401,
			...(options?.cause != null && { cause: options.cause }),
			context: options?.context ?? {},
		});
		this.name = "AuthenticationError";
	}
}

export class ConfigurationError extends RelayError {
	constructor(
		message: string,
		options?: { cause?: Error; context?: Record<string, unknown> },
	) {
		super(message, {
			code: "CONFIG_INVALID",
			statusCode: 500,
			...(options?.cause != null && { cause: options.cause }),
			context: options?.context ?? {},
		});
		this.name = "ConfigurationError";
	}
}

/** Wrap a low-level error in a RelayError subclass, preserving the cause chain */
export function wrapError(
	error: unknown,
	ErrorClass: new (
		message: string,
		options?: { cause?: Error; context?: Record<string, unknown> },
	) => RelayError,
	context?: Record<string, unknown>,
): RelayError {
	const cause = error instanceof Error ? error : new Error(String(error));
	return new ErrorClass(cause.message, {
		cause,
		...(context != null && { context }),
	});
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
 * For OpenCodeApiError, includes the response body for diagnostics.
 */
export function formatErrorDetail(err: unknown): string {
	if (err instanceof OpenCodeApiError && err.responseBody) {
		const body =
			typeof err.responseBody === "string"
				? err.responseBody
				: JSON.stringify(err.responseBody);
		return `${err.message} — ${body}`;
	}
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "Unknown error";
}
