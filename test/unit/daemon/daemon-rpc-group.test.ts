import { describe, it } from "@effect/vitest";
import { Either, Schema } from "effect";
import { expect } from "vitest";
import {
	RestartWithConfig,
	SaveProject,
	SetKeepAwakeCommand,
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
		]) {
			expect(WsRpcGroup.requests.has(name)).toBe(true);
		}
		expect(WsRpcGroup.requests.has("SetModel")).toBe(false);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(WsRpcRequest)({
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
				Either.isRight(
					Schema.decodeUnknownEither(SetPin)({
						_tag: "SetPin",
						pin,
					}),
				),
			).toBe(true);
		}
		for (const pin of ["", "123", "123456789", "12ab", 1234]) {
			expect(
				Either.isLeft(
					Schema.decodeUnknownEither(SetPin)({
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
		expect(request).toEqual(
			new SetKeepAwakeCommand({
				command: "caffeinate",
				args: [],
			}),
		);
	});

	it("preserves restart overrides across schema encoding and decoding", () => {
		const request = Schema.decodeUnknownSync(WsRpcRequest)({
			_tag: "RestartWithConfig",
			config: { tls: true, port: 0, keepAwakeArgs: ["-di"] },
		});
		expect(request).toBeInstanceOf(RestartWithConfig);
		expect(Schema.encodeSync(WsRpcRequest)(request)).toEqual({
			_tag: "RestartWithConfig",
			config: { tls: true, port: 0, keepAwakeArgs: ["-di"] },
		});
	});

	it("keeps existing project requests on the same contract", () => {
		const request = new SaveProject({ folders: ["/tmp/daemon-rpc-project"] });
		expect(
			Schema.decodeUnknownSync(WsRpcRequest)(
				Schema.encodeSync(WsRpcRequest)(request),
			),
		).toEqual(request);
	});
});
