import { describe, it } from "@effect/vitest";
import { Result as Either, Schema } from "effect";
import { expect } from "vitest";
import {
	RestartWithConfig,
	SetPin,
	WsRpcGroup,
	WsRpcRequest,
} from "../../../src/lib/contracts/ws-rpc.js";

describe("shared daemon RPC contracts", () => {
	it("exposes daemon commands in the browser RPC group", () => {
		for (const name of [
			"GetStatus",
			"SetPin",
			"SetKeepAwake",
			"SetKeepAwakeCommand",
			"Shutdown",
			"SetAgent",
			"SetDefaultModel",
			"RestartWithConfig",
			"GetInstances",
			"GetInstanceStatus",
			"ResolveSessionMode",
			"SetDefaultSessionMode",
		]) {
			expect(WsRpcGroup.requests.has(name)).toBe(true);
		}
		expect(WsRpcGroup.requests.has("SetModel")).toBe(false);
		expect(
			Either.isFailure(
				Schema.decodeUnknownResult(WsRpcRequest)({
					_tag: "SetModel",
					slug: "project",
					provider: "anthropic",
					model: "opus",
				}),
			),
		).toBe(true);
	});

	it("accepts only a four to eight digit PIN or clearing the PIN", () => {
		for (const pin of ["1234", "12345678", null]) {
			expect(
				Either.isSuccess(
					Schema.decodeUnknownResult(SetPin.payloadSchema)({
						_tag: "SetPin",
						pin,
					}),
				),
			).toBe(true);
		}
		for (const pin of ["", "123", "123456789", "12ab", 1234]) {
			expect(
				Either.isFailure(
					Schema.decodeUnknownResult(SetPin.payloadSchema)({
						_tag: "SetPin",
						pin,
					}),
				),
			).toBe(true);
		}
	});

	it("defaults keep-awake command arguments to an empty array", () => {
		const request = Schema.decodeUnknownSync(WsRpcRequest)({
			_tag: "SetKeepAwakeCommand",
			command: "caffeinate",
		});
		expect(request).toEqual({
			_tag: "SetKeepAwakeCommand",
			command: "caffeinate",
			args: [],
		});
	});

	it("drops restart overrides across schema encoding and decoding", () => {
		const request = Schema.decodeUnknownSync(WsRpcRequest)({
			_tag: "RestartWithConfig",
			config: { tls: true, port: 0, keepAwakeArgs: ["-di"] },
		});
		expect(request).toBeInstanceOf(RestartWithConfig);
		expect(Schema.encodeSync(WsRpcRequest)(request)).toEqual({
			_tag: "RestartWithConfig",
		});
	});

	it("keeps existing project requests on the same contract", () => {
		const request = {
			_tag: "SaveProject" as const,
			folders: ["/tmp/daemon-rpc-project"],
		};
		expect(
			Schema.decodeUnknownSync(WsRpcRequest)(
				Schema.encodeSync(WsRpcRequest)(request),
			),
		).toEqual(request);
	});

	it("keeps session-mode resolution and global writes on the shared contract", () => {
		for (const request of [
			{ _tag: "ResolveSessionMode", projectSlug: "project" },
			{
				_tag: "SetDefaultSessionMode",
				projectSlug: "project",
				mode: "worktree",
			},
		]) {
			expect(
				Schema.decodeUnknownSync(WsRpcRequest)(
					Schema.encodeSync(WsRpcRequest)(request),
				),
			).toEqual(request);
		}
	});
});
