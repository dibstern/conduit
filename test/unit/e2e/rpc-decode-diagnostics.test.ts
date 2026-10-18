import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Stream } from "effect";
import type { RpcMessage } from "effect/rpc";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../src/lib/utils.js";
import { RpcDecodeDiagnostics } from "../../helpers/rpc-decode-diagnostics.js";
import { serveRpc } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

const instances: StubTable = { GetInstances: () => ({ instances: [] }) };
const instancesRequest = (id: string): RpcMessage.RequestEncoded => ({
	_tag: "Request",
	id,
	tag: "GetInstances",
	payload: { _tag: "GetInstances" },
	headers: [],
});
const serverReply = (table: StubTable, request: RpcMessage.RequestEncoded) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const reply = yield* Deferred.make<string>();
				const receive = yield* serveRpc(table, (json) =>
					Deferred.succeed(reply, json).pipe(Effect.asVoid),
				);
				yield* receive(JSON.stringify(request));
				return yield* Deferred.await(reply);
			}),
		),
	);

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

	it("correlates an invalid unary response without changing the frame or capturing valid responses", async () => {
		const diagnostics = new RpcDecodeDiagnostics(build);
		const parser = diagnostics.serialization("/rpc").makeUnsafe();
		const bad = instancesRequest("1");
		const good = instancesRequest("2");
		parser.encode(bad);
		parser.encode(good);
		parser.decode(await serverReply(instances, good));
		expect(diagnostics.failures).toEqual([]);
		// Corrupt only the value after the real engine encoded a valid reply.
		const frame: unknown = JSON.parse(await serverReply(instances, bad));
		assert(isRecord(frame) && isRecord(frame["exit"]));
		frame["exit"]["value"] = {
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
		};
		expect(parser.decode(JSON.stringify(frame))).toEqual([frame]);
		expect(diagnostics.failures).toHaveLength(1);
		expect(diagnostics.failures[0]).toMatchObject({
			rpc: "GetInstances",
			requestId: bad.id,
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

	it("captures the schema path of a retired state in a stream chunk", async () => {
		const diagnostics = new RpcDecodeDiagnostics(build);
		const parser = diagnostics.serialization("/rpc").makeUnsafe();
		const request: RpcMessage.RequestEncoded = {
			_tag: "Request",
			id: "3",
			tag: "SubscribeProjectSettings",
			payload: { projectSlug: "project" },
			headers: [],
		};
		parser.encode(request);
		const frame: unknown = JSON.parse(
			await serverReply(
				{
					SubscribeProjectSettings: () =>
						Stream.succeed({ _tag: "synchronized" }),
				},
				request,
			),
		);
		assert(isRecord(frame) && Array.isArray(frame["values"]));
		frame["values"] = [
			{
				_tag: "upsert",
				sequence: 1,
				item: {
					_tag: "opencodeConnection",
					instanceId: "opencode",
					status: "disconnected",
					authorization: "Bearer auth-tripwire",
					cookie: "pin=pin-tripwire",
				},
			},
		];
		parser.decode(JSON.stringify(frame));
		expect(diagnostics.failures[0]).toMatchObject({
			rpc: "SubscribeProjectSettings",
			requestId: request.id,
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
		const parser = diagnostics.serialization("/rpc").makeUnsafe();
		expect(() => parser.decode(raw)).toThrow();
		expect(diagnostics.failures).toHaveLength(1);
		expect(diagnostics.failures[0]?.schemaPaths).toEqual([[]]);
		expect(diagnostics.failures[0]?.rawPayload).not.toContain(
			"malformed-tripwire",
		);
	});

	it("persists decode evidence immediately, before a failed connect can lose the harness", async () => {
		const root = mkdtempSync(join(tmpdir(), "rpc-decode-evidence-"));
		const artifact = join(root, "test-results", "decode.json");
		try {
			const diagnostics = new RpcDecodeDiagnostics(build, artifact);
			const parser = diagnostics.serialization("/rpc").makeUnsafe();
			const request = instancesRequest("4");
			parser.encode(request);
			const frame: unknown = JSON.parse(await serverReply(instances, request));
			assert(isRecord(frame) && isRecord(frame["exit"]));
			frame["exit"]["value"] = {
				instances: "bad-schema",
				password: "eager-tripwire",
			};
			parser.decode(JSON.stringify(frame));
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
