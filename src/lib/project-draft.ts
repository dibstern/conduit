import type { ProjectFolderInput } from "./contracts/ws-rpc.js";
import { checkFolders } from "./project-folders.js";

export interface ProjectDraft {
	readonly name: string;
	readonly nameEdited: boolean;
	readonly folders: readonly ProjectFolderInput[];
}

export const folderPath = (folder: ProjectFolderInput): string =>
	typeof folder === "string" ? folder : folder.path;

const mainName = (folders: readonly ProjectFolderInput[]): string => {
	const main = folders[0];
	if (main === undefined) return "";
	const path = folderPath(main);
	return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
};

const withFolders = (
	draft: ProjectDraft,
	folders: readonly ProjectFolderInput[],
): ProjectDraft => ({
	...draft,
	folders,
	name: draft.nameEdited ? draft.name : mainName(folders),
});

/** An empty draft for Add, or one prefilled from an existing project for Edit. */
export const createDraft = (project?: {
	title: string;
	folders: readonly string[];
}): ProjectDraft => {
	if (!project) return { name: "", nameEdited: false, folders: [] };
	return {
		name: project.title || mainName(project.folders),
		nameEdited: true,
		folders: project.folders,
	};
};

export const addFolder = (draft: ProjectDraft, folder: ProjectFolderInput) => {
	const folders = [...draft.folders, folder];
	const errors = checkFolders(folders.map(folderPath), []).errors.filter(
		(issue) => issue.kind === "duplicate",
	);
	return { draft: errors.length ? draft : withFolders(draft, folders), errors };
};

export const removeFolder = (draft: ProjectDraft, path: string): ProjectDraft =>
	withFolders(
		draft,
		draft.folders.filter((folder) => folderPath(folder) !== path),
	);

export const makeMain = (draft: ProjectDraft, path: string): ProjectDraft => {
	const folder = draft.folders.find((entry) => folderPath(entry) === path);
	if (folder === undefined || folder === draft.folders[0]) return draft;
	return withFolders(draft, [
		folder,
		...draft.folders.filter((entry) => entry !== folder),
	]);
};

export const rename = (draft: ProjectDraft, name: string): ProjectDraft => ({
	...draft,
	name,
	nameEdited: true,
});

export const check = (
	draft: ProjectDraft,
	otherProjects: readonly {
		slug: string;
		folders: readonly string[];
	}[],
) => ({
	...checkFolders(draft.folders.map(folderPath), otherProjects),
	nameError:
		draft.folders.length > 0 && !draft.name.trim()
			? "Give this project a name."
			: null,
});

export const isDirty = (draft: ProjectDraft, original: ProjectDraft): boolean =>
	draft.name !== original.name ||
	draft.nameEdited !== original.nameEdited ||
	draft.folders.length !== original.folders.length ||
	draft.folders.some((folder, index) => {
		const other = original.folders[index];
		return (
			other === undefined ||
			folderPath(folder) !== folderPath(other) ||
			(typeof folder === "string" ? undefined : folder.create.gitInit) !==
				(typeof other === "string" ? undefined : other.create.gitInit)
		);
	});
