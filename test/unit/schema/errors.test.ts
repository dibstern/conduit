import { describe, expect, it } from "vitest";
import {
	AuthenticationError,
	ConfigurationError,
	fromCaught,
	OpenCodeApiError,
	OpenCodeConnectionError,
	RelayError,
	SSEConnectionError,
	WebSocketError,
	wrapError,
} from "../../../src/lib/errors.js";
import { PersistenceError } from "../../../src/lib/persistence/errors.js";

describe("Schema.TaggedError errors", () => {
	it("OpenCodeApiError._tag is automatic from class name", () => {
		const err = new OpenCodeApiError({
			message: "Not found",
			endpoint: "/api/test",
			responseStatus: 404,
			responseBody: { detail: "missing" },
		});
		expect(err._tag).toBe("OpenCodeApiError");
	});

	it("OpenCodeApiError is an instance of Error", () => {
		const err = new OpenCodeApiError({
			message: "test",
			endpoint: "/test",
			responseStatus: 500,
			responseBody: null,
		});
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("test");
	});

	it("OpenCodeApiError.code returns _tag for wire compat", () => {
		const err = new OpenCodeApiError({
			message: "test",
			endpoint: "/test",
			responseStatus: 500,
			responseBody: null,
		});
		expect(err.code).toBe("OpenCodeApiError");
	});

	it("OpenCodeApiError serializes to JSON", () => {
		const err = new OpenCodeApiError({
			message: "Server error",
			endpoint: "/api/test",
			responseStatus: 500,
			responseBody: null,
			userVisible: true,
		});
		const json = err.toJSON();
		expect(json.error.code).toBe("OpenCodeApiError");
		expect(json.error.message).toBe("Server error");
	});

	it("OpenCodeConnectionError has statusCode 502", () => {
		const err = new OpenCodeConnectionError({ message: "refused" });
		expect(err.statusCode).toBe(502);
	});

	it("userVisible defaults to false", () => {
		const err = new OpenCodeConnectionError({ message: "test" });
		expect(err.userVisible).toBe(false);
	});

	it("userVisible true when set", () => {
		const err = new OpenCodeConnectionError({
			message: "test",
			userVisible: true,
		});
		expect(err.userVisible).toBe(true);
	});

	it("fromCaught wraps unknown errors", () => {
		const err = fromCaught(new TypeError("oops"), "INTERNAL_ERROR");
		expect(err._tag).toBeDefined();
		expect(err.message).toContain("oops");
	});

	it("wrapError preserves cause chain", () => {
		const cause = new Error("root cause");
		const wrapped = wrapError(cause, OpenCodeConnectionError);
		expect(wrapped.message).toBe("root cause");
	});

	it("SSEConnectionError has correct _tag", () => {
		const err = new SSEConnectionError({ message: "disconnected" });
		expect(err._tag).toBe("SSEConnectionError");
	});

	it("WebSocketError has correct _tag", () => {
		const err = new WebSocketError({ message: "ws failure" });
		expect(err._tag).toBe("WebSocketError");
	});

	it("AuthenticationError has correct _tag", () => {
		const err = new AuthenticationError({ message: "auth failed" });
		expect(err._tag).toBe("AuthenticationError");
	});

	it("ConfigurationError has correct _tag", () => {
		const err = new ConfigurationError({ message: "bad config" });
		expect(err._tag).toBe("ConfigurationError");
	});

	it("PersistenceError._tag is PersistenceError", () => {
		const err = new PersistenceError({
			message: "Write failed",
			code: "WRITE_FAILED",
		});
		expect(err._tag).toBe("PersistenceError");
		expect(err.code).toBe("WRITE_FAILED");
	});

	it("PersistenceError message includes code prefix", () => {
		const err = new PersistenceError({
			message: "disk full",
			code: "APPEND_FAILED",
		});
		expect(err.message).toContain("disk full");
	});

	it("PersistenceError.toLog returns structured output", () => {
		const err = new PersistenceError({
			message: "test",
			code: "MIGRATION_FAILED",
			context: { table: "events" },
		});
		const log = err.toLog();
		expect(log.error).toBe("PersistenceError");
		expect(log.code).toBe("MIGRATION_FAILED");
	});

	it("RelayError base class supports generic codes", () => {
		const err = new RelayError("base error", { code: "INTERNAL_ERROR" });
		expect(err._tag).toBe("INTERNAL_ERROR");
		expect(err.message).toBe("base error");
	});

	it("RelayError toJSON works", () => {
		const err = new RelayError("test error", { code: "INTERNAL_ERROR" });
		const json = err.toJSON();
		expect(json.error.code).toBe("INTERNAL_ERROR");
		expect(json.error.message).toBe("test error");
	});

	it("RelayError.fromCaught still works for backward compat", () => {
		const err = RelayError.fromCaught(new Error("oops"), "INTERNAL_ERROR");
		expect(err._tag).toBe("INTERNAL_ERROR");
		expect(err.message).toContain("oops");
	});
});
