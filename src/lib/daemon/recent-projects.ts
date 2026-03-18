// ─── Recent Projects Tracking (Ticket 3.6) ──────────────────────────────────

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RecentProject } from "../types.js";

export const MAX_RECENT_PROJECTS = 20;

/** Add or update a project in the recent list */
export function addRecent(
	list: RecentProject[],
	directory: string,
	slug: string,
	title?: string,
	now: number = Date.now(),
): RecentProject[] {
	// Remove existing entry for same directory (if any)
	const filtered = list.filter((p) => p.directory !== directory);

	// Add at the beginning
	const entry: RecentProject = {
		directory,
		slug,
		...(title != null && { title }),
		lastUsed: now,
	};

	const result = [entry, ...filtered];

	// Prune to max size
	return pruneRecent(result, MAX_RECENT_PROJECTS);
}

/** Get the recent list sorted by most recent first */
export function getRecent(list: RecentProject[]): RecentProject[] {
	return [...list].sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Prune the list to maxSize, removing the oldest entries */
export function pruneRecent(
	list: RecentProject[],
	maxSize: number = MAX_RECENT_PROJECTS,
): RecentProject[] {
	if (list.length <= maxSize) return list;
	// Sort by lastUsed descending, keep top N
	const sorted = [...list].sort((a, b) => b.lastUsed - a.lastUsed);
	return sorted.slice(0, maxSize);
}

/** Serialize the recent list to JSON */
export function serializeRecent(list: RecentProject[]): string {
	return JSON.stringify({ recentProjects: list }, null, 2);
}

/**
 * Check if a directory string looks like a valid project path.
 * Rejects empty strings, non-absolute paths, and paths with control characters.
 */
export function isValidProjectPath(directory: string): boolean {
	if (!directory || !isAbsolute(directory)) return false;
	// Reject paths with control characters (code < 32) — sign of corruption
	for (let i = 0; i < directory.length; i++) {
		if (directory.charCodeAt(i) < 32) return false;
	}
	return true;
}

/** Deserialize the recent list from JSON */
export function deserializeRecent(json: string): RecentProject[] {
	try {
		const parsed = JSON.parse(json);
		if (!parsed || !Array.isArray(parsed.recentProjects)) return [];
		return parsed.recentProjects.filter(
			(p: unknown): p is RecentProject =>
				typeof p === "object" &&
				p !== null &&
				typeof (p as RecentProject).directory === "string" &&
				typeof (p as RecentProject).slug === "string" &&
				typeof (p as RecentProject).lastUsed === "number" &&
				isValidProjectPath((p as RecentProject).directory),
		);
	} catch {
		return [];
	}
}

/**
 * Filter deserialized projects to only those whose directories exist on disk.
 * Call this after deserializeRecent() when displaying in the TUI.
 */
export function filterExistingProjects(
	projects: RecentProject[],
): RecentProject[] {
	return projects.filter((p) => {
		try {
			return existsSync(p.directory);
		} catch {
			return false;
		}
	});
}
