import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeWsRpcUrl } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

describe("frontend WebSocket RPC client", () => {
	it("targets the project RPC websocket endpoint", () => {
		expect(
			makeWsRpcUrl("my project", {
				protocol: "https:",
				host: "localhost:2633",
			}),
		).toBe("wss://localhost:2633/p/my%20project/rpc");
	});

	it("uses the shared transport Promise boundary", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/frontend/transport/ws-rpc-client.ts"),
			"utf8",
		);

		expect(source).toContain("runTransportEffect");
		expect(source).not.toContain("getRuntime");
		expect(source).not.toContain(".runPromise(");
	});
});
