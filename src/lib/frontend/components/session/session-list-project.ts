import { projectState } from "../../stores/project.svelte.js";
import { getCurrentSlug } from "../../stores/router.svelte.js";
import type { SessionInfo } from "../../types.js";

export function projectDisplayName(slug: string): string {
	return (
		projectState.projects.find((project) => project.slug === slug)?.title ||
		slug
	);
}

export function getProjectLabel(session: SessionInfo): string | undefined {
	const slug = session.projectSlug ?? getCurrentSlug();
	return slug ? projectDisplayName(slug) : undefined;
}

export function getProjectAccent(session: SessionInfo): number {
	const slug = session.projectSlug ?? getCurrentSlug();
	const index = projectState.projects.findIndex(
		(project) => project.slug === slug,
	);
	return (Math.max(index, 0) % 6) + 1;
}
