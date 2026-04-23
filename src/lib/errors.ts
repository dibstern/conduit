// ─── Error Handling Foundation (Ticket 0.5, 6.2) ─────────────────────────────

import { formatErrorDetail, redactSensitive } from "./errors-utils.js";
import type { RelayMessage } from "./shared-types.js";

// Re-export utility functions for backward compatibility
export { formatErrorDetail, redactSensitive } from "./errors-utils.js";

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
	/** Tagged discriminant for Effect union support.
	 *  Base class: equals the ErrorCode.  Subclasses: equals the class name. */
	readonly _tag: string;
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
		this._tag = options.code;
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
				code: this._tag,
				message: this.message,
				...(details ? { details } : {}),
			},
		};
	}

	/** WebSocket error message shape (AC1: consistent { type, code, message }) */
	toWebSocket(): {
		type: "error";
		code: string;
		message: string;
		statusCode?: number;
		details?: Record<string, unknown>;
	} {
		const details =
			Object.keys(this.context).length > 0 ? this.context : undefined;
		return {
			type: "error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	/** Returns a RelayMessage `error` variant with required sessionId (AC1).
	 *  For genuinely session-less errors, use {@link toSystemError} instead. */
	toMessage(sessionId: string): Extract<RelayMessage, { type: "error" }> {
		return { ...this.toWebSocket(), sessionId };
	}

	/** Returns a RelayMessage `system_error` variant for session-less errors.
	 *  Use this for broadcast errors that have no session context (e.g.
	 *  HANDLER_ERROR, INIT_FAILED, terminal/settings errors). */
	toSystemError(): Extract<RelayMessage, { type: "system_error" }> {
		const details =
			Object.keys(this.context).length > 0 ? this.context : undefined;
		return {
			type: "system_error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	/** Log-safe representation (redacts sensitive data) (AC6) */
	toLog(): Record<string, unknown> {
		return {
			code: this._tag,
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
	declare readonly _tag: "OpenCodeConnectionError";

	constructor(props: {
		message: string;
		cause?: Error;
		context?: Record<string, unknown>;
		userVisible?: boolean;
	}) {
		super(props.message, {
			code: "OPENCODE_UNREACHABLE",
			statusCode: 502,
			...(props.userVisible != null && { userVisible: props.userVisible }),
			...(props.cause != null && { cause: props.cause }),
			context: props.context ?? {},
		});
		this.name = "OpenCodeConnectionError";
		(this as { _tag: string })._tag = "OpenCodeConnectionError";
	}
}

export class OpenCodeApiError extends RelayError {
	declare readonly _tag: "OpenCodeApiError";
	readonly endpoint: string;
	readonly responseStatus: number;
	readonly responseBody: unknown;

	constructor(props: {
		message: string;
		endpoint: string;
		responseStatus: number;
		responseBody?: unknown;
		cause?: Error;
		userVisible?: boolean;
	}) {
		// For 4xx client errors, include the response body in the message
		// so callers see actionable details (e.g. Zod validation errors)
		let enrichedMessage = props.message;
		if (
			props.responseBody &&
			props.responseStatus >= 400 &&
			props.responseStatus < 500
		) {
			const bodyStr =
				typeof props.responseBody === "string"
					? props.responseBody
					: JSON.stringify(props.responseBody);
			if (bodyStr.length <= 500) {
				enrichedMessage = `${props.message}: ${bodyStr}`;
			}
		}

		super(enrichedMessage, {
			code: "OPENCODE_API_ERROR",
			statusCode: props.responseStatus >= 500 ? 502 : props.responseStatus,
			...(props.userVisible != null && { userVisible: props.userVisible }),
			context: {
				endpoint: props.endpoint,
				responseStatus: props.responseStatus,
				responseBody: props.responseBody,
			},
			...(props.cause != null && { cause: props.cause }),
		});
		this.name = "OpenCodeApiError";
		(this as { _tag: string })._tag = "OpenCodeApiError";
		this.endpoint = props.endpoint;
		this.responseStatus = props.responseStatus;
		this.responseBody = props.responseBody;
	}
}

export class SSEConnectionError extends RelayError {
	declare readonly _tag: "SSEConnectionError";

	constructor(props: {
		message: string;
		cause?: Error;
		context?: Record<string, unknown>;
		userVisible?: boolean;
	}) {
		super(props.message, {
			code: "SSE_DISCONNECTED",
			statusCode: 502,
			...(props.userVisible != null && { userVisible: props.userVisible }),
			...(props.cause != null && { cause: props.cause }),
			context: props.context ?? {},
		});
		this.name = "SSEConnectionError";
		(this as { _tag: string })._tag = "SSEConnectionError";
	}
}

export class WebSocketError extends RelayError {
	declare readonly _tag: "WebSocketError";

	constructor(props: {
		message: string;
		cause?: Error;
		context?: Record<string, unknown>;
		userVisible?: boolean;
	}) {
		super(props.message, {
			code: "WEBSOCKET_ERROR",
			statusCode: 400,
			...(props.userVisible != null && { userVisible: props.userVisible }),
			...(props.cause != null && { cause: props.cause }),
			context: props.context ?? {},
		});
		this.name = "WebSocketError";
		(this as { _tag: string })._tag = "WebSocketError";
	}
}

export class AuthenticationError extends RelayError {
	declare readonly _tag: "AuthenticationError";

	constructor(props: {
		message: string;
		cause?: Error;
		context?: Record<string, unknown>;
		userVisible?: boolean;
	}) {
		super(props.message, {
			code: "AUTH_FAILED",
			statusCode: 401,
			...(props.userVisible != null && { userVisible: props.userVisible }),
			...(props.cause != null && { cause: props.cause }),
			context: props.context ?? {},
		});
		this.name = "AuthenticationError";
		(this as { _tag: string })._tag = "AuthenticationError";
	}
}

export class ConfigurationError extends RelayError {
	declare readonly _tag: "ConfigurationError";

	constructor(props: {
		message: string;
		cause?: Error;
		context?: Record<string, unknown>;
		userVisible?: boolean;
	}) {
		super(props.message, {
			code: "CONFIG_INVALID",
			statusCode: 500,
			...(props.userVisible != null && { userVisible: props.userVisible }),
			...(props.cause != null && { cause: props.cause }),
			context: props.context ?? {},
		});
		this.name = "ConfigurationError";
		(this as { _tag: string })._tag = "ConfigurationError";
	}
}

/** Wrap a low-level error in a RelayError subclass, preserving the cause chain */
export function wrapError(
	error: unknown,
	ErrorClass: new (props: {
		message: string;
		cause?: Error;
		context?: Record<string, unknown>;
	}) => RelayError,
	context?: Record<string, unknown>,
): RelayError {
	const cause = error instanceof Error ? error : new Error(String(error));
	return new ErrorClass({
		message: cause.message,
		cause,
		...(context != null && { context }),
	});
}
