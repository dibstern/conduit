import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleProxyDetect } from "../../../src/lib/handlers/instance.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("handleProxyDetect", () => {
	let deps: HandlerDeps;
	let sentMessages: Array<{ clientId: string; msg: unknown }>;

	beforeEach(() => {
		sentMessages = [];
		deps = createMockHandlerDeps({
			wsHandler: {
				broadcast: vi.fn(),
				sendTo: (clientId: string, msg: unknown) =>
					sentMessages.push({ clientId, msg }),
			} as unknown as HandlerDeps["wsHandler"],
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("responds with proxy_detected found=false when fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
		);
		await handleProxyDetect(deps, "client-1", {});
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.msg).toMatchObject({
			type: "proxy_detected",
			found: false,
		});
	});

	it("responds with proxy_detected found=true when fetch succeeds", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
		);
		await handleProxyDetect(deps, "client-1", {});
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.msg).toMatchObject({
			type: "proxy_detected",
			found: true,
			port: 8317,
		});
	});

	it("responds with found=false when health returns non-2xx", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
		);
		await handleProxyDetect(deps, "client-1", {});
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.msg).toMatchObject({
			type: "proxy_detected",
			found: false,
			port: 8317,
		});
	});
});
