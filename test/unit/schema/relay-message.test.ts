import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RelayMessageSchema } from "../../../src/lib/shared-types.js";

describe("RelayMessage Schema", () => {
	it("decodes delta message", () => {
		const raw = { type: "delta", sessionId: "s1", text: "hello" };
		const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes thinking_start message", () => {
		const raw = { type: "thinking_start", sessionId: "s1" };
		const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes error message", () => {
		const raw = {
			type: "error",
			sessionId: "s1",
			code: "AUTH_REQUIRED",
			message: "PIN required",
		};
		const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects unknown message type", () => {
		const raw = { type: "not_a_real_type", sessionId: "s1" };
		const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects message missing required fields", () => {
		const raw = { type: "delta" }; // missing sessionId, text
		const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("requires provider scope on agent list messages", () => {
		const scoped = {
			type: "agent_list",
			providerScope: { id: "claude", name: "Claude" },
			agents: [{ id: "Explore", name: "Explore" }],
		};
		const missingScope = {
			type: "agent_list",
			agents: [{ id: "Explore", name: "Explore" }],
		};

		expect(
			Either.isRight(Schema.decodeUnknownEither(RelayMessageSchema)(scoped)),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(RelayMessageSchema)(missingScope),
			),
		).toBe(true);
	});

	it("RelayMessage type is compatible with existing code", () => {
		const msg: typeof RelayMessageSchema.Type = {
			type: "delta",
			sessionId: "s1",
			text: "hello",
		};
		expect(msg.type).toBe("delta");
	});
});
