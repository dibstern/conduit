import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	IPCCommandSchema,
	parseCommand,
	VALID_COMMANDS,
	validateCommand,
} from "../../../src/lib/daemon/ipc-protocol.js";

describe("IPC Command Schema validation", () => {
	// ─── Basic decode tests ────────────────────────────────────────────────

	it("decodes add_project command", () => {
		const raw = { cmd: "add_project", directory: "/home/user/project" };
		const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects add_project with empty directory", () => {
		const raw = { cmd: "add_project", directory: "" };
		const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects unknown command", () => {
		const raw = { cmd: "not_a_command" };
		const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("parseCommand handles invalid JSON", () => {
		const result = parseCommand("not json");
		expect(result).toBeNull();
	});

	it("parseCommand decodes valid command", () => {
		const result = parseCommand('{"cmd":"get_status"}');
		expect(result).not.toBeNull();
		expect(result?.cmd).toBe("get_status");
	});

	// ─── No-field commands ─────────────────────────────────────────────────

	it("decodes get_status command", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "get_status",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes list_projects command", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "list_projects",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes shutdown command", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "shutdown",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes restart_with_config command", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "restart_with_config",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_list command", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_list",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	// ─── Commands with fields ──────────────────────────────────────────────

	it("decodes remove_project with slug", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "remove_project",
			slug: "my-project",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects remove_project with empty slug", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "remove_project",
			slug: "",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_project_title", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_project_title",
			slug: "proj",
			title: "My Title",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects set_project_title with empty slug", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_project_title",
			slug: "",
			title: "foo",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_pin with valid PIN", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_pin",
			pin: "1234",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects set_pin with non-digit PIN", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_pin",
			pin: "abcd",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects set_pin with too-short PIN", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_pin",
			pin: "12",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_keep_awake", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_keep_awake",
			enabled: true,
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects set_keep_awake without boolean enabled", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_keep_awake",
			enabled: "yes",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_keep_awake_command with args", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_keep_awake_command",
			command: "caffeinate",
			args: ["-d"],
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes set_keep_awake_command with args defaulting to []", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_keep_awake_command",
			command: "caffeinate",
		});
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			const cmd = result.right as { cmd: string; args: string[] };
			expect(cmd.args).toEqual([]);
		}
	});

	it("rejects set_keep_awake_command with empty command", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_keep_awake_command",
			command: "",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_agent", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_agent",
			slug: "proj",
			agent: "claude",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes set_model", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "set_model",
			slug: "proj",
			provider: "anthropic",
			model: "claude-3",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	// ─── Instance commands ─────────────────────────────────────────────────

	it("decodes instance_add managed with port", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_add",
			name: "work",
			managed: true,
			port: 4097,
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects instance_add managed without port", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_add",
			name: "work",
			managed: true,
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects instance_add managed with url", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_add",
			name: "work",
			managed: true,
			port: 4097,
			url: "http://host:4097",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes instance_add unmanaged with url", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_add",
			name: "remote",
			managed: false,
			url: "http://host:4096",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_add unmanaged with port", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_add",
			name: "remote",
			managed: false,
			port: 4096,
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects instance_add unmanaged without url or port", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_add",
			name: "remote",
			managed: false,
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes instance_remove with id", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_remove",
			id: "abc",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects instance_remove with empty id", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_remove",
			id: "",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes instance_update with id", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_update",
			id: "abc",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_update with optional fields", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_update",
			id: "abc",
			name: "new-name",
			port: 4097,
			env: { KEY: "val" },
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_status with id", () => {
		const result = Schema.decodeUnknownEither(IPCCommandSchema)({
			cmd: "instance_status",
			id: "abc",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	// ─── Compatibility ─────────────────────────────────────────────────────

	it("validateCommand still works (backward compat)", () => {
		const valid = validateCommand({ cmd: "get_status" });
		expect(valid).toBeNull();

		const invalid = validateCommand({ cmd: "not_a_command" });
		expect(invalid).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(invalid!.ok).toBe(false);
	});

	it("VALID_COMMANDS still has 19 entries", () => {
		expect(VALID_COMMANDS.size).toBe(19);
	});
});
