// ─── Session scope ──────────────────────────────────────────────────────────
// The project the sidebar list is narrowed to, or null for every project. The
// URL (`?p=<slug>`) holds the only copy. The chip, the `project:` token,
// browser back and a refresh all read it from there, which is what stops the
// chip and the typed text from ever disagreeing.

import {
	getCurrentSearchParams,
	navigate,
	routerState,
	SCOPE_PARAM,
} from "./router.svelte.js";

export function getSessionScope(): string | null {
	return getCurrentSearchParams().get(SCOPE_PARAM) || null;
}

/** Pushes a history entry, so browser back undoes a scope change. */
export function setSessionScope(slug: string | null): void {
	const params = getCurrentSearchParams();
	if (slug === null) params.delete(SCOPE_PARAM);
	else params.set(SCOPE_PARAM, slug);
	const query = params.toString();
	navigate(query ? `${routerState.path}?${query}` : routerState.path);
}

const SCOPE_TOKEN = /(^|\s)project:(\S+)(\s|$)/i;

/**
 * Lifts a `project:<slug>` token naming a registered project out of the typed
 * text, so the caller can turn it into the chip. A token counts once a space
 * ends it, or on Enter (`submitted`). Until then it is still being typed, and
 * `project:con` must not scope the list to a project called "con" on the way
 * to "conduit". An unknown slug is left in the text, where it reads as the
 * title search it has become.
 */
export function takeScopeToken(
	text: string,
	slugs: readonly string[],
	submitted: boolean,
): { slug: string; text: string } | null {
	const match = SCOPE_TOKEN.exec(text);
	if (!match) return null;
	const [token, lead = "", typed = "", end = ""] = match;
	if (!end && !submitted) return null;
	const slug = slugs.find(
		(known) => known.toLowerCase() === typed.toLowerCase(),
	);
	if (slug === undefined) return null;
	const before = text.slice(0, match.index) + lead;
	const after = text.slice(match.index + token.length);
	return { slug, text: before + after };
}
