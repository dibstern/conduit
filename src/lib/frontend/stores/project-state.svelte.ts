// The project list and draft-project lookup, kept free of other stores so
// low-level stores (discovery) can read them without an import cycle.

import type { ProjectInfo } from "../types.js";
import {
	DRAFT_PROJECT_PARAM,
	getCurrentSearchParams,
	SCOPE_PARAM,
} from "./router.svelte.js";

// The shell feed owns projects and the new-session preference. Project mutation
// replies may update the attached hint through project.svelte.ts.

export const projectState = $state({
	projects: [] as ProjectInfo[],
	currentSlug: null as string | null,
	/** The project the daemon says a new session prefills, on every client. */
	newSessionProject: null as string | null,
	/** The user's manual project order, synced through daemon config. */
	projectOrder: [] as readonly string[],
});

/** The project a draft will be created in (ADR-0011): its own pick, then the
 *  open session's project, then the sidebar's project scope, then the
 *  remembered project, then the first available. */
export function getDraftProject(
	openSessionProject: string | null = null,
): string | null {
	const params = getCurrentSearchParams();
	const picked = params.get(DRAFT_PROJECT_PARAM);
	const isAvailable = (p: ProjectInfo) => !p.missing && !p.unavailableReason;
	// An unknown pick may be a project list that has not loaded yet.
	const pickedProject = projectState.projects.find((p) => p.slug === picked);
	if (picked && (!pickedProject || isAvailable(pickedProject))) return picked;
	const available = projectState.projects.filter(isAvailable);
	const find = (slug: string | null) =>
		available.find((p) => p.slug === slug)?.slug;
	return (
		find(openSessionProject) ??
		find(params.get(SCOPE_PARAM)) ??
		find(projectState.newSessionProject) ??
		available[0]?.slug ??
		null
	);
}
