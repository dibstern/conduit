// ─── Session Scope Tests ─────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushStateSpy = vi.fn();
let popstateListener: (() => void) | undefined;

vi.stubGlobal("window", {
	...(typeof window !== "undefined" ? window : {}),
	location: { pathname: "/", search: "" } as Location,
	history: {
		pushState: pushStateSpy,
		replaceState: vi.fn(),
	} as unknown as History,
	addEventListener: (event: string, listener: () => void): void => {
		if (event === "popstate") popstateListener = listener;
	},
});

const { navigate, routerState } = await import(
	"../../../src/lib/frontend/stores/router.svelte.js"
);
const { getSessionScope, setSessionScope, takeScopeToken } = await import(
	"../../../src/lib/frontend/stores/session-scope.js"
);
const {
	getSessionStatusFilter,
	setSessionStatusFilter,
	getSessionGrouping,
	setSessionGrouping,
} = await import("../../../src/lib/frontend/stores/session-scope.js");

beforeEach(() => {
	routerState.path = "/s/1";
	routerState.search = "";
	pushStateSpy.mockClear();
});

describe("session scope in the URL", () => {
	it("is null when the URL carries none", () => {
		expect(getSessionScope()).toBeNull();
	});

	it("round-trips through the URL, pushing a history entry each way", () => {
		setSessionScope("acme");
		expect(getSessionScope()).toBe("acme");
		expect(pushStateSpy).toHaveBeenLastCalledWith(
			{ conduitFrom: "/s/1" },
			"",
			"/s/1?p=acme",
		);

		setSessionScope(null);
		expect(getSessionScope()).toBeNull();
		expect(pushStateSpy).toHaveBeenLastCalledWith(
			{ conduitFrom: "/s/1" },
			"",
			"/s/1",
		);
	});

	it("keeps other query parameters", () => {
		routerState.search = "?x=1";
		setSessionScope("acme");
		expect(routerState.search).toBe("?x=1&p=acme");
	});

	it("is restored by browser back", () => {
		setSessionScope("acme");
		window.location.pathname = "/s/1";
		window.location.search = "";
		popstateListener?.();
		expect(getSessionScope()).toBeNull();
	});

	it("survives switching session", () => {
		setSessionScope("acme");
		navigate("/s/2");
		expect(getSessionScope()).toBe("acme");
	});
});

describe("session arrangement in the URL", () => {
	it("pushes filter and grouping changes while preserving scope", () => {
		routerState.search = "?p=acme";
		setSessionStatusFilter("unread");
		setSessionGrouping("project");
		expect(getSessionStatusFilter()).toBe("unread");
		expect(getSessionGrouping()).toBe("project");
		expect(routerState.search).toBe("?p=acme&status=unread&group=project");
		expect(pushStateSpy).toHaveBeenCalledTimes(2);
		setSessionStatusFilter(null);
		setSessionGrouping("status");
		expect(routerState.search).toBe("?p=acme");
	});

	it("a scope change retains the active filter and grouping", () => {
		routerState.search = "?status=unread&group=time";
		setSessionScope("acme");
		expect(routerState.search).toBe("?status=unread&group=time&p=acme");
	});

	it("carries scope, filter and grouping across a bare-path navigation", () => {
		routerState.search = "?p=acme&status=needs-you&group=time&x=1";
		navigate("/s/2");
		expect(routerState.search).toBe("?p=acme&status=needs-you&group=time");
	});

	it("restores both controls through browser history", () => {
		routerState.search = "?status=running&group=time";
		window.location.pathname = "/s/1";
		window.location.search = "?status=unread&group=project";
		popstateListener?.();
		expect(getSessionStatusFilter()).toBe("unread");
		expect(getSessionGrouping()).toBe("project");
	});

	it("ignores unknown URL values", () => {
		routerState.search = "?status=unknown&group=unknown";
		expect(getSessionStatusFilter()).toBeNull();
		expect(getSessionGrouping()).toBe("status");
	});
});

describe("takeScopeToken", () => {
	const slugs = ["conduit", "Acme"];

	it("lifts a finished token for a known project out of the text", () => {
		expect(takeScopeToken("fix project:conduit bug", slugs, false)).toEqual({
			slug: "conduit",
			text: "fix bug",
		});
	});

	it("matches the slug case-insensitively and returns its real casing", () => {
		expect(takeScopeToken("PROJECT:acme ", slugs, false)).toEqual({
			slug: "Acme",
			text: "",
		});
	});

	it("waits while the token is still being typed", () => {
		expect(takeScopeToken("project:con", ["con", "conduit"], false)).toBeNull();
	});

	it("takes an unfinished token on submit", () => {
		expect(takeScopeToken("bug project:conduit", slugs, true)).toEqual({
			slug: "conduit",
			text: "bug ",
		});
	});

	it("leaves an unknown project in the text", () => {
		expect(takeScopeToken("project:nope ", slugs, true)).toBeNull();
	});

	it("ignores the word inside another word", () => {
		expect(takeScopeToken("myproject:conduit ", slugs, true)).toBeNull();
	});
});
