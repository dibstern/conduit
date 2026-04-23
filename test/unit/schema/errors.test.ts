import { describe, expect, it } from "vitest";
import {
	AuthenticationError,
	ConfigurationError,
	OpenCodeApiError,
	OpenCodeConnectionError,
	RelayError,
	SSEConnectionError,
	WebSocketError,
} from "../../../src/lib/errors.js";
import { PersistenceError } from "../../../src/lib/persistence/errors.js";

describe("Schema-based errors", () => {
	it("OpenCodeApiError has _tag discriminant", () => {
		const err = new OpenCodeApiError({
			message: "Not found",
			endpoint: "/api/test",
			responseStatus: 404,
			responseBody: { detail: "missing" },
		});
		expect(err._tag).toBe("OpenCodeApiError");
		// 4xx errors with responseBody enrich the message
		expect(err.message).toContain("Not found");
		expect(err.endpoint).toBe("/api/test");
		expect(err.responseStatus).toBe(404);
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

	it("OpenCodeApiError serializes to WebSocket", () => {
		const err = new OpenCodeApiError({
			message: "Timeout",
			endpoint: "/api/slow",
			responseStatus: 504,
			responseBody: null,
		});
		const ws = err.toWebSocket();
		expect(ws.type).toBe("error");
		expect(ws.code).toBe("OpenCodeApiError");
	});

	it("OpenCodeConnectionError constructs correctly", () => {
		const err = new OpenCodeConnectionError({ message: "Connection refused" });
		expect(err._tag).toBe("OpenCodeConnectionError");
		expect(err.message).toBe("Connection refused");
	});

	it("RelayError union decodes tagged errors", () => {
		const apiErr = new OpenCodeApiError({
			message: "test",
			endpoint: "/test",
			responseStatus: 500,
			responseBody: null,
		});
		expect(apiErr._tag).toBe("OpenCodeApiError");
		expect(apiErr instanceof Error).toBe(true);
	});

	it("PersistenceError has _tag discriminant", () => {
		const err = new PersistenceError({
			message: "Write failed",
			code: "WRITE_FAILED",
			context: { table: "events" },
		});
		expect(err._tag).toBe("PersistenceError");
		expect(err.code).toBe("WRITE_FAILED");
	});

	it("errors have userVisible defaulting to true", () => {
		const err = new OpenCodeConnectionError({ message: "test" });
		expect(err.userVisible).toBe(true);
	});

	it("errors have userVisible false when set", () => {
		const err = new OpenCodeConnectionError({
			message: "test",
			userVisible: false,
		});
		expect(err.userVisible).toBe(false);
	});

	it("SSEConnectionError has correct _tag", () => {
		const err = new SSEConnectionError({ message: "disconnected" });
		expect(err._tag).toBe("SSEConnectionError");
		expect(err.code).toBe("SSE_DISCONNECTED");
	});

	it("WebSocketError has correct _tag", () => {
		const err = new WebSocketError({ message: "ws failure" });
		expect(err._tag).toBe("WebSocketError");
		expect(err.code).toBe("WEBSOCKET_ERROR");
	});

	it("AuthenticationError has correct _tag", () => {
		const err = new AuthenticationError({ message: "auth failed" });
		expect(err._tag).toBe("AuthenticationError");
		expect(err.code).toBe("AUTH_FAILED");
	});

	it("ConfigurationError has correct _tag", () => {
		const err = new ConfigurationError({ message: "bad config" });
		expect(err._tag).toBe("ConfigurationError");
		expect(err.code).toBe("CONFIG_INVALID");
	});

	it("RelayError base class has _tag matching code", () => {
		const err = new RelayError("base error", { code: "INTERNAL_ERROR" });
		expect(err._tag).toBe("INTERNAL_ERROR");
	});
});
