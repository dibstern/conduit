// Manages the list of registered projects and the current project slug.

import type {
	GetProjectsResponse,
	ProjectMutationResponse,
} from "../transport/ws-rpc.js";
import { removeProjectRpc } from "../transport/ws-rpc-client.js";
import type { ProjectInfo, RelayMessage } from "../types.js";
import {
	attachedProjectState,
	getCurrentSlug,
	navigate,
	replaceRoute,
} from "./router.svelte.js";
import { confirm } from "./ui.svelte.js";

// This store has no client half: the project list and the current slug both
// come from `project_list`, and `handleProjectList` below is the only writer.

export const projectState = $state({
	projects: [] as ProjectInfo[],
	currentSlug: null as string | null,
});

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
	if (typeof addedSlug === "string") {
		navigate(`/?${new URLSearchParams({ p: addedSlug })}`);
	}

	// Removing the attached project returns to the session list.
	if (
		Array.isArray(projects) &&
		attachedProjectState.slug !== null &&
		!projects.some((p) => p.slug === attachedProjectState.slug)
	) {
		attachedProjectState.slug = null;
		replaceRoute("/?");
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
	});
}

/** Asks once for all of them, then removes; resolves whether the user confirmed. */
export async function confirmRemoveProjects(
	slugs: readonly string[],
	returnFocus?: () => HTMLElement | null,
): Promise<boolean> {
	const [first] = slugs;
	if (first === undefined) return false;
	const title =
		projectState.projects.find((project) => project.slug === first)?.title ||
		first;
	const confirmed = await confirm(
		slugs.length === 1
			? `Remove project '${title}' from conduit?`
			: `Remove ${slugs.length} projects from conduit?`,
		"Remove",
		returnFocus,
	);
	if (!confirmed) return false;
	// Each RPC routes through a project's relay, so prefer one that survives;
	// only when every project goes does a removal route through itself.
	const router = [
		getCurrentSlug(),
		...projectState.projects.map((project) => project.slug),
	].find((slug) => slug != null && !slugs.includes(slug));
	// One at a time: each reply carries the whole project list, so concurrent
	// replies could land out of order and resurrect a removed project.
	void (async () => {
		for (const slug of slugs) {
			applyProjectMutationResponse(
				await removeProjectRpc({ projectSlug: router ?? slug, slug }),
			);
		}
	})().catch(() => undefined);
	return true;
}

const toProjectInfoList = (
	projects: GetProjectsResponse["projects"],
): ProjectInfo[] =>
	projects.map((project) => ({
		slug: project.slug,
		title: project.title,
		directory: project.directory,
		...(project.folders != null ? { folders: [...project.folders] } : {}),
		...(project.git != null ? { git: project.git } : {}),
		...(project.clientCount != null
			? { clientCount: project.clientCount }
			: {}),
		...(project.instanceId != null ? { instanceId: project.instanceId } : {}),
	}));
