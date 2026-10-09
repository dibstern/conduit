import { describe, expect, it } from "vitest";
import { EffectWsHandler } from "../../../src/lib/server/effect-ws-handler.js";

describe("Effect WS handler viewer presence", () => {
	it("updates viewer state synchronously when registering an RPC viewer", () => {
		const handler = new EffectWsHandler();
		handler.setClientSession("browser-tab-1", "sess-1");
		const unregister = handler.registerSessionViewer("sess-1");

		expect(handler.getClientSession("browser-tab-1")).toBe("sess-1");
		expect(handler.getClientsForSession("sess-1")).toHaveLength(1);

		unregister();
		expect(handler.getClientsForSession("sess-1")).toEqual([]);
		handler.close();
	});
});
