// ─── Project Store ──────────────────────────────────────────────────────────
// Manages the list of registered projects and the current project slug.

import type {
	GetProjectsResponse,
	ProjectMutationResponse,
} from "../transport/ws-rpc.js";
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
	// ChatLayout attaches the existing daemon socket to the new relay.
	// Lazy import avoids pulling in router.svelte.ts at module init time,
	// which would fail in test environments without a full window mock.
	if (typeof addedSlug === "string") {
		import("./router.svelte.js").then(({ navigate }) => {
			navigate(`/?${new URLSearchParams({ p: addedSlug })}`);
		});
	}

	// Removing the attached project returns to the session list.
	if (Array.isArray(projects)) {
		import("./router.svelte.js").then(
			({ attachedProjectState, replaceRoute }) => {
				if (
					attachedProjectState.slug !== null &&
					!projects.some((p) => p.slug === attachedProjectState.slug)
				) {
					attachedProjectState.slug = null;
					replaceRoute("/?");
				}
			},
		);
	}
}

export function applyGetProjectsResponse(response: GetProjectsResponse): void {
	handleProjectList({
		type: "project_list",
		projects: toProjectInfoList(response.projects),
		...(response.current != null ? { current: response.current } : {}),
	});
}

export function applyProjectMutationResponse(
	response: ProjectMutationResponse,
): void {
	handleProjectList({
		type: "project_list",
		projects: toProjectInfoList(response.projects),
		...(response.current != null ? { current: response.current } : {}),
		...(response.addedSlug != null ? { addedSlug: response.addedSlug } : {}),
	});
}

const toProjectInfoList = (
	projects: ReadonlyArray<{
		readonly slug: string;
		readonly title: string;
		readonly directory: string;
		readonly clientCount?: number | undefined;
		readonly instanceId?: string | undefined;
	}>,
): ProjectInfo[] =>
	projects.map((project) => ({
		slug: project.slug,
		title: project.title,
		directory: project.directory,
		...(project.clientCount != null
			? { clientCount: project.clientCount }
			: {}),
		...(project.instanceId != null ? { instanceId: project.instanceId } : {}),
	}));
