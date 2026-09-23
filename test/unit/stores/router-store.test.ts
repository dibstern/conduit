// ─── Router Store Tests ──────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock window.history and window.location before importing
const pushStateSpy = vi.fn();
const replaceStateSpy = vi.fn();
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
		pushState: pushStateSpy,
		replaceState: replaceStateSpy,
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
	getSessionHrefForSlug,
	getTransitionLog,
	navigate,
	replaceRoute,
	routerState,
	attachedProjectState,
} = await import("../../../src/lib/frontend/stores/router.svelte.js");

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	routerState.path = "/";
	routerState.search = "";
	attachedProjectState.slug = null;
	window.location.pathname = "/";
	window.location.search = "";
	clearTransitionLog();
	pushStateSpy.mockClear();
	replaceStateSpy.mockClear();
});

// ─── navigate ───────────────────────────────────────────────────────────────

describe("navigate", () => {
	it("updates path and calls pushState", () => {
		navigate("/auth");
		expect(routerState.path).toBe("/auth");
		expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/auth");
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
		expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/?p=acme");
	});

	it("updates search when navigating between query strings", () => {
		navigate("/?a=1");
		navigate("/?b=2");

		expect(routerState.path).toBe("/");
		expect(routerState.search).toBe("?b=2");
		expect(pushStateSpy).toHaveBeenCalledTimes(2);
		expect(pushStateSpy).toHaveBeenLastCalledWith(null, "", "/?b=2");
	});

	it("does not navigate if path and search are the same", () => {
		navigate("/?p=acme");
		navigate("/?p=acme");

		expect(pushStateSpy).toHaveBeenCalledTimes(1);
	});

	it("carries the scope, and only the scope, to a new page with no query", () => {
		navigate("/p/acme/?p=other&x=1");
		navigate("/p/acme/s/123");

		expect(routerState.path).toBe("/p/acme/s/123");
		expect(routerState.search).toBe("?p=other");
		expect(pushStateSpy).toHaveBeenLastCalledWith(
			null,
			"",
			"/p/acme/s/123?p=other",
		);
	});

	it("takes a same-page navigation literally, so the scope can be cleared", () => {
		navigate("/p/acme/?p=other");
		navigate("/p/acme/");

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
		expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/auth");
	});

	it("navigates to slug routes", () => {
		navigate("/p/my-project/");
		expect(routerState.path).toBe("/p/my-project/");
		expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/p/my-project/");
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
		window.location.pathname = "/p/acme/s/123";
		window.location.search = "?p=other";

		expect(popstateListener).toBeTypeOf("function");
		popstateListener?.();

		expect(routerState.path).toBe("/p/acme/s/123");
		expect(routerState.search).toBe("?p=other");
		expect(getCurrentSlug()).toBe("acme");
	});
});

// ─── getCurrentRoute / getCurrentSlug ─────────────────────────────────────

describe("getCurrentRoute", () => {
	it("returns dashboard for root path", () => {
		routerState.path = "/";
		expect(getCurrentRoute()).toEqual({ page: "dashboard" });
	});

	it("returns auth for /auth", () => {
		routerState.path = "/auth";
		expect(getCurrentRoute()).toEqual({ page: "auth" });
	});

	it("returns setup for /setup", () => {
		routerState.path = "/setup";
		expect(getCurrentRoute()).toEqual({ page: "setup" });
	});

	it("returns chat with slug for /p/:slug/", () => {
		routerState.path = "/p/my-project/";
		expect(getCurrentRoute()).toEqual({ page: "chat", slug: "my-project" });
	});

	it("returns chat with slug for /p/:slug (no trailing slash)", () => {
		routerState.path = "/p/test";
		expect(getCurrentRoute()).toEqual({ page: "chat", slug: "test" });
	});

	it("falls back to dashboard for unknown paths", () => {
		routerState.path = "/unknown";
		expect(getCurrentRoute()).toEqual({ page: "dashboard" });
	});

	it("returns the same route with and without a query string", () => {
		navigate("/p/acme/s/123");
		const routeWithoutQuery = getCurrentRoute();
		navigate("/p/acme/s/123?p=x");

		expect(getCurrentRoute()).toEqual(routeWithoutQuery);
	});
});

describe("getCurrentSearchParams", () => {
	it("returns the current query parameters", () => {
		navigate("/?p=acme");
		expect(getCurrentSearchParams().get("p")).toBe("acme");
	});
});

describe("getCurrentSlug", () => {
	it("returns slug on chat route", () => {
		routerState.path = "/p/my-project/";
		expect(getCurrentSlug()).toBe("my-project");
	});

	it("returns null on non-chat route", () => {
		routerState.path = "/";
		expect(getCurrentSlug()).toBeNull();
	});
});

// ─── Session URL routing (/p/:slug/s/:sessionId) ───────────────────────────

describe("getCurrentRoute with session ID", () => {
	it("returns chat with slug and sessionId for /p/:slug/s/:sessionId", () => {
		routerState.path = "/p/my-project/s/abc123";
		expect(getCurrentRoute()).toEqual({
			page: "chat",
			slug: "my-project",
			sessionId: "abc123",
		});
	});

	it("returns chat with slug and sessionId for trailing slash", () => {
		routerState.path = "/p/my-project/s/abc123/";
		expect(getCurrentRoute()).toEqual({
			page: "chat",
			slug: "my-project",
			sessionId: "abc123",
		});
	});

	it("returns chat without sessionId for plain /p/:slug/", () => {
		routerState.path = "/p/my-project/";
		const route = getCurrentRoute();
		expect(route).toEqual({ page: "chat", slug: "my-project" });
		expect(route.page === "chat" && route.sessionId).toBeUndefined();
	});
});

describe("getCurrentSessionId", () => {
	it("returns sessionId when URL has session path", () => {
		routerState.path = "/p/my-project/s/sess-xyz";
		expect(getCurrentSessionId()).toBe("sess-xyz");
	});

	it("returns null when URL has no session path", () => {
		routerState.path = "/p/my-project/";
		expect(getCurrentSessionId()).toBeNull();
	});

	it("returns null on non-chat route", () => {
		routerState.path = "/";
		expect(getCurrentSessionId()).toBeNull();
	});
});

// ─── getSessionHref ─────────────────────────────────────────────────────────
// Generates an href for a session link so <a> elements can support right-click
// → "Open in New Tab". Bug fix: SessionItem was using <div onclick> without
// an href, making right-click context menus useless.

describe("getSessionHref", () => {
	it("returns /p/:slug/s/:sessionId when on a chat route", () => {
		routerState.path = "/p/my-project/s/old-session";
		expect(getSessionHref("new-session")).toBe("/p/my-project/s/new-session");
	});

	it("returns /p/:slug/s/:sessionId when on a slug-only route", () => {
		routerState.path = "/p/my-project/";
		expect(getSessionHref("abc123")).toBe("/p/my-project/s/abc123");
	});

	it("returns null when not on a chat route", () => {
		routerState.path = "/";
		expect(getSessionHref("abc123")).toBeNull();
	});

	it("builds a foreign session href from that row's project slug", () => {
		routerState.path = "/p/current-project/";
		expect(getSessionHrefForSlug("foreign-project", "abc123")).toBe(
			"/p/foreign-project/s/abc123",
		);
	});
});

describe("attachedProjectState", () => {
	it("falls back to the route before the daemon attaches a project", () => {
		routerState.path = "/p/my-project/";
		expect(attachedProjectState.slug).toBeNull();
		expect(getCurrentSlug()).toBe("my-project");
	});

	it("uses the attached slug while navigation targets another project", () => {
		attachedProjectState.slug = "project-a";
		navigate("/p/project-b/s/session-b");
		expect(getCurrentSlug()).toBe("project-a");
		expect(getCurrentRoute()).toEqual({
			page: "chat",
			slug: "project-b",
			sessionId: "session-b",
		});
		expect(getSessionHref("session-a")).toBe("/p/project-a/s/session-a");
	});

	it("keeps the attached project through route replacement and browser history", () => {
		attachedProjectState.slug = "project-a";
		replaceRoute("/p/project-b/");
		window.location.pathname = "/p/project-c/s/session-c";
		popstateListener?.();
		expect(getCurrentSlug()).toBe("project-a");
		attachedProjectState.slug = "project-c";
		expect(getCurrentSlug()).toBe("project-c");
	});

	it("keeps the attached project when the route has no project", () => {
		attachedProjectState.slug = "project-a";
		routerState.path = "/";
		expect(getCurrentSlug()).toBe("project-a");
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
