// ─── Property-Based Tests: Error Handling Foundation (Ticket 0.5) ────────────
//
// Properties tested:
// P1: RelayError hierarchy — all subclasses are instanceof RelayError and Error
//     → Source: AC1 (structured error classes)
// P2: toJSON() always produces valid { error: { code, message } } shape
//     → Source: AC2 (error formatting for HTTP)
// P3: toWebSocket() always produces { type: "error", code, message }
//     → Source: AC2 (error formatting for WebSocket)
// P4: Sensitive data is always redacted in toLog()
//     → Source: AC2 (sensitive data filtering)
// P5: wrapError preserves the cause chain
//     → Source: AC4 (error wrapping utility)
// P6: Error code is always a non-empty string
//     → Source: AC1 (machine-readable error code)

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	AuthenticationError,
	ConfigurationError,
	type ErrorCode,
	OpenCodeApiError,
	OpenCodeConnectionError,
	RelayError,
	redactSensitive,
	SSEConnectionError,
	WebSocketError,
	wrapError,
} from "../../src/lib/errors.js";
import { edgeCaseString } from "../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 200;

// ─── Generator: arbitrary RelayError ────────────────────────────────────────

const ALL_ERROR_CODES: ErrorCode[] = [
	"AUTH_REQUIRED",
	"AUTH_FAILED",
	"SESSION_NOT_FOUND",
	"SESSION_CREATE_FAILED",
	"SESSION_ERROR",
	"PROMPT_FAILED",
	"SEND_FAILED",
	"MODEL_SWITCH_FAILED",
	"MODEL_ERROR",
	"AGENT_SWITCH_FAILED",
	"FILE_NOT_FOUND",
	"FILE_READ_FAILED",
	"PTY_CONNECT_FAILED",
	"PTY_CREATE_FAILED",
	"HANDLER_ERROR",
	"UNKNOWN_MESSAGE_TYPE",
	"PARSE_ERROR",
	"INTERNAL_ERROR",
	"INIT_FAILED",
	"CONNECTION_LOST",
	"RATE_LIMITED",
	"PERMISSION_DENIED",
	"REWIND_FAILED",
	"PROCESSING_TIMEOUT",
	"NO_SESSION",
	"INVALID_REQUEST",
	"NOT_SUPPORTED",
	"ADD_PROJECT_FAILED",
	"INVALID_MESSAGE",
	"OPENCODE_UNREACHABLE",
	"OPENCODE_API_ERROR",
	"SSE_DISCONNECTED",
	"WEBSOCKET_ERROR",
	"CONFIG_INVALID",
];

const arbErrorCode = fc.constantFrom(...ALL_ERROR_CODES);

const arbStatusCode = fc.oneof(
	{ weight: 5, arbitrary: fc.constantFrom(400, 401, 403, 404, 500, 502, 503) },
	{ weight: 2, arbitrary: fc.integer({ min: 100, max: 599 }) },
);

const arbContext = fc.dictionary(
	fc.string({ minLength: 1, maxLength: 20 }),
	fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
);

const arbRelayError = fc
	.tuple(edgeCaseString, arbErrorCode, arbStatusCode, arbContext)
	.map(
		([message, code, statusCode, context]) =>
			new RelayError(message, { code, statusCode, context }),
	);

// ─── Generators: subclass errors ────────────────────────────────────────────

const errorSubclasses = [
	{ Class: OpenCodeConnectionError, expectedCode: "OPENCODE_UNREACHABLE" },
	{ Class: SSEConnectionError, expectedCode: "SSE_DISCONNECTED" },
	{ Class: WebSocketError, expectedCode: "WEBSOCKET_ERROR" },
	{ Class: AuthenticationError, expectedCode: "AUTH_FAILED" },
	{ Class: ConfigurationError, expectedCode: "CONFIG_INVALID" },
] as const;

// ─── P1: Inheritance hierarchy ──────────────────────────────────────────────

describe("Ticket 0.5 — Error Handling PBT", () => {
	describe("P1: RelayError hierarchy (AC1)", () => {
		it("property: all RelayError instances are instanceof Error", () => {
			fc.assert(
				fc.property(arbRelayError, (err) => {
					expect(err).toBeInstanceOf(Error);
					expect(err).toBeInstanceOf(RelayError);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: all subclasses are instanceof RelayError and Error", () => {
			fc.assert(
				fc.property(edgeCaseString, (message) => {
					for (const { Class } of errorSubclasses) {
						const err = new Class(message);
						expect(err).toBeInstanceOf(Error);
						expect(err).toBeInstanceOf(RelayError);
						expect(err).toBeInstanceOf(Class);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: OpenCodeApiError captures endpoint and status", () => {
			fc.assert(
				fc.property(
					edgeCaseString,
					fc.string({ minLength: 1, maxLength: 50 }),
					fc.integer({ min: 200, max: 599 }),
					(message, endpoint, responseStatus) => {
						const err = new OpenCodeApiError(message, {
							endpoint,
							responseStatus,
						});
						expect(err.endpoint).toBe(endpoint);
						expect(err.responseStatus).toBe(responseStatus);
						expect(err).toBeInstanceOf(RelayError);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: toJSON shape ───────────────────────────────────────────────────

	describe("P2: toJSON always produces valid HTTP error shape (AC2)", () => {
		it("property: toJSON returns { error: { code, message } }", () => {
			fc.assert(
				fc.property(arbRelayError, (err) => {
					const json = err.toJSON();
					expect(json).toHaveProperty("error");
					expect(json.error).toHaveProperty("code");
					expect(json.error).toHaveProperty("message");
					expect(typeof json.error.code).toBe("string");
					expect(typeof json.error.message).toBe("string");
					expect(json.error.code).toBe(err.code);
					expect(json.error.message).toBe(err.message);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: toJSON is always valid JSON (roundtrips)", () => {
			fc.assert(
				fc.property(arbRelayError, (err) => {
					const json = err.toJSON();
					const serialized = JSON.stringify(json);
					const parsed = JSON.parse(serialized);
					expect(parsed.error.code).toBe(err.code);
					expect(parsed.error.message).toBe(err.message);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: toWebSocket shape ────────────────────────────────────────────

	describe("P3: toWebSocket always produces valid WS error message (AC2)", () => {
		it("property: toWebSocket returns { type: 'error', code, message }", () => {
			fc.assert(
				fc.property(arbRelayError, (err) => {
					const ws = err.toWebSocket();
					expect(ws.type).toBe("error");
					expect(ws.code).toBe(err.code);
					expect(ws.message).toBe(err.message);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P4: Sensitive data redaction ─────────────────────────────────────

	describe("P4: Sensitive data is always redacted in logs (AC2)", () => {
		const sensitiveKeys = [
			"pin",
			"password",
			"token",
			"secret",
			"authorization",
			"cookie",
		];

		it("property: redactSensitive replaces sensitive keys with [REDACTED]", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...sensitiveKeys),
					fc.string({ minLength: 1, maxLength: 50 }),
					(key, value) => {
						const result = redactSensitive({ [key]: value });
						expect(result[key]).toBe("[REDACTED]");
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: non-sensitive keys are preserved", () => {
			fc.assert(
				fc.property(
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter((k) => !sensitiveKeys.includes(k.toLowerCase())),
					fc.string(),
					(key, value) => {
						const result = redactSensitive({ [key]: value });
						expect(result[key]).toBe(value);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: nested sensitive keys are redacted", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...sensitiveKeys),
					fc.string({ minLength: 1, maxLength: 50 }),
					(key, value) => {
						const result = redactSensitive({ nested: { [key]: value } });
						expect((result["nested"] as Record<string, unknown>)[key]).toBe(
							"[REDACTED]",
						);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: toLog never contains sensitive values from context", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...sensitiveKeys),
					fc.string({ minLength: 1, maxLength: 50 }),
					(key, value) => {
						const err = new RelayError("test", {
							code: "INTERNAL_ERROR",
							context: { [key]: value },
						});
						const log = err.toLog();
						const ctx = log["context"] as Record<string, unknown>;
						expect(ctx[key]).toBe("[REDACTED]");
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P5: wrapError preserves cause chain ──────────────────────────────

	describe("P5: wrapError preserves cause chain (AC4)", () => {
		it("property: wrapped error has original as cause", () => {
			fc.assert(
				fc.property(edgeCaseString, arbContext, (message, context) => {
					const original = new Error(message);
					const wrapped = wrapError(original, OpenCodeConnectionError, context);
					expect(wrapped).toBeInstanceOf(RelayError);
					expect(wrapped).toBeInstanceOf(OpenCodeConnectionError);
					expect(wrapped.cause).toBe(original);
					expect(wrapped.message).toBe(message);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: wrapError handles non-Error thrown values", () => {
			fc.assert(
				fc.property(
					fc.oneof(
						fc.string(),
						fc.integer(),
						fc.constant(null),
						fc.constant(undefined),
					),
					(thrown) => {
						const wrapped = wrapError(thrown, SSEConnectionError);
						expect(wrapped).toBeInstanceOf(RelayError);
						expect(wrapped.cause).toBeInstanceOf(Error);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P6: Error codes are non-empty ────────────────────────────────────

	describe("P6: Error codes are always non-empty strings (AC1)", () => {
		it("property: all subclass error codes are non-empty", () => {
			fc.assert(
				fc.property(edgeCaseString, (message) => {
					for (const { Class, expectedCode } of errorSubclasses) {
						const err = new Class(message);
						expect(err.code).toBe(expectedCode);
						expect(err.code.length).toBeGreaterThan(0);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});
});
