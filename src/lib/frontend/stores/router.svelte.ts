// ─── Router Store ────────────────────────────────────────────────────────────
// Routes: /auth, /setup, / (session list), /s/:sessionId.

// ─── Route types ────────────────────────────────────────────────────────────

export type Route =
	| { page: "auth" }
	| { page: "setup" }
	| { page: "chat"; sessionId?: string };

export interface RouteTransition {
	from: string;
	to: string;
	timestamp: number;
}

const MAX_TRANSITION_LOG = 50;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Split a path into its pathname and raw search string, discarding the hash. */
function splitPath(path: string): { pathname: string; search: string } {
	const hashIndex = path.indexOf("#");
	const pathWithoutHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
	const queryIndex = pathWithoutHash.indexOf("?");
	if (queryIndex === -1) {
		return { pathname: pathWithoutHash, search: "" };
	}

	const pathname = pathWithoutHash.slice(0, queryIndex);
	const query = pathWithoutHash.slice(queryIndex + 1);
	return { pathname, search: query ? `?${query}` : "" };
}

/** The sidebar's project scope (`?p=<slug>`). Read and written through
 *  stores/session-scope.ts; declared here because navigation has to carry it. */
export const SCOPE_PARAM = "p";

/**
 * Keeps the scope across a move to another page that names no query of its
 * own. Every session switch, new session and project hop navigates to a bare
 * path, and on desktop the list stays on screen through all of them: dropping
 * the scope there would silently widen the list the user just narrowed. A
 * same-page navigation is taken literally, which is how clearing the scope
 * works.
 */
function carryScope(pathname: string, search: string): string {
	if (search || pathname === routerState.path) return search;
	const scope = new URLSearchParams(routerState.search).get(SCOPE_PARAM);
	return scope ? `?${new URLSearchParams({ [SCOPE_PARAM]: scope })}` : "";
}

// ─── Transition log (dev-mode route debugging) ─────────────────────────────
// Records {from, to, timestamp} for each route change so developers can
// trace "how did I end up on this page?" in the browser console.

const transitionLog: RouteTransition[] = [];

function recordTransition(from: string, to: string): void {
	transitionLog.push({ from, to, timestamp: Date.now() });
	if (transitionLog.length > MAX_TRANSITION_LOG) {
		transitionLog.shift();
	}
}

/** Return a copy of the transition log. */
export function getTransitionLog(): RouteTransition[] {
	return transitionLog.slice();
}

/** Clear all recorded transitions. */
export function clearTransitionLog(): void {
	transitionLog.length = 0;
}

// ─── State ──────────────────────────────────────────────────────────────────

export const routerState = $state({
	path: typeof window !== "undefined" ? window.location.pathname : "/",
	search: typeof window !== "undefined" ? window.location.search : "",
	sessionNotFound: false,
});

/** The daemon sets the attached project through project_attached messages. */
export const attachedProjectState = $state({
	slug: null as string | null,
});

// ─── Derived getters ────────────────────────────────────────────────────────
// These compute from routerState.path on each call.
// Components should wrap in $derived() for reactive caching:
//   const route = $derived(getCurrentRoute());

/** Parse current pathname into a typed Route. */
export function getCurrentRoute(): Route {
	const path = routerState.path;

	if (path === "/auth" || path === "/auth/") {
		return { page: "auth" };
	}
	if (path === "/setup" || path === "/setup/") {
		return { page: "setup" };
	}

	// Legacy session links remain readable until App normalizes the address.
	const sessionMatch = path.match(/^(?:\/p\/[^/]+)?\/s\/([^/]+)\/?$/);
	if (sessionMatch) {
		return {
			page: "chat",
			// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
			sessionId: sessionMatch[1]!,
		};
	}

	return { page: "chat" };
}

/** Replace old bookmarks and unknown paths without adding a history entry. */
export function normalizeRoute(): void {
	const path = routerState.path;
	const legacySession = path.match(/^\/p\/[^/]+\/s\/([^/]+)\/?$/);
	if (legacySession) {
		replaceRoute(`/s/${legacySession[1]}${routerState.search}`);
		return;
	}
	const legacyProject = path.match(/^\/p\/([^/]+)\/?$/);
	if (legacyProject?.[1]) {
		const params = getCurrentSearchParams();
		params.set(SCOPE_PARAM, legacyProject[1]);
		replaceRoute(`/?${params}`);
		return;
	}
	if (!/^\/(?:s\/[^/]+\/?|auth\/?|setup\/?)?$/.test(path)) {
		replaceRoute(`/${routerState.search}`);
	}
}

/** Use the daemon's attached project, or the route hint before the first attach. */
export function getCurrentSlug(): string | null {
	if (attachedProjectState.slug !== null) return attachedProjectState.slug;
	return getCurrentSearchParams().get(SCOPE_PARAM);
}

/** Get the current session ID from the URL (null if not present). */
export function getCurrentSessionId(): string | null {
	const route = getCurrentRoute();
	return route.page === "chat" ? (route.sessionId ?? null) : null;
}

/** Get the current URL search parameters. */
export function getCurrentSearchParams(): URLSearchParams {
	return new URLSearchParams(routerState.search);
}

/**
 * Get the href for a session link (for use in `<a>` elements).
 * Session addresses are independent of their owning project.
 */
export function getSessionHref(sessionId: string): string {
	return `/s/${sessionId}`;
}

/** Whether this history entry was pushed from the app's session-list route. */
export function previousHistoryEntryIsSessionList(): boolean {
	if (typeof window === "undefined") return false;
	const state: unknown = window.history.state;
	return (
		typeof state === "object" &&
		state !== null &&
		"conduitFrom" in state &&
		state.conduitFrom === "/"
	);
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Shared transition logic for navigate/replaceRoute. */
function applyRoute(
	path: string,
	historyMethod: "pushState" | "replaceState",
): void {
	const { pathname, search: requestedSearch } = splitPath(path);
	const search = path.split("#", 1)[0]?.includes("?")
		? requestedSearch
		: carryScope(pathname, requestedSearch);
	if (pathname === routerState.path && search === routerState.search) return;
	const from = routerState.path + routerState.search;
	const to = pathname + search;
	// A push records the page it left so SessionBar back can use history.back();
	// a replace keeps that record.
	const state: unknown =
		historyMethod === "pushState"
			? { conduitFrom: routerState.path }
			: window.history.state;
	window.history[historyMethod](state, "", to);
	routerState.path = pathname;
	routerState.search = search;
	recordTransition(from, to);
}

/** Navigate to a new path using pushState. */
export function navigate(path: string): void {
	applyRoute(path, "pushState");
}

/** Replace current path without adding to history. */
export function replaceRoute(path: string): void {
	applyRoute(path, "replaceState");
}

// ─── Browser history listener ───────────────────────────────────────────────

if (typeof window !== "undefined") {
	window.addEventListener("popstate", () => {
		routerState.path = window.location.pathname;
		routerState.search = window.location.search;
	});
}
