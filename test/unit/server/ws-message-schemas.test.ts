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
	it.effect("decodes terminal_command with action", () =>
		Effect.gen(function* () {
			const raw = { type: "terminal_command", action: "list" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("terminal_command");
			expect((decoded as any).action).toBe("list");
		}),
	);

	it.effect("decodes switch_session with sessionId", () =>
		Effect.gen(function* () {
			const raw = { type: "switch_session", sessionId: "sess-123" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("switch_session");
			expect((decoded as any).sessionId).toBe("sess-123");
		}),
	);

	it.effect("decodes fork_session with optional fields", () =>
		Effect.gen(function* () {
			const raw = { type: "fork_session" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("fork_session");
		}),
	);

	it.effect("decodes fork_session with all fields", () =>
		Effect.gen(function* () {
			const raw = {
				type: "fork_session",
				sessionId: "s1",
				messageId: "m1",
			};
			const decoded = yield* decodeWsMessage(raw);
			expect((decoded as any).sessionId).toBe("s1");
			expect((decoded as any).messageId).toBe("m1");
		}),
	);

	it.effect("decodes instance_add with name and optional fields", () =>
		Effect.gen(function* () {
			const raw = {
				type: "instance_add",
				name: "dev-server",
				port: 8080,
				managed: true,
			};
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("instance_add");
			expect((decoded as any).name).toBe("dev-server");
			expect((decoded as any).port).toBe(8080);
		}),
	);

	it.effect("decodes pty_input with ptyId and data", () =>
		Effect.gen(function* () {
			const raw = { type: "pty_input", ptyId: "pty-1", data: "ls\n" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("pty_input");
			expect((decoded as any).data).toBe("ls\n");
		}),
	);

	it.effect("decodes pty_resize with optional cols/rows", () =>
		Effect.gen(function* () {
			const raw = {
				type: "pty_resize",
				ptyId: "pty-1",
				cols: 120,
				rows: 40,
			};
			const decoded = yield* decodeWsMessage(raw);
			expect((decoded as any).cols).toBe(120);
			expect((decoded as any).rows).toBe(40);
		}),
	);

	it.effect("decodes set_log_level with level", () =>
		Effect.gen(function* () {
			const raw = { type: "set_log_level", level: "debug" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("set_log_level");
			expect((decoded as any).level).toBe("debug");
		}),
	);

	it.effect("decodes permission_response with branded requestId", () =>
		Effect.gen(function* () {
			const raw = {
				type: "permission_response",
				requestId: "per_abc123",
				decision: "allow",
			};
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("permission_response");
			expect((decoded as any).decision).toBe("allow");
		}),
	);

	it.effect("decodes add_project with directory", () =>
		Effect.gen(function* () {
			const raw = { type: "add_project", directory: "/home/user/project" };
			const decoded = yield* decodeWsMessage(raw);
			expect((decoded as any).directory).toBe("/home/user/project");
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

	it("rejects switch_session missing sessionId", () => {
		const raw = { type: "switch_session" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects terminal_command missing action", () => {
		const raw = { type: "terminal_command" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects pty_input missing ptyId", () => {
		const raw = { type: "pty_input", data: "ls\n" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── Exhaustiveness: every IncomingMessageType has a schema ──────────────────

describe("IncomingWsMessage coverage", () => {
	// Incoming message types from ws-router.ts (the source of truth).
	// This test ensures IncomingWsMessage covers every one.
	const ALL_INCOMING_TYPES = [
		"permission_response",
		"ask_user_response",
		"question_reject",
		"new_session",
		"switch_session",
		"delete_session",
		"fork_session",
		"terminal_command",
		"add_project",
		"remove_project",
		"rename_project",
		"pty_create",
		"pty_input",
		"pty_resize",
		"pty_close",
		"rewind",
		"instance_add",
		"instance_remove",
		"instance_start",
		"instance_stop",
		"instance_update",
		"instance_rename",
		"set_project_instance",
		"view_session",
		"proxy_detect",
		"scan_now",
		"set_log_level",
	] as const;

	// For each type, construct a minimal valid payload and verify it decodes.
	// This catches missing union members at test time.
	const MINIMAL_PAYLOADS: Record<string, Record<string, unknown>> = {
		permission_response: { requestId: "per_x", decision: "allow" },
		ask_user_response: { toolId: "t1", answers: {} },
		question_reject: { toolId: "t1" },
		new_session: {},
		switch_session: { sessionId: "s1" },
		delete_session: { sessionId: "s1" },
		fork_session: {},
		terminal_command: { action: "list" },
		add_project: { directory: "/tmp" },
		remove_project: { slug: "s" },
		rename_project: { slug: "s", title: "t" },
		pty_create: {},
		pty_input: { ptyId: "p1", data: "x" },
		pty_resize: { ptyId: "p1" },
		pty_close: { ptyId: "p1" },
		rewind: {},
		instance_add: { name: "n" },
		instance_remove: { instanceId: "i1" },
		instance_start: { instanceId: "i1" },
		instance_stop: { instanceId: "i1" },
		instance_update: { instanceId: "i1" },
		instance_rename: { instanceId: "i1", name: "n" },
		set_project_instance: { slug: "s", instanceId: "i1" },
		view_session: { sessionId: "s1" },
		proxy_detect: {},
		scan_now: {},
		set_log_level: { level: "debug" },
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
