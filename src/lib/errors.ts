// ─── Error Handling Foundation (Ticket 0.5, 6.2) ─────────────────────────────
//
// Schema.TaggedError-based error hierarchy for the relay layer.
// Each subclass is a Schema.TaggedError with _tag set to the class name.
// The RelayError base class is kept as a plain Error subclass for generic
// error codes used throughout the codebase (e.g. NO_SESSION, INVALID_REQUEST).

import { Schema } from "effect";
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
	| "MISSING_COMMAND_ID"
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

// ─── Shared Schema fields for TaggedError subclasses ────────────────────────

const RelayErrorFields = {
	message: Schema.String,
	userVisible: Schema.optionalWith(Schema.Boolean, { default: () => false }),
	context: Schema.optionalWith(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
		{ default: () => ({}) },
	),
	cause: Schema.optionalWith(Schema.Unknown, { default: () => undefined }),
};

// ─── Mixin: shared serialization methods for TaggedError subclasses ─────────
// Each Schema.TaggedError subclass mixes in these methods via direct definition.

/** Helper to build context details for serialization */
function contextDetails(
	ctx: Record<string, unknown>,
): Record<string, unknown> | undefined {
	return Object.keys(ctx).length > 0 ? ctx : undefined;
}

// ─── Schema.TaggedError subclasses ──────────────────────────────────────────

export class OpenCodeConnectionError extends Schema.TaggedError<OpenCodeConnectionError>()(
	"OpenCodeConnectionError",
	{ ...RelayErrorFields },
) {
	get statusCode() {
		return 502;
	}
	get code() {
		return this._tag;
	}

	toJSON(): { error: { code: string; message: string; details?: unknown } } {
		const details = contextDetails(this.context);
		return {
			error: {
				code: this._tag,
				message: this.message,
				...(details ? { details } : {}),
			},
		};
	}

	toWebSocket(): {
		type: "error";
		code: string;
		message: string;
		statusCode?: number;
		details?: Record<string, unknown>;
	} {
		const details = contextDetails(this.context);
		return {
			type: "error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toMessage(sessionId: string): Extract<RelayMessage, { type: "error" }> {
		return { ...this.toWebSocket(), sessionId };
	}

	toSystemError(): Extract<RelayMessage, { type: "system_error" }> {
		const details = contextDetails(this.context);
		return {
			type: "system_error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toLog(): Record<string, unknown> {
		return {
			error: this._tag,
			message: this.message,
			...redactSensitive(this.context),
		};
	}
}

export class OpenCodeApiError extends Schema.TaggedError<OpenCodeApiError>()(
	"OpenCodeApiError",
	{
		...RelayErrorFields,
		endpoint: Schema.String,
		responseStatus: Schema.Number,
		responseBody: Schema.optionalWith(Schema.Unknown, {
			default: () => undefined,
		}),
	},
) {
	// Enrich message for 4xx errors with response body (preserves old behavior)
	constructor(props: {
		message: string;
		endpoint: string;
		responseStatus: number;
		responseBody?: unknown;
		userVisible?: boolean;
		context?: Record<string, unknown>;
		cause?: unknown;
	}) {
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
		super({ ...props, message: enrichedMessage });
	}

	get statusCode() {
		return this.responseStatus >= 500 ? 502 : this.responseStatus;
	}
	get code() {
		return this._tag;
	}

	toJSON(): { error: { code: string; message: string; details?: unknown } } {
		const details = contextDetails(this.context);
		return {
			error: {
				code: this._tag,
				message: this.message,
				...(details ? { details } : {}),
			},
		};
	}

	toWebSocket(): {
		type: "error";
		code: string;
		message: string;
		statusCode?: number;
		details?: Record<string, unknown>;
	} {
		const details = contextDetails(this.context);
		return {
			type: "error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toMessage(sessionId: string): Extract<RelayMessage, { type: "error" }> {
		return { ...this.toWebSocket(), sessionId };
	}

	toSystemError(): Extract<RelayMessage, { type: "system_error" }> {
		const details = contextDetails(this.context);
		return {
			type: "system_error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toLog(): Record<string, unknown> {
		return {
			error: this._tag,
			message: this.message,
			...redactSensitive(this.context),
		};
	}
}

export class SSEConnectionError extends Schema.TaggedError<SSEConnectionError>()(
	"SSEConnectionError",
	{ ...RelayErrorFields },
) {
	get statusCode() {
		return 502;
	}
	get code() {
		return this._tag;
	}

	toJSON(): { error: { code: string; message: string; details?: unknown } } {
		const details = contextDetails(this.context);
		return {
			error: {
				code: this._tag,
				message: this.message,
				...(details ? { details } : {}),
			},
		};
	}

	toWebSocket(): {
		type: "error";
		code: string;
		message: string;
		statusCode?: number;
		details?: Record<string, unknown>;
	} {
		const details = contextDetails(this.context);
		return {
			type: "error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toMessage(sessionId: string): Extract<RelayMessage, { type: "error" }> {
		return { ...this.toWebSocket(), sessionId };
	}

	toSystemError(): Extract<RelayMessage, { type: "system_error" }> {
		const details = contextDetails(this.context);
		return {
			type: "system_error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toLog(): Record<string, unknown> {
		return {
			error: this._tag,
			message: this.message,
			...redactSensitive(this.context),
		};
	}
}

export class WebSocketError extends Schema.TaggedError<WebSocketError>()(
	"WebSocketError",
	{ ...RelayErrorFields },
) {
	get statusCode() {
		return 400;
	}
	get code() {
		return this._tag;
	}

	toJSON(): { error: { code: string; message: string; details?: unknown } } {
		const details = contextDetails(this.context);
		return {
			error: {
				code: this._tag,
				message: this.message,
				...(details ? { details } : {}),
			},
		};
	}

	toWebSocket(): {
		type: "error";
		code: string;
		message: string;
		statusCode?: number;
		details?: Record<string, unknown>;
	} {
		const details = contextDetails(this.context);
		return {
			type: "error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toMessage(sessionId: string): Extract<RelayMessage, { type: "error" }> {
		return { ...this.toWebSocket(), sessionId };
	}

	toSystemError(): Extract<RelayMessage, { type: "system_error" }> {
		const details = contextDetails(this.context);
		return {
			type: "system_error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toLog(): Record<string, unknown> {
		return {
			error: this._tag,
			message: this.message,
			...redactSensitive(this.context),
		};
	}
}

export class AuthenticationError extends Schema.TaggedError<AuthenticationError>()(
	"AuthenticationError",
	{ ...RelayErrorFields },
) {
	get statusCode() {
		return 401;
	}
	get code() {
		return this._tag;
	}

	toJSON(): { error: { code: string; message: string; details?: unknown } } {
		const details = contextDetails(this.context);
		return {
			error: {
				code: this._tag,
				message: this.message,
				...(details ? { details } : {}),
			},
		};
	}

	toWebSocket(): {
		type: "error";
		code: string;
		message: string;
		statusCode?: number;
		details?: Record<string, unknown>;
	} {
		const details = contextDetails(this.context);
		return {
			type: "error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toMessage(sessionId: string): Extract<RelayMessage, { type: "error" }> {
		return { ...this.toWebSocket(), sessionId };
	}

	toSystemError(): Extract<RelayMessage, { type: "system_error" }> {
		const details = contextDetails(this.context);
		return {
			type: "system_error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toLog(): Record<string, unknown> {
		return {
			error: this._tag,
			message: this.message,
			...redactSensitive(this.context),
		};
	}
}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
	"ConfigurationError",
	{ ...RelayErrorFields },
) {
	get statusCode() {
		return 500;
	}
	get code() {
		return this._tag;
	}

	toJSON(): { error: { code: string; message: string; details?: unknown } } {
		const details = contextDetails(this.context);
		return {
			error: {
				code: this._tag,
				message: this.message,
				...(details ? { details } : {}),
			},
		};
	}

	toWebSocket(): {
		type: "error";
		code: string;
		message: string;
		statusCode?: number;
		details?: Record<string, unknown>;
	} {
		const details = contextDetails(this.context);
		return {
			type: "error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toMessage(sessionId: string): Extract<RelayMessage, { type: "error" }> {
		return { ...this.toWebSocket(), sessionId };
	}

	toSystemError(): Extract<RelayMessage, { type: "system_error" }> {
		const details = contextDetails(this.context);
		return {
			type: "system_error",
			code: this._tag,
			message: this.message,
			...(this.statusCode !== 500 ? { statusCode: this.statusCode } : {}),
			...(details ? { details } : {}),
		};
	}

	toLog(): Record<string, unknown> {
		return {
			error: this._tag,
			message: this.message,
			...redactSensitive(this.context),
		};
	}
}

// ─── RelayError base class ──────────────────────────────────────────────────
// Kept as a plain Error subclass for generic error codes used throughout the
// codebase (e.g. NO_SESSION, INVALID_REQUEST, SEND_FAILED). Unlike the
// Schema.TaggedError subclasses above, this class supports arbitrary ErrorCode
// values and is constructed with the traditional `new RelayError(message, opts)`.

/** Base error class for generic relay errors with arbitrary error codes */
export class RelayError extends Error {
	/** Tagged discriminant — equals the ErrorCode for generic errors */
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
	 * Create a relay error from any caught value (AC4: error translation).
	 * Kept as static method for backward compatibility with existing call sites.
	 * Returns AnyRelayError because infrastructure codes map to Schema.TaggedError subclasses.
	 */
	static fromCaught(
		err: unknown,
		code: ErrorCode,
		prefix?: string,
	): AnyRelayError {
		return fromCaught(err, code, prefix);
	}
}

// ─── AnyRelayError union type ───────────────────────────────────────────────
// Union of all relay error types (Schema.TaggedError subclasses + generic RelayError).
// Used as return type for fromCaught/wrapError utilities.

export type AnyRelayError =
	| RelayError
	| OpenCodeConnectionError
	| OpenCodeApiError
	| SSEConnectionError
	| WebSocketError
	| AuthenticationError
	| ConfigurationError;

// ─── Standalone fromCaught ──────────────────────────────────────────────────

/** Map well-known infrastructure codes to their Schema.TaggedError subclass */
const CODE_TO_CLASS: Record<
	string,
	new (props: {
		message: string;
		context?: Record<string, unknown>;
		cause?: unknown;
	}) =>
		| OpenCodeConnectionError
		| SSEConnectionError
		| WebSocketError
		| AuthenticationError
		| ConfigurationError
> = {
	OPENCODE_UNREACHABLE: OpenCodeConnectionError,
	SSE_DISCONNECTED: SSEConnectionError,
	WEBSOCKET_ERROR: WebSocketError,
	AUTH_FAILED: AuthenticationError,
	CONFIG_INVALID: ConfigurationError,
};

/**
 * Create a relay error from any caught value.
 * Maps well-known infrastructure codes to their Schema.TaggedError subclass;
 * falls back to a generic RelayError for other codes.
 */
export function fromCaught(
	err: unknown,
	code: ErrorCode,
	prefix?: string,
): AnyRelayError {
	const detail = formatErrorDetail(err);
	const message = prefix ? `${prefix}: ${detail}` : detail;
	const cause = err instanceof Error ? err : undefined;

	const ErrorClass = CODE_TO_CLASS[code];
	if (ErrorClass) {
		return new ErrorClass({
			message,
			context: { originalCode: code },
			cause,
		});
	}

	return new RelayError(message, {
		code,
		...(cause != null && { cause }),
	});
}

// ─── wrapError utility ──────────────────────────────────────────────────────

/** Wrap a low-level error in a relay error subclass, preserving the cause chain */
export function wrapError<
	E extends new (props: {
		message: string;
		cause?: unknown;
		context?: Record<string, unknown>;
	}) => AnyRelayError,
>(
	error: unknown,
	ErrorClass: E,
	context?: Record<string, unknown>,
): InstanceType<E> {
	const cause = error instanceof Error ? error : new Error(String(error));
	return new ErrorClass({
		message: cause.message,
		cause,
		...(context != null && { context }),
	}) as InstanceType<E>;
}
