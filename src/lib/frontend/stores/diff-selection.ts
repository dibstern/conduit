// What the Diff pane shows: its scope and the file it was last asked to reveal.
// The URL holds the only copy, per device. Back steps between reveals, a reload
// restores one, and a link opens the same diff elsewhere. None of it reaches the
// daemon, so a reveal on one device never moves another's pane.

import {
	DIFF_FOLDER_PARAM,
	DIFF_PATH_PARAM,
	DIFF_REVEAL_PARAM,
	DIFF_SCOPE_PARAM,
	getCurrentSearchParams,
	navigate,
	routerState,
} from "./router.svelte.js";
import { setRightPaneView } from "./session-view.svelte.js";

export interface DiffReveal {
	readonly path: string;
	/** The Project Folder root, or null for whichever folder lists the path. */
	readonly folder: string | null;
	/** Changes on every reveal, so asking for the same file again scrolls again. */
	readonly nonce: string | null;
}

/** The scope kind `?diff=` names: `unstaged` by its token, the branch scope by any
 *  other and by none. A kind, not a scope, so a derived of it is stable across URL
 *  changes and the view outlives them; the branch's base is the session's. */
export function getDiffScopeKind(): "branch" | "unstaged" {
	return getCurrentSearchParams().get(DIFF_SCOPE_PARAM) === "unstaged"
		? "unstaged"
		: "branch";
}

export function getDiffReveal(): DiffReveal | null {
	const params = getCurrentSearchParams();
	const path = params.get(DIFF_PATH_PARAM);
	if (!path) return null;
	return {
		path,
		folder: params.get(DIFF_FOLDER_PARAM),
		nonce: params.get(DIFF_REVEAL_PARAM),
	};
}

/** Opens the Diff pane in the default scope at a file, as a new history entry. */
export function revealInDiff(path: string, folder: string | null): void {
	const params = getCurrentSearchParams();
	params.delete(DIFF_SCOPE_PARAM);
	params.set(DIFF_PATH_PARAM, path);
	if (folder === null) params.delete(DIFF_FOLDER_PARAM);
	else params.set(DIFF_FOLDER_PARAM, folder);
	// Random, so it differs from any token the URL holds, a link's included.
	params.set(DIFF_REVEAL_PARAM, Math.random().toString(36).slice(2, 8));
	setRightPaneView("diff");
	navigate(`${routerState.path}?${params}`);
}
