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
} from "../../../src/lib/effect/ws-message-schemas.js";

// ─── Decode helper (Effect-based) ──────────────────────────────────────────

describe("decodeWsMessage", () => {
	it.effect("decodes a simple no-payload message (list_sessions)", () =>
		Effect.gen(function* () {
			const raw = { type: "list_sessions" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("list_sessions");
		}),
	);

	it.effect("decodes message with payload (message)", () =>
		Effect.gen(function* () {
			const raw = { type: "message", text: "hello" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("message");
			expect((decoded as any).text).toBe("hello");
		}),
	);

	it.effect("decodes message with optional images (message)", () =>
		Effect.gen(function* () {
			const raw = {
				type: "message",
				text: "look at this",
				images: ["data:image/png;base64,abc"],
			};
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("message");
			expect((decoded as any).images).toEqual(["data:image/png;base64,abc"]);
		}),
	);

	it.effect("decodes get_file_content with path", () =>
		Effect.gen(function* () {
			const raw = { type: "get_file_content", path: "/src/main.ts" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("get_file_content");
			expect((decoded as any).path).toBe("/src/main.ts");
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

	it.effect("decodes rename_session with sessionId and title", () =>
		Effect.gen(function* () {
			const raw = {
				type: "rename_session",
				sessionId: "s1",
				title: "New Title",
			};
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("rename_session");
			expect((decoded as any).title).toBe("New Title");
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

	it.effect("decodes search_sessions with query", () =>
		Effect.gen(function* () {
			const raw = { type: "search_sessions", query: "bug fix" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("search_sessions");
			expect((decoded as any).query).toBe("bug fix");
		}),
	);

	it.effect("decodes switch_model with modelId and providerId", () =>
		Effect.gen(function* () {
			const raw = {
				type: "switch_model",
				modelId: "claude-opus-4-0-20250514",
				providerId: "anthropic",
			};
			const decoded = yield* decodeWsMessage(raw);
			expect((decoded as any).modelId).toBe("claude-opus-4-0-20250514");
			expect((decoded as any).providerId).toBe("anthropic");
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

	it.effect("decodes reload_provider_session (empty payload)", () =>
		Effect.gen(function* () {
			const raw = { type: "reload_provider_session" };
			const decoded = yield* decodeWsMessage(raw);
			expect(decoded.type).toBe("reload_provider_session");
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

	it("rejects message type with wrong payload shape", () => {
		// 'message' requires { text: string }, not { content: string }
		const raw = { type: "message", content: "wrong field" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects switch_session missing sessionId", () => {
		const raw = { type: "switch_session" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects rename_session missing title", () => {
		const raw = { type: "rename_session", sessionId: "s1" };
		const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects get_file_content missing path", () => {
		const raw = { type: "get_file_content" };
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
	// All 43 incoming message types from ws-router.ts (the source of truth).
	// This test ensures IncomingWsMessage covers every one.
	const ALL_INCOMING_TYPES = [
		"message",
		"permission_response",
		"ask_user_response",
		"question_reject",
		"new_session",
		"switch_session",
		"delete_session",
		"rename_session",
		"fork_session",
		"list_sessions",
		"search_sessions",
		"load_more_history",
		"terminal_command",
		"input_sync",
		"switch_agent",
		"switch_model",
		"get_todo",
		"get_agents",
		"get_models",
		"get_commands",
		"get_projects",
		"add_project",
		"list_directories",
		"remove_project",
		"rename_project",
		"get_file_list",
		"get_file_content",
		"get_file_tree",
		"get_tool_content",
		"pty_create",
		"pty_input",
		"pty_resize",
		"pty_close",
		"cancel",
		"rewind",
		"instance_add",
		"instance_remove",
		"instance_start",
		"instance_stop",
		"instance_update",
		"instance_rename",
		"set_project_instance",
		"set_default_model",
		"switch_variant",
		"view_session",
		"proxy_detect",
		"scan_now",
		"set_log_level",
		"reload_provider_session",
	] as const;

	// For each type, construct a minimal valid payload and verify it decodes.
	// This catches missing union members at test time.
	const MINIMAL_PAYLOADS: Record<string, Record<string, unknown>> = {
		message: { text: "hi" },
		permission_response: { requestId: "per_x", decision: "allow" },
		ask_user_response: { toolId: "t1", answers: {} },
		question_reject: { toolId: "t1" },
		new_session: {},
		switch_session: { sessionId: "s1" },
		delete_session: { sessionId: "s1" },
		rename_session: { sessionId: "s1", title: "t" },
		fork_session: {},
		list_sessions: {},
		search_sessions: { query: "q" },
		load_more_history: { offset: 0 },
		terminal_command: { action: "list" },
		input_sync: { text: "draft" },
		switch_agent: { agentId: "a1" },
		switch_model: { modelId: "m1", providerId: "p1" },
		get_todo: {},
		get_agents: {},
		get_models: {},
		get_commands: {},
		get_projects: {},
		add_project: { directory: "/tmp" },
		list_directories: { path: "/" },
		remove_project: { slug: "s" },
		rename_project: { slug: "s", title: "t" },
		get_file_list: {},
		get_file_content: { path: "/f" },
		get_file_tree: {},
		get_tool_content: { toolId: "t1" },
		pty_create: {},
		pty_input: { ptyId: "p1", data: "x" },
		pty_resize: { ptyId: "p1" },
		pty_close: { ptyId: "p1" },
		cancel: {},
		rewind: {},
		instance_add: { name: "n" },
		instance_remove: { instanceId: "i1" },
		instance_start: { instanceId: "i1" },
		instance_stop: { instanceId: "i1" },
		instance_update: { instanceId: "i1" },
		instance_rename: { instanceId: "i1", name: "n" },
		set_project_instance: { slug: "s", instanceId: "i1" },
		set_default_model: { provider: "p", model: "m" },
		switch_variant: { variant: "v" },
		view_session: { sessionId: "s1" },
		proxy_detect: {},
		scan_now: {},
		set_log_level: { level: "debug" },
		reload_provider_session: {},
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
