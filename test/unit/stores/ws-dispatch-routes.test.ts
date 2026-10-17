// @vitest-environment jsdom
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
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { todoState } from "../../../src/lib/frontend/stores/todo.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { applySessionRemoved, seedSessions } from "./session-fixtures.js";

const replaceState = vi.fn();

beforeEach(() => {
	vi.stubGlobal("window", { history: { replaceState, pushState: vi.fn() } });
	replaceState.mockClear();
	clearSessionState();
	routerState.path = "/";
	routerState.search = "";
	routerState.sessionNotFound = false;
});

afterEach(() => vi.unstubAllGlobals());

describe("session deletion routes", () => {
	const rows = [
		{
			id: "second",
			title: "Second",
			status: "idle" as const,
			updatedAt: "2026-01-03T00:00:00Z",
		},
		{
			id: "first",
			title: "First",
			status: "idle" as const,
			updatedAt: "2026-01-04T00:00:00Z",
		},
	];

	it("records deletion without routing to a sidebar survivor", () => {
		seedSessions([
			{ id: "victim-with-survivor", title: "Victim", status: "idle" },
			...rows,
		]);
		sessionState.currentId = "victim-with-survivor";
		routerState.path = "/s/victim-with-survivor";
		applySessionRemoved("victim-with-survivor");
		expect(sessionState.sessions.has("victim-with-survivor")).toBe(false);
		expect(sessionState.currentId).toBeNull();
		expect(routerState.path).toBe("/s/victim-with-survivor");
		expect(replaceState).not.toHaveBeenCalled();
		expect(routerState.sessionNotFound).toBe(false);
	});

	it("does not move the tab when another session is deleted", () => {
		seedSessions([
			{ id: "other-victim", title: "Victim", status: "idle" },
			...rows,
		]);
		sessionState.currentId = "first";
		routerState.path = "/s/first";
		applySessionRemoved("other-victim");
		expect(sessionState.currentId).toBe("first");
		expect(routerState.path).toBe("/s/first");
		expect(replaceState).not.toHaveBeenCalled();
	});

	it("records the last deletion without navigating or clearing view state", () => {
		seedSessions([{ id: "last-victim", title: "Victim", status: "idle" }]);
		sessionState.currentId = "last-victim";
		routerState.path = "/s/last-victim";
		uiState.contextPercent = 75;
		todoState.items = [{ id: "one", subject: "old", status: "pending" }];
		applySessionRemoved("last-victim");
		expect(sessionState.sessions.has("last-victim")).toBe(false);
		expect(sessionState.currentId).toBeNull();
		expect(routerState.path).toBe("/s/last-victim");
		expect(replaceState).not.toHaveBeenCalled();
		expect(routerState.sessionNotFound).toBe(false);
		expect(uiState.contextPercent).toBe(75);
		expect(todoState.items).toEqual([
			{ id: "one", subject: "old", status: "pending" },
		]);
	});
});
