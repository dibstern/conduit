import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SetPin, WsRpcRequest } from "../../../src/lib/contracts/ws-rpc.js";

describe("Daemon RPC command schema validation", () => {
	it.each([
		null,
		"1234",
		"12345678",
	])("accepts explicit SetPin value %j", (pin) => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(SetPin)({ _tag: "SetPin", pin }),
			),
		).toBe(true);
	});

	it.each([
		"",
		"123",
		"123456789",
		"abcd",
		undefined,
	])("rejects invalid SetPin value %j", (pin) => {
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(SetPin)({ _tag: "SetPin", pin }),
			),
		).toBe(true);
	});

	it("decodes add_project command", () => {
		const raw = { _tag: "AddProject", directory: "/home/user/project" };
		const result = Schema.decodeUnknownEither(WsRpcRequest)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects add_project with empty directory", () => {
		const raw = { _tag: "AddProject", directory: "" };
		const result = Schema.decodeUnknownEither(WsRpcRequest)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects unknown command", () => {
		const raw = { _tag: "not_a_command" };
		const result = Schema.decodeUnknownEither(WsRpcRequest)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes a parsed tagged JSON request", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)(
			JSON.parse('{"_tag":"AddProject","directory":"/home/user/project"}'),
		);
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes get_status command", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "GetStatus",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes list_projects command", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "GetProjects",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes shutdown command", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "Shutdown",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes restart_with_config command", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "RestartWithConfig",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes restart_with_config command with config overrides", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "RestartWithConfig",
			config: { tls: true, port: 2634 },
		});
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result) && result.right._tag === "RestartWithConfig") {
			expect(result.right.config).toEqual({ tls: true, port: 2634 });
		}
	});

	it("decodes instance_list command", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "GetInstances",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes remove_project with slug", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "RemoveProject",
			slug: "my-project",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects remove_project with empty slug", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "RemoveProject",
			slug: "",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_project_title", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "RenameProject",
			slug: "proj",
			title: "My Title",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects set_project_title with empty slug", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "RenameProject",
			slug: "",
			title: "foo",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_pin with valid PIN", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetPin",
			pin: "1234",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects set_pin with non-digit PIN", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetPin",
			pin: "abcd",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects set_pin with too-short PIN", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetPin",
			pin: "12",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_keep_awake", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetKeepAwake",
			enabled: true,
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects set_keep_awake without boolean enabled", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetKeepAwake",
			enabled: "yes",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_keep_awake_command with args", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetKeepAwakeCommand",
			command: "caffeinate",
			args: ["-d"],
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes set_keep_awake_command with args defaulting to []", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetKeepAwakeCommand",
			command: "caffeinate",
		});
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right._tag).toBe("SetKeepAwakeCommand");
			if (result.right._tag === "SetKeepAwakeCommand")
				expect(result.right.args).toEqual([]);
		}
	});

	it("rejects set_keep_awake_command with empty command", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetKeepAwakeCommand",
			command: "",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes set_agent", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetAgent",
			slug: "proj",
			agent: "claude",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes set_model through the existing SetDefaultModel RPC", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SetDefaultModel",
			projectSlug: "proj",
			provider: "anthropic",
			model: "claude-3",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_add managed with port", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "AddInstance",
			name: "work",
			managed: true,
			port: 4097,
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_add unmanaged with url", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "AddInstance",
			name: "remote",
			managed: false,
			url: "http://host:4096",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_add unmanaged with port", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "AddInstance",
			name: "remote",
			managed: false,
			port: 4096,
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_remove with id", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "RemoveInstance",
			instanceId: "abc",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects instance_remove with empty id", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "RemoveInstance",
			instanceId: "",
		});
		expect(Either.isLeft(result)).toBe(true);
	});

	it("decodes instance_update with id", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "UpdateInstance",
			instanceId: "abc",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_update with optional fields", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "UpdateInstance",
			instanceId: "abc",
			name: "new-name",
			port: 4097,
			env: { KEY: "val" },
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes instance_status with id", () => {
		const result = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "GetInstanceStatus",
			instanceId: "abc",
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects missing and unknown request tags", () => {
		for (const raw of [{}, { _tag: "Unknown" }]) {
			expect(Either.isLeft(Schema.decodeUnknownEither(WsRpcRequest)(raw))).toBe(
				true,
			);
		}
	});
});
