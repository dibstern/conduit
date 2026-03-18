// ─── Tests: WS Router PTY Message Types ──────────────────────────────────────
// Verifies that PTY-related message types (pty_create, pty_input, pty_resize,
// pty_close) are correctly routed by the WebSocket message router.

import { describe, expect, it } from "vitest";
import {
	isRouteError,
	parseIncomingMessage,
	routeMessage,
} from "../../../src/lib/server/ws-router.js";

describe("WS Router: PTY message types", () => {
	const ptyTypes = ["pty_create", "pty_input", "pty_resize", "pty_close"];

	for (const type of ptyTypes) {
		it(`routes ${type} as a valid message`, () => {
			const msg = parseIncomingMessage(JSON.stringify({ type }));
			expect(msg).not.toBeNull();
			if (msg === null) throw new Error("unreachable");
			const result = routeMessage(msg);
			expect(isRouteError(result)).toBe(false);
			if (!isRouteError(result)) {
				expect(result.handler).toBe(type);
			}
		});
	}

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

	it("pty_resize passes ptyId, cols, and rows in payload", () => {
		const msg = parseIncomingMessage(
			JSON.stringify({
				type: "pty_resize",
				ptyId: "pty-1",
				cols: 120,
				rows: 40,
			}),
		);
		expect(msg).not.toBeNull();
		if (msg === null) throw new Error("unreachable");
		const result = routeMessage(msg);
		expect(isRouteError(result)).toBe(false);
		if (!isRouteError(result)) {
			expect(result.handler).toBe("pty_resize");
			expect(result.payload["ptyId"]).toBe("pty-1");
			expect(result.payload["cols"]).toBe(120);
			expect(result.payload["rows"]).toBe(40);
		}
	});

	it("pty_close passes ptyId in payload", () => {
		const msg = parseIncomingMessage(
			JSON.stringify({ type: "pty_close", ptyId: "pty-1" }),
		);
		expect(msg).not.toBeNull();
		if (msg === null) throw new Error("unreachable");
		const result = routeMessage(msg);
		expect(isRouteError(result)).toBe(false);
		if (!isRouteError(result)) {
			expect(result.handler).toBe("pty_close");
			expect(result.payload["ptyId"]).toBe("pty-1");
		}
	});

	it("pty_create passes no extra payload", () => {
		const msg = parseIncomingMessage(JSON.stringify({ type: "pty_create" }));
		expect(msg).not.toBeNull();
		if (msg === null) throw new Error("unreachable");
		const result = routeMessage(msg);
		expect(isRouteError(result)).toBe(false);
		if (!isRouteError(result)) {
			expect(result.handler).toBe("pty_create");
			expect(Object.keys(result.payload)).toHaveLength(0);
		}
	});
});
