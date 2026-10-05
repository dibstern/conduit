import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateSlug } from "../utils.js";

// This is the single owner of where project history lives.
export const projectStorageDir = (configDir: string, slug: string): string =>
	resolve(configDir, "projects", slug);

export const readProjectStorageOwner = (
	configDir: string,
	slug: string,
): string | undefined => {
	try {
		const owner: unknown = JSON.parse(
			readFileSync(
				resolve(projectStorageDir(configDir, slug), "project.json"),
				"utf8",
			),
		);
		return typeof owner === "object" &&
			owner !== null &&
			"mainFolder" in owner &&
			typeof owner.mainFolder === "string"
			? owner.mainFolder
			: undefined;
	} catch {
		return undefined;
	}
};

export const writeProjectStorageOwner = (
	configDir: string,
	slug: string,
	mainFolder: string,
): void => {
	writeFileSync(
		resolve(projectStorageDir(configDir, slug), "project.json"),
		JSON.stringify({ mainFolder: resolve(mainFolder) }),
	);
};

export const chooseProjectSlug = ({
	configDir,
	mainFolder,
	liveSlugs,
}: {
	readonly configDir: string;
	readonly mainFolder: string;
	readonly liveSlugs: ReadonlySet<string>;
}): string => {
	const normalizedDirectory = resolve(mainFolder);
	const reservedSlugs = new Set(liveSlugs);
	const storageRoot = resolve(configDir, "projects");
	let reusableSlug: string | undefined;
	if (existsSync(storageRoot)) {
		for (const entry of readdirSync(storageRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const owned =
				readProjectStorageOwner(configDir, entry.name) === normalizedDirectory;
			if (owned && !reservedSlugs.has(entry.name)) {
				reusableSlug ??= entry.name;
			} else if (!owned) {
				// Unreadable ownership records also reserve their storage slug.
				reservedSlugs.add(entry.name);
			}
		}
	}
	return reusableSlug ?? generateSlug(normalizedDirectory, reservedSlugs);
};

export const projectEventsDbPath = (project: {
	readonly configDir: string;
	readonly slug: string;
	readonly folders: readonly [string, ...string[]];
}): string => {
	const current = resolve(
		projectStorageDir(project.configDir, project.slug),
		"events.db",
	);
	const legacy = resolve(project.folders[0], ".conduit", "events.db");
	return !existsSync(current) && existsSync(legacy) ? legacy : current;
};
