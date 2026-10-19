import { describe, expect, it } from "vitest";
import { makeWsRpcUrl } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

describe("frontend WebSocket RPC client", () => {
	it("targets the shared RPC websocket endpoint", () => {
		expect(
			makeWsRpcUrl({
				protocol: "https:",
				host: "localhost:2633",
			}),
		).toBe("wss://localhost:2633/rpc");
		expect(
			makeWsRpcUrl({
				protocol: "http:",
				host: "localhost:2633",
			}),
		).toBe("ws://localhost:2633/rpc");
	});
});
