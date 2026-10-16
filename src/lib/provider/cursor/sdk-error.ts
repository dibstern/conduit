import { Data } from "effect";
import type { TurnError, TurnErrorCode } from "../types.js";

interface CursorErrorDetails {
	readonly name?: string;
	readonly code?: string;
	readonly status?: number;
	readonly isRetryable?: boolean;
}

export class CursorSdkFailure extends Data.TaggedError("CursorSdkFailure")<{
	readonly operation: string;
	readonly reason: string;
	readonly code?: TurnErrorCode;
	readonly retryable?: boolean;
	readonly sdkError?: CursorErrorDetails;
}> {
	override get message(): string {
		return this.reason;
	}
}

export function cursorTurnError(cause: unknown): TurnError {
	if (cause instanceof CursorSdkFailure) {
		return {
			code: cause.code ?? "provider_error",
			message: cause.reason,
			retryable: cause.retryable ?? false,
		};
	}
	const fields = cause !== null && typeof cause === "object" ? cause : {};
	const name = "name" in fields ? fields.name : undefined;
	const code = "code" in fields ? fields.code : undefined;
	const status = "status" in fields ? fields.status : undefined;
	const message =
		"message" in fields && typeof fields.message === "string"
			? fields.message
			: String(cause);
	let mapped: TurnErrorCode = "provider_error";
	if (
		code === "auth_required" ||
		code === "agent_busy" ||
		code === "rate_limited" ||
		code === "model_unavailable" ||
		code === "network_error" ||
		code === "provider_error" ||
		code === "sandbox_unavailable" ||
		code === "send_failed" ||
		code === "interrupted" ||
		code === "timeout" ||
		code === "unknown"
	) {
		mapped = code;
	} else if (name === "AgentBusyError") {
		mapped = "agent_busy";
	} else if (
		name === "AuthenticationError" ||
		status === 401 ||
		[
			"NOT_LOGGED_IN",
			"INVALID_AUTH_ID",
			"NOT_HIGH_ENOUGH_PERMISSIONS",
			"AGENT_REQUIRES_LOGIN",
			"AUTH_TOKEN_NOT_FOUND",
			"AUTH_TOKEN_EXPIRED",
			"UNAUTHORIZED",
			"BAD_API_KEY",
			"BAD_USER_API_KEY",
			"unauthenticated",
			"permission_denied",
		].includes(String(code))
	) {
		mapped = "auth_required";
	} else if (
		name === "RateLimitError" ||
		status === 429 ||
		[
			"FREE_USER_RATE_LIMIT_EXCEEDED",
			"PRO_USER_RATE_LIMIT_EXCEEDED",
			"FREE_USER_USAGE_LIMIT",
			"PRO_USER_USAGE_LIMIT",
			"RESOURCE_EXHAUSTED",
			"OPENAI_RATE_LIMIT_EXCEEDED",
			"GENERIC_RATE_LIMIT_EXCEEDED",
			"GPT_4_VISION_PREVIEW_RATE_LIMIT",
			"API_KEY_RATE_LIMIT",
			"RATE_LIMITED",
			"RATE_LIMITED_CHANGEABLE",
			"resource_exhausted",
		].includes(String(code))
	) {
		mapped = "rate_limited";
	} else if (
		code === "BAD_MODEL_NAME" ||
		code === "MODEL_BLOCKED" ||
		// 1.0.37's local catalogue rejection has no code (resolveLocalModelSelection).
		(name === "ConfigurationError" &&
			code === undefined &&
			message.startsWith("Cannot use this model:"))
	) {
		mapped = "model_unavailable";
	} else if (
		name === "NetworkError" ||
		(typeof status === "number" && status >= 500) ||
		[
			"connection_stalled",
			"TIMEOUT",
			"ABORT_ERR",
			"unavailable",
			"deadline_exceeded",
			"internal",
		].includes(String(code))
	) {
		mapped = "network_error";
	}
	return {
		code: mapped,
		message,
		retryable:
			code === "connection_stalled" ||
			("isRetryable" in fields && typeof fields.isRetryable === "boolean"
				? fields.isRetryable
				: "retryable" in fields && typeof fields.retryable === "boolean"
					? fields.retryable
					: mapped === "network_error" || mapped === "rate_limited"),
	};
}

export function cursorSdkFailure(
	operation: string,
	cause: unknown,
): CursorSdkFailure {
	if (cause instanceof CursorSdkFailure) return cause;
	const error = cursorTurnError(cause);
	const fields = cause !== null && typeof cause === "object" ? cause : {};
	return new CursorSdkFailure({
		operation,
		reason: error.message,
		code: error.code,
		retryable: error.retryable ?? false,
		sdkError: {
			...("name" in fields && typeof fields.name === "string"
				? { name: fields.name }
				: {}),
			...("code" in fields && typeof fields.code === "string"
				? { code: fields.code }
				: {}),
			...("status" in fields && typeof fields.status === "number"
				? { status: fields.status }
				: {}),
			...("isRetryable" in fields && typeof fields.isRetryable === "boolean"
				? { isRetryable: fields.isRetryable }
				: {}),
		},
	});
}
