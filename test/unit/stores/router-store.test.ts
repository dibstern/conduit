// ─── Router Store Tests ──────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock window.history and window.location before importing
let historyState: unknown = null;
const pushStateSpy = vi.fn((state: unknown) => {
	historyState = state;
});
const replaceStateSpy = vi.fn((state: unknown) => {
	historyState = state;
});
const backSpy = vi.fn();
let popstateListener: (() => void) | undefined;
const addEventListenerSpy = vi.fn(
	(event: string, listener: () => void): void => {
		if (event === "popstate") {
			popstateListener = listener;
		}
	},
);

// Set up window mocks
vi.stubGlobal("window", {
	...(typeof window !== "undefined" ? window : {}),
	location: { pathname: "/", search: "" } as Location,
	history: {
		get state() {
			return historyState;
		},
		pushState: pushStateSpy,
		replaceState: replaceStateSpy,
		back: backSpy,
	} as unknown as History,
	addEventListener: addEventListenerSpy,
});

const {
	clearTransitionLog,
	getCurrentRoute,
	getCurrentSearchParams,
	getCurrentSessionId,
	getCurrentSlug,
	getSessionHref,
	getTransitionLog,
	navigate,
	normalizeRoute,
	previousHistoryEntryIsSessionList,
	replaceRoute,
	routerState,
	attachedProjectState,
} = await import("../../../src/lib/frontend/stores/router.svelte.js");

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	routerState.path = "/";
	routerState.search = "";
	routerState.sessionNotFound = false;
	attachedProjectState.slug = null;
	window.location.pathname = "/";
	window.location.search = "";
	historyState = null;
	clearTransitionLog();
	pushStateSpy.mockClear();
	replaceStateSpy.mockClear();
	backSpy.mockClear();
});

// ─── navigate ───────────────────────────────────────────────────────────────

describe("navigate", () => {
	it("updates path and calls pushState", () => {
		navigate("/auth");
		expect(routerState.path).toBe("/auth");
		expect(pushStateSpy).toHaveBeenCalledWith(
			{ conduitFrom: "/" },
			"",
			"/auth",
		);
	});

	it("does not navigate if path is the same", () => {
		routerState.path = "/auth";
		navigate("/auth");
		expect(pushStateSpy).not.toHaveBeenCalled();
	});

	it("updates search when the pathname is unchanged", () => {
		navigate("/");
		navigate("/?p=acme");

		expect(routerState.path).toBe("/");
		expect(routerState.search).toBe("?p=acme");
		expect(pushStateSpy).toHaveBeenCalledTimes(1);
		expect(pushStateSpy).toHaveBeenCalledWith(
			{ conduitFrom: "/" },
			"",
			"/?p=acme",
		);
	});

	it("updates search when navigating between query strings", () => {
		navigate("/?a=1");
		navigate("/?b=2");

		expect(routerState.path).toBe("/");
		expect(routerState.search).toBe("?b=2");
		expect(pushStateSpy).toHaveBeenCalledTimes(2);
		expect(pushStateSpy).toHaveBeenLastCalledWith(
			{ conduitFrom: "/" },
			"",
			"/?b=2",
		);
	});

	it("does not navigate if path and search are the same", () => {
		navigate("/?p=acme");
		navigate("/?p=acme");

		expect(pushStateSpy).toHaveBeenCalledTimes(1);
	});

	it("carries the scope, and only the scope, to a new page with no query", () => {
		navigate("/?p=other&x=1");
		navigate("/s/123");

		expect(routerState.path).toBe("/s/123");
		expect(routerState.search).toBe("?p=other");
		expect(pushStateSpy).toHaveBeenLastCalledWith(
			{ conduitFrom: "/" },
			"",
			"/s/123?p=other",
		);
	});

	it("takes a same-page navigation literally, so the scope can be cleared", () => {
		navigate("/?p=other");
		navigate("/");

		expect(routerState.search).toBe("");
	});

	it("clears the carried scope when the destination explicitly names an empty query", () => {
		navigate("/s/session-a?p=project-a");
		navigate("/?");
		expect(routerState.path).toBe("/");
		expect(routerState.search).toBe("");
	});

	it("lets an explicit query replace the scope", () => {
		navigate("/?p=other");
		navigate("/setup?mode=lan");

		expect(routerState.search).toBe("?mode=lan");
	});

	it("normalizes a bare query and discards the hash", () => {
		navigate("/auth?#section");

		expect(routerState.path).toBe("/auth");
		expect(routerState.search).toBe("");
		expect(pushStateSpy).toHaveBeenCalledWith(
			{ conduitFrom: "/" },
			"",
			"/auth",
		);
	});

	it("navigates to slug routes", () => {
		navigate("/p/my-project/");
		expect(routerState.path).toBe("/p/my-project/");
		expect(pushStateSpy).toHaveBeenCalledWith(
			{ conduitFrom: "/" },
			"",
			"/p/my-project/",
		);
	});

	it("marks a session entry pushed from the session list", () => {
		navigate("/s/123");
		expect(previousHistoryEntryIsSessionList()).toBe(true);
	});

	it("does not treat a direct session entry as coming from the list", () => {
		routerState.path = "/s/direct";
		historyState = null;
		expect(previousHistoryEntryIsSessionList()).toBe(false);
	});

	it("does not treat navigation from another app route as coming from the list", () => {
		routerState.path = "/auth";
		navigate("/s/123");
		expect(previousHistoryEntryIsSessionList()).toBe(false);
	});

	it("preserves the previous-entry marker when replacing the current route", () => {
		navigate("/s/123");
		replaceRoute("/s/456");
		expect(previousHistoryEntryIsSessionList()).toBe(true);
	});
});

// ─── replaceRoute ───────────────────────────────────────────────────────────

describe("replaceRoute", () => {
	it("updates path and calls replaceState", () => {
		replaceRoute("/setup");
		expect(routerState.path).toBe("/setup");
		expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/setup");
	});

	it("does not replace if path is the same", () => {
		routerState.path = "/setup";
		replaceRoute("/setup");
		expect(replaceStateSpy).not.toHaveBeenCalled();
	});
});

// ─── routerState.path direct manipulation ───────────────────────────────────

describe("routerState", () => {
	it("can be set directly", () => {
		routerState.path = "/auth";
		expect(routerState.path).toBe("/auth");
	});

	it("starts at root by default (after reset)", () => {
		expect(routerState.path).toBe("/");
	});

	it("has empty search when the URL has no query", () => {
		expect(routerState.search).toBe("");
	});
});

describe("popstate", () => {
	it("restores pathname and search from window.location", () => {
		window.location.pathname = "/s/123";
		window.location.search = "?p=other";

		expect(popstateListener).toBeTypeOf("function");
		popstateListener?.();

		expect(routerState.path).toBe("/s/123");
		expect(routerState.search).toBe("?p=other");
		expect(getCurrentSlug()).toBe("other");
	});
});

// ─── getCurrentRoute / getCurrentSlug ─────────────────────────────────────

describe("getCurrentRoute", () => {
	it.each([
		"/",
		"/?p=my-project",
	])("returns sessionless chat for %s", (path) => {
		navigate(path);
		expect(getCurrentRoute()).toEqual({ page: "chat" });
		expect(getCurrentSessionId()).toBeNull();
	});

	it.each(["/auth", "/auth/", "/setup", "/setup/"])("preserves %s", (path) => {
		routerState.path = path;
		expect(getCurrentRoute()).toEqual({
			page: path.startsWith("/auth") ? "auth" : "setup",
		});
		normalizeRoute();
		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it.each([
		"/s/abc123",
		"/s/abc123/",
	])("returns the session for %s without a project", (path) => {
		routerState.path = path;
		expect(getCurrentRoute()).toEqual({ page: "chat", sessionId: "abc123" });
		expect(getCurrentSessionId()).toBe("abc123");
	});

	it("ignores query parameters when parsing the session route", () => {
		navigate("/s/123?p=x");
		expect(getCurrentRoute()).toEqual({ page: "chat", sessionId: "123" });
	});
});

describe("normalizeRoute", () => {
	it.each([
		"/p/my-project/s/abc123",
		"/p/my-project/s/abc123/",
	])("replaces legacy session URL %s", (path) => {
		routerState.path = path;
		expect(getCurrentRoute()).toEqual({ page: "chat", sessionId: "abc123" });
		normalizeRoute();
		expect(routerState.path).toBe("/s/abc123");
		expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/s/abc123");
		expect(pushStateSpy).not.toHaveBeenCalled();
	});

	it.each([
		"/p/my-project",
		"/p/my-project/",
	])("replaces legacy project URL %s with the list hint", (path) => {
		routerState.path = path;
		normalizeRoute();
		expect(routerState.path).toBe("/");
		expect(routerState.search).toBe("?p=my-project");
		expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/?p=my-project");
	});

	it("preserves existing query parameters on a legacy session redirect", () => {
		routerState.path = "/p/project-a/s/abc123";
		routerState.search = "?p=project-b&x=1";
		normalizeRoute();
		expect(routerState.search).toBe("?p=project-b&x=1");
	});

	it.each([
		"/unknown",
		"/s/",
		"/s/one/extra",
		"/p/",
	])("replaces unknown URL %s with root", (path) => {
		routerState.path = path;
		normalizeRoute();
		expect(routerState.path).toBe("/");
		expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/");
	});

	it.each(["/", "/s/abc123"])("does not replace canonical URL %s", (path) => {
		routerState.path = path;
		normalizeRoute();
		expect(replaceStateSpy).not.toHaveBeenCalled();
	});
});

describe("getCurrentSearchParams", () => {
	it("returns the current query parameters", () => {
		navigate("/?p=acme");
		expect(getCurrentSearchParams().get("p")).toBe("acme");
	});
});

describe("getCurrentSlug", () => {
	it("uses the project query hint before the daemon attaches", () => {
		navigate("/?p=my-project");
		expect(getCurrentSlug()).toBe("my-project");
	});

	it("has no project on a bare session link before attach", () => {
		routerState.path = "/s/abc123";
		expect(getCurrentSlug()).toBeNull();
	});

	it("prefers the attached project over the query hint", () => {
		attachedProjectState.slug = "project-a";
		navigate("/s/session-b?p=project-b");
		expect(getCurrentSlug()).toBe("project-a");
		expect(getCurrentRoute()).toEqual({ page: "chat", sessionId: "session-b" });
	});

	it("keeps the attached project through replacement and browser history", () => {
		attachedProjectState.slug = "project-a";
		replaceRoute("/?p=project-b");
		window.location.pathname = "/s/session-c";
		window.location.search = "?p=project-c";
		popstateListener?.();
		expect(getCurrentSlug()).toBe("project-a");
		attachedProjectState.slug = "project-c";
		expect(getCurrentSlug()).toBe("project-c");
	});
});

describe("getSessionHref", () => {
	it.each([
		"/",
		"/s/old-session",
	])("builds a session address from %s without a project", (path) => {
		routerState.path = path;
		expect(getSessionHref("abc123")).toBe("/s/abc123");
	});
});

// ─── Transition log (dev-mode route debugging) ─────────────────────────────
// Records {from, to, timestamp} on every navigate/replaceRoute call so
// developers can trace "how did I end up on this page?" in dev tools.

describe("transition log", () => {
	it("records a transition on navigate", () => {
		navigate("/auth");
		const log = getTransitionLog();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ from: "/", to: "/auth" });
		expect(log[0]?.timestamp).toBeTypeOf("number");
	});

	it("records a transition on replaceRoute", () => {
		replaceRoute("/setup");
		const log = getTransitionLog();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ from: "/", to: "/setup" });
	});

	it("records multiple transitions in order", () => {
		navigate("/auth");
		navigate("/setup");
		navigate("/p/proj/");
		const log = getTransitionLog();
		expect(log).toHaveLength(3);
		expect(log[0]).toMatchObject({ from: "/", to: "/auth" });
		expect(log[1]).toMatchObject({ from: "/auth", to: "/setup" });
		expect(log[2]).toMatchObject({ from: "/setup", to: "/p/proj/" });
	});

	it("does not record when path is unchanged (no-op)", () => {
		navigate("/auth");
		navigate("/auth"); // same path — no-op
		expect(getTransitionLog()).toHaveLength(1);
	});

	it("includes search in transitions", () => {
		navigate("/?p=acme");
		navigate("/?p=other");

		expect(getTransitionLog()).toMatchObject([
			{ from: "/", to: "/?p=acme" },
			{ from: "/?p=acme", to: "/?p=other" },
		]);
	});

	it("caps at 50 entries (ring buffer)", () => {
		for (let i = 0; i < 60; i++) {
			// Alternate between two paths so each navigate is a real transition
			routerState.path = i % 2 === 0 ? "/auth" : "/";
			navigate(i % 2 === 0 ? "/" : "/auth");
		}
		const log = getTransitionLog();
		expect(log).toHaveLength(50);
		// Most recent entry should be last
		expect(log[49]).toMatchObject({ to: "/auth" });
	});

	it("clearTransitionLog empties the log", () => {
		navigate("/auth");
		navigate("/setup");
		expect(getTransitionLog()).toHaveLength(2);
		clearTransitionLog();
		expect(getTransitionLog()).toHaveLength(0);
	});

	it("returns a copy, not the internal array", () => {
		navigate("/auth");
		const log1 = getTransitionLog();
		const log2 = getTransitionLog();
		expect(log1).not.toBe(log2);
		expect(log1).toEqual(log2);
	});
});
