// Failure modes: SDK class names/codes or retry flags drift, auth becomes
// retryable, or wrapping an SDK failure loses its TurnError classification.
import {
	AgentBusyError,
	AgentNotFoundError,
	AuthenticationError,
	ConfigurationError,
	CursorAgentError,
	CursorSdkError,
	IntegrationNotConnectedError,
	NetworkError,
	RateLimitError,
	UnknownAgentError,
} from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import {
	cursorSdkFailure,
	cursorTurnError,
} from "../../../src/lib/provider/cursor/sdk-error.js";
import type { TurnErrorCode } from "../../../src/lib/provider/types.js";

const message = "C5-B SDK error";
const classes: [Error, TurnErrorCode, boolean][] = [
	[new AgentBusyError(message), "agent_busy", false],
	[
		new AuthenticationError(message, { isRetryable: true }),
		"auth_required",
		false,
	],
	[new RateLimitError(message, { isRetryable: true }), "rate_limited", true],
	[new NetworkError(message, { isRetryable: true }), "network_error", true],
	[
		new ConfigurationError("Cannot use this model: retired"),
		"model_unavailable",
		false,
	],
	[new ConfigurationError(message), "provider_error", false],
	[new CursorSdkError(message), "provider_error", false],
	[new CursorAgentError(message), "provider_error", false],
	[new UnknownAgentError(message), "provider_error", false],
	[new AgentNotFoundError(message), "provider_error", false],
	[
		new IntegrationNotConnectedError(message, {
			helpUrl: "https://example.invalid",
			provider: "github",
		}),
		"provider_error",
		false,
	],
	[new NetworkError(message, { isRetryable: false }), "network_error", false],
	[new RateLimitError(message, { isRetryable: false }), "rate_limited", false],
	[
		new ConfigurationError("Cannot use this model: retired", {
			code: "invalid_argument",
		}),
		"provider_error",
		false,
	],
];

const codes: [readonly string[], TurnErrorCode, boolean][] = [
	[
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
		],
		"auth_required",
		false,
	],
	[
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
		],
		"rate_limited",
		true,
	],
	[["BAD_MODEL_NAME", "MODEL_BLOCKED"], "model_unavailable", false],
	[
		[
			"connection_stalled",
			"TIMEOUT",
			"ABORT_ERR",
			"unavailable",
			"deadline_exceeded",
			"internal",
		],
		"network_error",
		true,
	],
];

describe("Cursor TurnError contract against the installed SDK", () => {
	it.each(
		classes,
	)("maps %s to %s with retryable=%s", (error, code, retryable) => {
		const expected = { code, message: error.message, retryable };
		expect(cursorTurnError(error)).toEqual(expected);
		expect(cursorTurnError(cursorSdkFailure("contract", error))).toEqual(
			expected,
		);
	});
	it.each(
		codes.flatMap(([values, expected, retryable]) =>
			values.map((code) => ({ code, expected, retryable })),
		),
	)("maps code $code to $expected", ({ code, expected, retryable }) => {
		const error = new CursorSdkError(message, {
			code,
			isRetryable: retryable || expected === "auth_required",
		});
		const result = { code: expected, message, retryable };
		expect(cursorTurnError(error)).toEqual(result);
		expect(cursorTurnError(cursorSdkFailure("contract", error))).toEqual(
			result,
		);
	});
	it.each([
		"auth_required",
		"agent_busy",
		"rate_limited",
		"model_unavailable",
		"network_error",
		"provider_error",
		"sandbox_unavailable",
		"send_failed",
		"interrupted",
		"timeout",
		"unknown",
	] as const)("preserves canonical code %s", (code) => {
		expect(
			cursorTurnError(new CursorSdkError(message, { code, isRetryable: true })),
		).toEqual({ code, message, retryable: code !== "auth_required" });
	});
	it.each([
		[401, "auth_required", false],
		[429, "rate_limited", true],
		[500, "network_error", true],
		[503, "network_error", true],
		[400, "provider_error", true],
	] as const)("maps HTTP %s to %s", (status, code, retryable) => {
		expect(
			cursorTurnError(
				new CursorSdkError(message, { status, isRetryable: true }),
			),
		).toEqual({ code, message, retryable });
	});
	it("retries connection_stalled despite the SDK's false retry flag", () => {
		expect(
			cursorTurnError(
				new CursorSdkError(message, {
					code: "connection_stalled",
					isRetryable: false,
				}),
			),
		).toEqual({ code: "network_error", message, retryable: true });
	});
});
