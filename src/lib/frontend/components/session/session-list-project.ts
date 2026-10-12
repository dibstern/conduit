import { projectState } from "../../stores/project.svelte.js";
import { getProjectGroup } from "../../stores/project-state.svelte.js";
import type { SessionInfo } from "../../types.js";

export function projectDisplayName(slug: string): string {
	return (
		projectState.projects.find((project) => project.slug === slug)?.title ||
		slug
	);
}

export function getProjectLabel(session: SessionInfo): string | undefined {
	const slug = session.projectSlug;
	if (!slug) return undefined;
	const group = getProjectGroup(slug);
	return group
		? `${group.label}${group.needsProjectQualifier ? ` · ${projectDisplayName(slug)}` : ""}`
		: projectDisplayName(slug);
}

export function projectAccent(slug: string | null): number {
	const index = projectState.projects.findIndex(
		(project) => project.slug === slug,
	);
	return (Math.max(index, 0) % 6) + 1;
}

export function getProjectAccent(session: SessionInfo): number {
	return projectAccent(session.projectSlug);
}
