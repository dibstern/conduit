// biome-ignore-all lint/suspicious/noExplicitAny: decoded union members need `as any` to access variant-specific fields in tests
// ─── WebSocket Incoming Message Schema Tests ─────────────────────────────────
// Tests for Effect Schema validation of ALL incoming WebSocket message types.
// The IncomingWsMessage union schema validates the full message (type + payload),
// unlike PayloadSchemas which only validate the payload after type extraction.

import { describe, it } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import { expect } from "vitest";

import {
	decodeWsMessage,
	IncomingWsMessage,
} from "../../../src/lib/contracts/ws-message-schemas.js";

// ─── Decode helper (Effect-based) ──────────────────────────────────────────

describe("decodeWsMessage", () => {
	it.effect("decodes pty_input with ptyId and data", () =>
		Effect.gen(function* () {
			const raw = { type: "pty_input", ptyId: "pty-1", data: "ls\n" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("pty_input");
			expect((decoded as any).data).toBe("ls\n");
		}),
	);
});

// ─── Schema rejection tests (synchronous Either-based) ──────────────────────

describe("IncomingWsMessage schema rejections", () => {
	it("rejects unknown message type", () => {
		const raw = { type: "totally_unknown_type" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects missing type field", () => {
		const raw = { sessionId: "s1" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects the removed legacy message type", () => {
		const raw = { type: "message", content: "wrong field" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects pty_input missing ptyId", () => {
		const raw = { type: "pty_input", data: "ls\n" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it.each([
		"new_session",
		"switch_session",
		"delete_session",
		"fork_session",
		"view_session",
		"terminal_command",
		"pty_create",
		"pty_resize",
		"pty_close",
		"add_project",
		"remove_project",
		"rename_project",
		"instance_add",
		"instance_remove",
		"instance_start",
		"instance_stop",
		"instance_update",
		"instance_rename",
		"set_project_instance",
		"proxy_detect",
		"scan_now",
		"permission_response",
		"ask_user_response",
		"question_reject",
		"set_log_level",
	])("rejects retired incoming message %s", (type) => {
		const result = Schema.decodeUnknownEither(IncomingWsMessage)({ type });
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── Exhaustiveness: every IncomingMessageType has a schema ──────────────────

describe("IncomingWsMessage coverage", () => {
	// Incoming message types from ws-router.ts (the source of truth).
	// This test ensures IncomingWsMessage covers every one.
	const ALL_INCOMING_TYPES = ["pty_input"] as const;

	// For each type, construct a minimal valid payload and verify it decodes.
	// This catches missing union members at test time.
	const MINIMAL_PAYLOADS: Record<string, Record<string, unknown>> = {
		pty_input: { ptyId: "p1", data: "x" },
	};

	for (const msgType of ALL_INCOMING_TYPES) {
		it(`accepts valid ${msgType} message`, () => {
			const payload = MINIMAL_PAYLOADS[msgType] ?? {};
			const raw = { type: msgType, ...payload };
			const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
			expect(
				Either.isRight(result),
				`Expected ${msgType} to decode successfully but got Left`,
			).toBe(true);
		});
	}
});
