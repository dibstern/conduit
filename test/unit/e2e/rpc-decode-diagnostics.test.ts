import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RpcDecodeDiagnostics } from "../../helpers/rpc-decode-diagnostics.js";

// Local parser failure modes: unary vs stream schemas, interleaved requests,
// multiple errors, valid frames, malformed JSON, and auth in objects/headers/URLs.
describe("process RPC decode diagnostics", () => {
	const build = {
		client: "source",
		server: "source",
		dist: null,
		buildId: "dev",
		builtAt: null,
	} as const;

	it("correlates an invalid unary response without changing the frame or capturing valid responses", () => {
		const diagnostics = new RpcDecodeDiagnostics(build);
		const parser = diagnostics.serialization("/rpc").unsafeMake();
		parser.encode({ _tag: "Request", id: "bad", tag: "GetInstances" });
		parser.encode({ _tag: "Request", id: "good", tag: "GetInstances" });
		parser.decode(
			JSON.stringify({
				_tag: "Exit",
				requestId: "good",
				exit: { _tag: "Success", value: { instances: [] } },
			}),
		);
		expect(diagnostics.failures).toEqual([]);
		const frame = {
			_tag: "Exit",
			requestId: "bad",
			exit: {
				_tag: "Success",
				value: {
					instances: [
						{
							id: "opencode",
							name: "OpenCode",
							port: "stale-dist-port",
							managed: false,
							status: "stopped",
							restartCount: 0,
							createdAt: 0,
							env: {
								OPENCODE_SERVER_PASSWORD: "secret-tripwire",
								API_KEY: "api-tripwire",
							},
							url: "http://opencode:url-tripwire@example.test",
							headers: [["Authorization", "Basic header-tripwire"]],
						},
					],
				},
			},
		};
		expect(parser.decode(JSON.stringify(frame))).toEqual([frame]);
		expect(diagnostics.failures).toHaveLength(1);
		expect(diagnostics.failures[0]).toMatchObject({
			rpc: "GetInstances",
			requestId: "bad",
			endpoint: "/rpc",
			build,
			schemaPaths: [["exit", "value", "instances", 0, "port"]],
		});
		const evidence = JSON.stringify(diagnostics.failures);
		for (const secret of [
			"secret-tripwire",
			"api-tripwire",
			"url-tripwire",
			"header-tripwire",
		])
			expect(evidence).not.toContain(secret);
		expect(evidence).toContain("stale-dist-port");
	});

	it("captures the schema path of a retired state in a stream chunk", () => {
		const diagnostics = new RpcDecodeDiagnostics(build);
		const parser = diagnostics.serialization("/rpc").unsafeMake();
		parser.encode({
			_tag: "Request",
			id: "stream",
			tag: "SubscribeProjectSettings",
		});
		parser.decode(
			JSON.stringify({
				_tag: "Chunk",
				requestId: "stream",
				values: [
					{
						_tag: "upsert",
						item: {
							_tag: "opencodeConnection",
							instanceId: "opencode",
							status: "disconnected",
							authorization: "Bearer auth-tripwire",
							cookie: "pin=pin-tripwire",
						},
					},
				],
			}),
		);
		expect(diagnostics.failures[0]).toMatchObject({
			rpc: "SubscribeProjectSettings",
			requestId: "stream",
			schemaPaths: [["values", 0, "item", "status"]],
		});
		expect(JSON.stringify(diagnostics.failures)).not.toMatch(
			/auth-tripwire|pin-tripwire/,
		);
	});

	it.each([
		'{"Authorization":"Bearer malformed-tripwire",',
		'{"password":"malformed-tripwire',
	])("records malformed JSON with auth redacted: %s", (raw) => {
		const diagnostics = new RpcDecodeDiagnostics(build);
		const parser = diagnostics.serialization("/rpc").unsafeMake();
		expect(() => parser.decode(raw)).toThrow();
		expect(diagnostics.failures).toHaveLength(1);
		expect(diagnostics.failures[0]?.schemaPaths).toEqual([[]]);
		expect(diagnostics.failures[0]?.rawPayload).not.toContain(
			"malformed-tripwire",
		);
	});

	it("persists decode evidence immediately, before a failed connect can lose the harness", () => {
		const root = mkdtempSync(join(tmpdir(), "rpc-decode-evidence-"));
		const artifact = join(root, "test-results", "decode.json");
		try {
			const diagnostics = new RpcDecodeDiagnostics(build, artifact);
			const parser = diagnostics.serialization("/rpc").unsafeMake();
			parser.encode({ _tag: "Request", id: "early", tag: "GetInstances" });
			parser.decode(
				JSON.stringify({
					_tag: "Exit",
					requestId: "early",
					exit: {
						_tag: "Success",
						value: { instances: "bad-schema", password: "eager-tripwire" },
					},
				}),
			);
			expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual({
				buildIdentity: build,
				rpcDecodeFailures: diagnostics.failures,
			});
			expect(readFileSync(artifact, "utf8")).not.toContain("eager-tripwire");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
