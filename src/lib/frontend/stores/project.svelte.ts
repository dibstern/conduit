// ─── Project Store ──────────────────────────────────────────────────────────
// Manages the list of registered projects and the current project slug.

import type { ProjectInfo, RelayMessage } from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const projectState = $state({
	projects: [] as ProjectInfo[],
	currentSlug: null as string | null,
});

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleProjectList(
	msg: Extract<RelayMessage, { type: "project_list" }>,
): void {
	const { projects, current, addedSlug } = msg;
	if (Array.isArray(projects)) {
		projectState.projects = projects;
	}
	if (typeof current === "string") {
		projectState.currentSlug = current;
	}

	// When the server confirms a newly added project, navigate to it.
	// This triggers ChatLayout's $effect which disconnects the old WS,
	// clears stale sessions/files, and connects to the new project's relay.
	// Lazy import avoids pulling in router.svelte.ts at module init time,
	// which would fail in test environments without a full window mock.
	if (typeof addedSlug === "string") {
		import("./router.svelte.js").then(({ navigate }) => {
			navigate(`/p/${addedSlug}/`);
		});
	}
}
