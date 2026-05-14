// ─── Tests: WS Router PTY Message Types ──────────────────────────────────────
// Verifies that the remaining high-throughput PTY input data-plane message
// stays on the WebSocket message router while terminal controls move to RPC.

import { describe, expect, it } from "vitest";
import {
	isRouteError,
	parseIncomingMessage,
	routeMessage,
} from "../../../src/lib/server/ws-router.js";

describe("WS Router: PTY message types", () => {
	it("pty_input passes ptyId and data in payload", () => {
		const msg = parseIncomingMessage(
			JSON.stringify({ type: "pty_input", ptyId: "pty-1", data: "ls\n" }),
		);
		expect(msg).not.toBeNull();
		if (msg === null) throw new Error("unreachable");
		const result = routeMessage(msg);
		expect(isRouteError(result)).toBe(false);
		if (!isRouteError(result)) {
			expect(result.handler).toBe("pty_input");
			expect(result.payload["ptyId"]).toBe("pty-1");
			expect(result.payload["data"]).toBe("ls\n");
		}
	});

	it.each([
		"terminal_command",
		"pty_create",
		"pty_resize",
		"pty_close",
	])("rejects retired terminal control message %s", (type) => {
		const msg = parseIncomingMessage(JSON.stringify({ type }));
		expect(msg).not.toBeNull();
		if (msg === null) throw new Error("unreachable");
		const result = routeMessage(msg);
		expect(isRouteError(result)).toBe(true);
	});
});
