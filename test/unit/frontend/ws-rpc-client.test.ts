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
});
