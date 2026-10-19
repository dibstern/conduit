// The project tree: the session list grouped under one header per project.
// Sort mode, rows per project and collapsed projects belong to this device;
// the manual order is daemon config, so every device shares it.

import { toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type { ProjectInfo, SessionInfo } from "../types.js";
import { projectState } from "./project-state.svelte.js";
import type { SessionSection } from "./session.svelte.js";

export type ProjectSort = "recent" | "created" | "manual";

export const PROJECT_TREE_ROWS = { min: 1, max: 15, default: 6 } as const;

const SORT_KEY = "project-tree-sort";
const ROWS_KEY = "project-tree-rows";
const COLLAPSED_KEY = "project-tree-collapsed";

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* Storage may be unavailable; keep the in-memory preference. */
	}
}

function readSort(): ProjectSort {
	const stored = read(SORT_KEY);
	return stored === "created" || stored === "manual" ? stored : "recent";
}

function readRows(): number {
	const stored = Number(read(ROWS_KEY));
	return Number.isInteger(stored) &&
		stored >= PROJECT_TREE_ROWS.min &&
		stored <= PROJECT_TREE_ROWS.max
		? stored
		: PROJECT_TREE_ROWS.default;
}

function readCollapsed(): string[] {
	try {
		const parsed: unknown = JSON.parse(read(COLLAPSED_KEY) ?? "[]");
		return Array.isArray(parsed)
			? parsed.filter((slug): slug is string => typeof slug === "string")
			: [];
	} catch {
		return [];
	}
}

export const projectTreeState = $state({
	sort: readSort(),
	/** Rows each project shows before "Show more". */
	rows: readRows(),
	collapsed: readCollapsed(),
	/** Projects showing every loaded row. Not persisted: a reload starts short. */
	showingAll: [] as string[],
	/** A dragged order the daemon has not confirmed yet; it wins over the saved order. */
	pendingOrder: null as readonly string[] | null,
});

let latestOrderRequest = 0;

export function setProjectSort(sort: ProjectSort): void {
	projectTreeState.sort = sort;
	write(SORT_KEY, sort);
}

export function setProjectTreeRows(rows: number): void {
	projectTreeState.rows = rows;
	write(ROWS_KEY, String(rows));
}

const toggled = (slugs: readonly string[], slug: string): string[] =>
	slugs.includes(slug) ? slugs.filter((s) => s !== slug) : [...slugs, slug];

export function toggleProjectCollapsed(slug: string): void {
	projectTreeState.collapsed = toggled(projectTreeState.collapsed, slug);
	write(COLLAPSED_KEY, JSON.stringify(projectTreeState.collapsed));
}

export function toggleProjectShowingAll(slug: string): void {
	projectTreeState.showingAll = toggled(projectTreeState.showingAll, slug);
}

/** Saves a dragged order. The shell feed echoes it back to every client. */
export function setProjectOrder(projectOrder: string[]): void {
	const request = ++latestOrderRequest;
	projectTreeState.pendingOrder = projectOrder;
	// Only the newest drag settles the pending order, so an older reply can
	// neither restore a superseded order nor drop a newer one. On failure the
	// daemon's saved order, which the shell feed keeps current, shows again.
	rpc("SetProjectOrder", { projectOrder }).then(
		() => {
			if (request !== latestOrderRequest) return;
			projectState.projectOrder = projectOrder;
			projectTreeState.pendingOrder = null;
		},
		(error: unknown) => {
			if (request === latestOrderRequest) projectTreeState.pendingOrder = null;
			toastFailure("Couldn't save the project order")(error);
		},
	);
}

export type ProjectTreeNode = {
	slug: string;
	title: string;
	/** The project's live sessions, which the tree holds. */
	sessions: SessionInfo[];
	/** The rows rendered: a preview, every row, or only the open session. */
	shown: SessionInfo[];
	collapsed: boolean;
	/** The preview toggle, when the project has more rows than the preview. */
	more: "more" | "less" | null;
	/** No loaded session at all, on a shelf or not. */
	empty: boolean;
	/** False for a missing or unavailable project, which cannot take a new session. */
	available: boolean;
};

/**
 * One node per project, in the chosen order. `sessions` is every loaded row
 * in view, shelved ones included: they still date the project's last message.
 * A narrowed list (search or status filter) shows only matching projects,
 * expanded in full.
 */
export function buildProjectTree({
	projects,
	sections,
	sessions,
	narrowed,
	currentId,
}: {
	projects: readonly Pick<
		ProjectInfo,
		"slug" | "title" | "addedAt" | "missing" | "unavailableReason"
	>[];
	sections: readonly SessionSection[];
	sessions: readonly SessionInfo[];
	narrowed: boolean;
	currentId: string | null;
}): ProjectTreeNode[] {
	const { sort, rows, collapsed, showingAll } = projectTreeState;
	const live = new Map(
		sections.map((section) => [section.key, section.sessions]),
	);
	// Rows can name a project the registry has not delivered yet; they still get a header.
	const known = new Set(projects.map((project) => project.slug));
	const headers: (typeof projects)[number][] = [
		...projects,
		...sections
			.filter((section) => !known.has(section.key))
			.map((section) => ({ slug: section.key, title: section.label })),
	];
	const loaded = new Set(sessions.map((session) => session.projectSlug));
	return sortProjects(
		headers,
		sessions,
		sort,
		projectTreeState.pendingOrder ?? projectState.projectOrder,
	)
		.filter((project) => !narrowed || live.has(project.slug))
		.map((project) => {
			const projectSessions = live.get(project.slug) ?? [];
			const isCollapsed = !narrowed && collapsed.includes(project.slug);
			const showAll = narrowed || showingAll.includes(project.slug);
			const long = !narrowed && projectSessions.length > rows;
			return {
				slug: project.slug,
				title: project.title || project.slug,
				sessions: projectSessions,
				// The open session stays in sight, collapsed or past the preview.
				shown: projectSessions.filter(
					(session, index) =>
						session.id === currentId ||
						(!isCollapsed && (showAll || index < rows)),
				),
				collapsed: isCollapsed,
				more: isCollapsed || !long ? null : showAll ? "less" : "more",
				empty: !loaded.has(project.slug),
				available: !project.missing && !project.unavailableReason,
			};
		});
}

/**
 * Newest first by latest user message (a project without one by when it was
 * added) or by when it was added; ties by title. Manual follows the saved
 * order, and projects it has never seen keep registry order after it.
 */
function sortProjects<
	P extends Pick<ProjectInfo, "slug" | "title" | "addedAt">,
>(
	projects: readonly P[],
	sessions: readonly SessionInfo[],
	sort: ProjectSort,
	manualOrder: readonly string[],
): P[] {
	if (sort === "manual") {
		const rank = new Map(manualOrder.map((slug, index) => [slug, index]));
		const rankOf = (project: P) => rank.get(project.slug) ?? manualOrder.length;
		return [...projects].sort((a, b) => rankOf(a) - rankOf(b));
	}
	const latest = new Map<string, number>();
	if (sort === "recent") {
		for (const { projectSlug, lastUserMessageAt } of sessions) {
			if (
				lastUserMessageAt !== undefined &&
				lastUserMessageAt > (latest.get(projectSlug) ?? -Infinity)
			) {
				latest.set(projectSlug, lastUserMessageAt);
			}
		}
	}
	const time = (project: P) => latest.get(project.slug) ?? project.addedAt ?? 0;
	return [...projects].sort(
		(a, b) => time(b) - time(a) || a.title.localeCompare(b.title),
	);
}
