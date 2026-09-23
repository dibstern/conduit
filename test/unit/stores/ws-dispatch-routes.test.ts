import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.defineProperty(globalThis, "localStorage", {
		value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
		writable: true,
		configurable: true,
	});
});
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	requestNewSession,
	resetSessionCreation,
	sessionCreation,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RequestId } from "../../../src/lib/shared-types.js";

const replaceState = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", { history: { replaceState } });
	replaceState.mockClear();
	clearSessionState();
	resetSessionCreation();
	routerState.path = "/";
	routerState.search = "";
});

afterEach(() => {
	resetSessionCreation();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("session_switched routes", () => {
	it("leaves the list unselected for an unsolicited switch", () => {
		handleMessage({
			type: "session_switched",
			id: "unasked",
			sessionId: "unasked",
		});
		expect(routerState.path).toBe("/");
		expect(sessionState.currentId).toBeNull();
		expect(replaceState).not.toHaveBeenCalled();
	});

	it("opens a session created by this tab and carries the list scope", () => {
		routerState.search = "?p=project-a";
		const requestId = requestNewSession();
		if (!requestId) throw new Error("expected creation request");
		handleMessage({
			type: "session_switched",
			id: "created",
			sessionId: "created",
			requestId,
		});
		expect(routerState.path).toBe("/s/created");
		expect(routerState.search).toBe("?p=project-a");
		expect(sessionState.currentId).toBe("created");
		expect(sessionCreation.value.phase).toBe("idle");
	});

	it("ignores another tab's creation while this tab is creating", () => {
		requestNewSession();
		handleMessage({
			type: "session_switched",
			id: "foreign",
			sessionId: "foreign",
			requestId: "other-tab" as RequestId,
		});
		expect(routerState.path).toBe("/");
		expect(sessionState.currentId).toBeNull();
		expect(sessionCreation.value.phase).toBe("creating");
	});

	it("accepts the requested session at its canonical address", () => {
		routerState.path = "/s/requested";
		handleMessage({
			type: "session_switched",
			id: "requested",
			sessionId: "requested",
		});
		expect(routerState.path).toBe("/s/requested");
		expect(sessionState.currentId).toBe("requested");
	});

	it("opens a fork returned while viewing its parent", () => {
		routerState.path = "/s/requested";
		handleMessage({ type: "session_switched", id: "fork", sessionId: "fork" });
		expect(routerState.path).toBe("/s/fork");
		expect(sessionState.currentId).toBe("fork");
	});
});
