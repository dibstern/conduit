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

beforeEach(() => {
	routerState.path = "/p/acme/s/1";
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
			null,
			"",
			"/p/acme/s/1?p=acme",
		);

		setSessionScope(null);
		expect(getSessionScope()).toBeNull();
		expect(pushStateSpy).toHaveBeenLastCalledWith(null, "", "/p/acme/s/1");
	});

	it("keeps other query parameters", () => {
		routerState.search = "?x=1";
		setSessionScope("acme");
		expect(routerState.search).toBe("?x=1&p=acme");
	});

	it("is restored by browser back", () => {
		setSessionScope("acme");
		window.location.pathname = "/p/acme/s/1";
		window.location.search = "";
		popstateListener?.();
		expect(getSessionScope()).toBeNull();
	});

	it("survives switching session", () => {
		setSessionScope("acme");
		navigate("/p/other/s/2");
		expect(getSessionScope()).toBe("acme");
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
