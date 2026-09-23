// ─── Router Store ────────────────────────────────────────────────────────────
// Simple client-side routing for 5 routes. No library needed.
// Routes: /auth, /setup, /, /p/:slug/, /p/:slug/s/:sessionId

// ─── Route types ────────────────────────────────────────────────────────────

export type Route =
	| { page: "auth" }
	| { page: "setup" }
	| { page: "dashboard" }
	| { page: "chat"; slug: string; sessionId?: string };

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

	// Match /p/:slug/s/:sessionId (before the plain /p/:slug/ match)
	const sessionMatch = path.match(/^\/p\/([^/]+)\/s\/([^/]+)\/?$/);
	if (sessionMatch) {
		return {
			page: "chat",
			// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
			slug: sessionMatch[1]!,
			// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
			sessionId: sessionMatch[2]!,
		};
	}

	// Match /p/:slug/ or /p/:slug
	const slugMatch = path.match(/^\/p\/([^/]+)\/?$/);
	if (slugMatch) {
		// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
		return { page: "chat", slug: slugMatch[1]! };
	}

	// Root or fallback = dashboard
	return { page: "dashboard" };
}

/** Use the daemon's attached project, or the route hint before the first attach. */
export function getCurrentSlug(): string | null {
	if (attachedProjectState.slug !== null) return attachedProjectState.slug;
	const route = getCurrentRoute();
	return route.page === "chat" ? route.slug : null;
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
 * Returns `/p/:slug/s/:sessionId` or null if not on a chat route.
 */
export function getSessionHref(sessionId: string): string | null {
	const slug = getCurrentSlug();
	if (!slug) return null;
	return getSessionHrefForSlug(slug, sessionId);
}

/** Get the href for a session owned by an explicit project slug. */
export function getSessionHrefForSlug(
	projectSlug: string,
	sessionId: string,
): string {
	return `/p/${projectSlug}/s/${sessionId}`;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Shared transition logic for navigate/replaceRoute. */
function applyRoute(
	path: string,
	historyMethod: "pushState" | "replaceState",
): void {
	const { pathname, search: requestedSearch } = splitPath(path);
	const search = carryScope(pathname, requestedSearch);
	if (pathname === routerState.path && search === routerState.search) return;
	const from = routerState.path + routerState.search;
	const to = pathname + search;
	window.history[historyMethod](null, "", to);
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
