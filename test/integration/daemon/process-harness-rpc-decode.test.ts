import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { isRecord } from "../../../src/lib/utils.js";
import {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure cases: a source client decoding a stale dist response, a bad stream
// before connect returns, unrelated concurrent frames, and leaked credentials.
describe("process harness RPC decode evidence", () => {
	let harness: ProcessHarness | undefined;
	let proxy: WebSocketServer | undefined;
	let passed = false;
	const sockets = new Set<WebSocket>();

	afterEach(async (context) => {
		try {
			for (const socket of sockets) socket.terminate();
			if (proxy) await new Promise<void>((done) => proxy?.close(() => done()));
			await harness?.dispose();
		} finally {
			const proof = harness?.proof();
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				`test-results/process-harness/rqbc-7-${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify(
					{
						passed: passed && proof?.disposed === true,
						proof,
					},
					null,
					2,
				),
			);
			sockets.clear();
			proxy = undefined;
			harness = undefined;
		}
	});

	it.each([
		"GetInstances",
		"SubscribeProjectSettings",
	] as const)("captures the offending %s frame and build identity with auth redacted", async (rpc) => {
		passed = false;
		harness = await ProcessHarness.start();
		const upstreamUrl = `${harness.baseUrl.replace("http:", "ws:")}/rpc`;
		const secret = "rpc-decode-auth-tripwire";
		proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise<void>((done) => proxy?.once("listening", done));
		const address = proxy.address();
		if (!address || typeof address === "string")
			throw new Error("No proxy port");
		let corrupted = false;
		proxy.on("connection", (client) => {
			const upstream = new WebSocket(upstreamUrl);
			sockets.add(client);
			sockets.add(upstream);
			const queued: string[] = [];
			const requests = new Map<string, string>();
			client.on("message", (data) => {
				const raw = data.toString();
				const request: unknown = JSON.parse(raw);
				if (isRecord(request) && request["_tag"] === "Request")
					requests.set(String(request["id"]), String(request["tag"]));
				if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
				else queued.push(raw);
			});
			upstream.once("open", () => {
				for (const raw of queued) upstream.send(raw);
			});
			upstream.on("message", (data) => {
				const frame: unknown = JSON.parse(data.toString());
				if (
					!corrupted &&
					isRecord(frame) &&
					requests.get(String(frame["requestId"])) === rpc
				) {
					if (
						rpc === "GetInstances" &&
						frame["_tag"] === "Exit" &&
						isRecord(frame["exit"])
					) {
						const value = frame["exit"]["value"];
						if (
							isRecord(value) &&
							Array.isArray(value["instances"]) &&
							isRecord(value["instances"][0])
						) {
							value["instances"][0]["port"] = "stale-dist-port";
							value["instances"][0]["env"] = {
								OPENCODE_SERVER_PASSWORD: secret,
							};
							value["instances"][0]["url"] =
								`http://opencode:${secret}@127.0.0.1:1234`;
							corrupted = true;
						}
					} else if (
						rpc === "SubscribeProjectSettings" &&
						frame["_tag"] === "Chunk"
					) {
						frame["values"] = [
							{
								_tag: "upsert",
								sequence: 0,
								item: {
									_tag: "opencodeConnection",
									instanceId: "opencode",
									status: "disconnected",
									Authorization: `Bearer ${secret}`,
								},
							},
						];
						corrupted = true;
					}
				}
				if (client.readyState === WebSocket.OPEN)
					client.send(JSON.stringify(frame));
			});
			client.once("close", () => upstream.terminate());
			upstream.once("close", () => client.terminate());
		});

		if (rpc === "GetInstances") {
			const browser = await ProcessBrowser.connect(
				address.port,
				undefined,
				undefined,
				"process-test",
				true,
				harness.rpcDiagnostics,
			);
			harness.browsers.push(browser);
			await expect(browser.instances()).rejects.toThrow();
		} else {
			await expect(
				ProcessBrowser.connect(
					address.port,
					undefined,
					undefined,
					"process-test",
					true,
					harness.rpcDiagnostics,
				),
			).rejects.toThrow(/status/);
		}
		expect(corrupted).toBe(true);
		const proof = harness.proof();
		expect(proof.rpcDecodeFailures).toHaveLength(1);
		const failure = proof.rpcDecodeFailures?.[0];
		expect(failure?.rpc).toBe(rpc);
		expect(failure?.endpoint).toBe(`ws://127.0.0.1:${address.port}/rpc`);
		expect(
			failure?.schemaPaths.some((path) =>
				path.includes(rpc === "GetInstances" ? "port" : "status"),
			),
		).toBe(true);
		expect(failure?.rawPayload).toContain(
			rpc === "GetInstances" ? "stale-dist-port" : "disconnected",
		);
		expect(failure?.rawPayload).toContain("[REDACTED]");
		expect(JSON.stringify(proof)).not.toContain(secret);
		expect(failure?.build.client).toBe("source");
		const dist = process.env["CONDUIT_TEST_DIST"];
		expect(failure?.build.server).toBe(dist ? "dist" : "source");
		if (dist) {
			expect(failure?.build.dist).toBe(resolve(dist));
			expect(failure?.build.buildId).toEqual(expect.any(String));
			expect(failure?.build.builtAt).toBe(
				statSync(resolve(dist, "src/lib/build-id.js")).mtime.toISOString(),
			);
		} else expect(failure?.build.builtAt).toBeNull();
		passed = true;
	});
});
