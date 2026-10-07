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
});

afterEach(() => vi.unstubAllGlobals());

describe("session deletion routes", () => {
	const rows = [
		{
			id: "victim",
			title: "Victim",
			status: "idle" as const,
			updatedAt: "2026-01-01T00:00:00Z",
		},
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

	it("replaces the deleted route with the first sidebar survivor", () => {
		seedSessions(rows);
		sessionState.currentId = "victim";
		routerState.path = "/s/victim";
		applySessionRemoved("victim");
		expect(sessionState.currentId).toBe("first");
		expect(routerState.path).toBe("/s/first");
		expect(replaceState).toHaveBeenCalledTimes(1);
	});

	it("does not move the tab when another session is deleted", () => {
		seedSessions(rows);
		sessionState.currentId = "first";
		routerState.path = "/s/first";
		applySessionRemoved("victim");
		expect(sessionState.currentId).toBe("first");
		expect(routerState.path).toBe("/s/first");
		expect(replaceState).not.toHaveBeenCalled();
	});

	it("returns to the session list when no survivor remains", () => {
		seedSessions([{ id: "victim", title: "Victim", status: "idle" }]);
		sessionState.currentId = "victim";
		routerState.path = "/s/victim";
		uiState.contextPercent = 75;
		todoState.items = [{ id: "one", subject: "old", status: "pending" }];
		applySessionRemoved("victim");
		expect(sessionState.currentId).toBeNull();
		expect(routerState.path).toBe("/");
		expect(replaceState).toHaveBeenCalledTimes(1);
		expect(uiState.contextPercent).toBe(0);
		expect(todoState.items).toEqual([]);
	});
});
