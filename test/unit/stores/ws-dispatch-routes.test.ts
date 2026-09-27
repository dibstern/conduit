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

	it("opens a session created by this tab while another session is open", () => {
		routerState.path = "/s/current";
		handleMessage({
			type: "session_switched",
			id: "current",
			sessionId: "current",
		});
		const requestId = requestNewSession();
		if (!requestId) throw new Error("expected creation request");
		handleMessage({
			type: "session_switched",
			id: "created",
			sessionId: "created",
			requestId,
		});
		expect(routerState.path).toBe("/s/created");
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

	it("does not let an uncorrelated fork response replace the requested route", () => {
		routerState.path = "/s/requested";
		handleMessage({ type: "session_switched", id: "fork", sessionId: "fork" });
		expect(routerState.path).toBe("/s/requested");
		expect(sessionState.currentId).toBeNull();
		routerState.path = "/s/fork";
		handleMessage({ type: "session_switched", id: "fork", sessionId: "fork" });
		expect(routerState.path).toBe("/s/fork");
		expect(sessionState.currentId).toBe("fork");
	});

	it("opens a fork whose lineage only its session_forked row carries", () => {
		routerState.path = "/s/parent";
		handleMessage({
			type: "session_forked",
			sessionId: "fork",
			session: {
				id: "fork",
				title: "Parent (fork)",
				status: "idle",
				updatedAt: 0,
				parentID: "parent",
			},
			parentId: "parent",
			parentTitle: "Parent",
		});
		handleMessage({ type: "session_switched", id: "fork", sessionId: "fork" });
		expect(routerState.path).toBe("/s/fork");
		expect(sessionState.currentId).toBe("fork");
	});

	// OpenCode materialization: sending on a local row with an OpenCode model
	// moves the sender to a new OpenCode session with no request to echo.
	it("opens the session that replaces the open local row", () => {
		routerState.path = "/s/local";
		handleMessage({
			type: "session_switched",
			id: "local",
			sessionId: "local",
		});
		handleMessage({
			type: "session_switched",
			id: "opencode",
			sessionId: "opencode",
			replacesSessionId: "local",
		});
		expect(routerState.path).toBe("/s/opencode");
		expect(sessionState.currentId).toBe("opencode");
	});

	it("ignores a replacement for a row that is no longer open", () => {
		routerState.path = "/s/other";
		handleMessage({
			type: "session_switched",
			id: "other",
			sessionId: "other",
		});
		handleMessage({
			type: "session_switched",
			id: "opencode",
			sessionId: "opencode",
			replacesSessionId: "local",
		});
		expect(routerState.path).toBe("/s/other");
		expect(sessionState.currentId).toBe("other");
	});

	it("opens a fork returned while viewing its parent", () => {
		routerState.path = "/s/parent";
		handleMessage({
			type: "session_switched",
			id: "fork",
			sessionId: "fork",
			parentID: "parent",
		});
		expect(routerState.path).toBe("/s/fork");
		expect(sessionState.currentId).toBe("fork");
	});
});
