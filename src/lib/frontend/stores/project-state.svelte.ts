// The project list and draft-project lookup, kept free of other stores so
// low-level stores (discovery) can read them without an import cycle.
import type { ProjectInfo } from "../types.js";
import {
	DRAFT_PROJECT_PARAM,
	getCurrentSearchParams,
} from "./router.svelte.js";

// The project list and the current slug both come from the server. Writers
// live in project.svelte.ts: `applyProjectList`.

export const projectState = $state({
	projects: [] as ProjectInfo[],
	currentSlug: null as string | null,
	/** The project the daemon says a new session prefills, on every client. */
	newSessionProject: null as string | null,
});

/** The project a draft will be created in: its own pick, else the last one
 *  added or given a session (on any client), else the first available. A draft
 *  never inherits the project of whatever session happened to be open. */
export function getDraftProject(): string | null {
	const picked = getCurrentSearchParams().get(DRAFT_PROJECT_PARAM);
	if (picked) return picked;
	const available = projectState.projects.filter((p) => !p.missing);
	return (
		available.find((p) => p.slug === projectState.newSessionProject)?.slug ??
		available[0]?.slug ??
		null
	);
}
