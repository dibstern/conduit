import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectSettingSchema } from "../../../src/lib/contracts/ws-rpc.js";
import {
	RELAY_MESSAGE_TYPES,
	RelayMessageSchema,
} from "../../../src/lib/shared-types.js";

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

	it("no longer carries facts that moved to subscriptions (ni8.12)", () => {
		for (const type of [
			"visibility_info",
			"claude_settings_info",
			"default_model_info",
			"default_permission_mode_info",
			"permission_mode_info",
		])
			expect(RELAY_MESSAGE_TYPES).not.toContain(type);
	});

	it("rejects a non-JSON Claude settings fact", () => {
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(ProjectSettingSchema)({
					_tag: "claudeSettings",
					overrides: { invalid: Number.NaN },
				}),
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
