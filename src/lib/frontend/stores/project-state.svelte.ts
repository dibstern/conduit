// The project list and draft-project lookup, kept free of other stores so
// low-level stores (discovery) can read them without an import cycle.

import { DEFAULT_TERMINAL_KEYS } from "../../contracts/terminal-keys.js";
import { computeProjectGroups } from "../../project-grouping.js";
import { getScopeGroupKey } from "../../session-scope.js";
import type { GroupingMode, ProjectGroup } from "../../shared-types.js";
import type { ProjectInfo } from "../types.js";
import {
	DRAFT_PROJECT_PARAM,
	getCurrentSearchParams,
	SCOPE_PARAM,
} from "./router.svelte.js";

// The project list and the current slug both come from the server. Writers
// live in project.svelte.ts: `applyProjectList`.

export const projectState = $state({
	projects: [] as ProjectInfo[],
	currentSlug: null as string | null,
	defaultGroupingMode: "repository" as GroupingMode,
	defaultGroupingRevision: 0,
	terminalKeys: DEFAULT_TERMINAL_KEYS,
	terminalKeysRevision: 0,
	/** The project the daemon says a new session prefills, on every client. */
	newSessionProject: null as string | null,
});

const groups = $derived(
	computeProjectGroups(
		projectState.projects.map((project) => ({
			...project,
			groupingMode:
				project.effectiveGroupingMode ??
				project.groupingMode ??
				projectState.defaultGroupingMode,
		})),
	),
);

export function getProjectGroup(slug: string): ProjectGroup | undefined {
	return groups[slug];
}

/** The project a draft will be created in: its own pick, then the sidebar's
 *  project scope, then the remembered project, then the first available. A draft
 *  never inherits the project of whatever session happened to be open. */
export function getDraftProject(): string | null {
	const params = getCurrentSearchParams();
	const picked = params.get(DRAFT_PROJECT_PARAM);
	const isAvailable = (p: ProjectInfo) => !p.missing && !p.unavailableReason;
	// An unknown pick may be a project list that has not loaded yet.
	const pickedProject = projectState.projects.find((p) => p.slug === picked);
	if (picked && (!pickedProject || isAvailable(pickedProject))) return picked;
	const available = projectState.projects.filter(isAvailable);
	const scope = params.get(SCOPE_PARAM);
	const scopedProject =
		getScopeGroupKey(scope) === null
			? available.find((p) => p.slug === scope)
			: undefined;
	return (
		scopedProject?.slug ??
		available.find((p) => p.slug === projectState.newSessionProject)?.slug ??
		available[0]?.slug ??
		null
	);
}
