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

/** Strip query string and hash from a path, returning only the pathname. */
function stripQuery(path: string): string {
	const qIdx = path.indexOf("?");
	const hIdx = path.indexOf("#");
	if (qIdx === -1 && hIdx === -1) return path;
	const end = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
	return path.slice(0, end);
}

/** Extract slug from a pathname (e.g. "/p/my-project/s/abc" → "my-project"). */
function extractSlug(path: string): string | null {
	const match = path.match(/^\/p\/([^/]+)/);
	// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
	return match ? match[1]! : null;
}

/**
 * Update slugState.current if the slug extracted from the path differs.
 * Call this whenever routerState.path is written.
 * Exported for test use when setting routerState.path directly.
 */
export function syncSlugState(path: string): void {
	const slug = extractSlug(path);
	if (slug !== slugState.current) {
		slugState.current = slug;
	}
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
});

/**
 * Stable slug state — only changes when the project slug actually changes.
 *
 * Unlike `getCurrentSlug()` (which reads `routerState.path` and creates a
 * reactive dependency on the full path), `slugState.current` is a separate
 * `$state` that is updated on every `routerState.path` write but only
 * triggers dependents when the slug itself changes.
 *
 * **Use this in `$effect` blocks** where you need to react to project changes
 * (e.g., WebSocket connect/disconnect) without re-firing on session changes.
 */
export const slugState = $state({
	current: extractSlug(
		typeof window !== "undefined" ? window.location.pathname : "/",
	),
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

/** Get the current project slug (null if not on a chat page). */
export function getCurrentSlug(): string | null {
	const route = getCurrentRoute();
	return route.page === "chat" ? route.slug : null;
}

/** Get the current session ID from the URL (null if not present). */
export function getCurrentSessionId(): string | null {
	const route = getCurrentRoute();
	return route.page === "chat" ? (route.sessionId ?? null) : null;
}

/**
 * Get the href for a session link (for use in `<a>` elements).
 * Returns `/p/:slug/s/:sessionId` or null if not on a chat route.
 */
export function getSessionHref(sessionId: string): string | null {
	const slug = getCurrentSlug();
	if (!slug) return null;
	return `/p/${slug}/s/${sessionId}`;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Shared transition logic for navigate/replaceRoute. */
function applyRoute(
	path: string,
	historyMethod: "pushState" | "replaceState",
): void {
	const pathname = stripQuery(path);
	if (pathname === routerState.path) return;
	const from = routerState.path;
	window.history[historyMethod](null, "", path);
	routerState.path = pathname;
	syncSlugState(pathname);
	recordTransition(from, pathname);
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
		syncSlugState(window.location.pathname);
	});
}
