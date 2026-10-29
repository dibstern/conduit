import { Schema } from "effect";
import {
	type SessionWorkspace,
	SessionWorkspaceSchema,
} from "../contracts/session-workspace.js";

/** Project order and identity stay stable while each directory follows its workspace. */
export const effectiveSessionFolders = (
	folders: readonly string[],
	workspace: SessionWorkspace | null | undefined,
) =>
	folders.map((root) => ({
		root,
		directory: workspace?.worktrees[root] ?? root,
		...(workspace?.origin === "conduit" &&
		workspace.worktrees[root] === undefined
			? { shared: true }
			: {}),
	}));

/** Conduit launches keep the primary folder; existing moves can choose one other folder. */
export function effectiveWorkingDirectory(
	primary: string,
	workspace: SessionWorkspace | null | undefined,
): string {
	const worktrees = workspace?.worktrees;
	if (worktrees?.[primary]) return worktrees[primary];
	if (workspace?.origin === "conduit") return primary;
	const paths = Object.values(worktrees ?? {});
	return paths.length === 1 ? (paths[0] ?? primary) : primary;
}

/** One folder answer shared by launches, Files and Git publications. */
export const sessionFolders = (
	folders: readonly string[],
	workspace: SessionWorkspace | null | undefined,
) => {
	const workspaceRoot = effectiveWorkingDirectory(folders[0] ?? "", workspace);
	const effectiveFolders = effectiveSessionFolders(folders, workspace);
	const directories = [
		...new Set([
			workspaceRoot,
			...effectiveFolders.map(({ directory }) => directory),
		]),
	];
	return {
		workspaceRoot,
		effectiveFolders,
		directories,
		extraFolders: directories.filter(
			(directory) => directory !== workspaceRoot,
		),
	};
};

/** Resolve a persisted session mapping without checking or changing its workspace. */
export function storedWorkingDirectory(
	primary: string,
	workspace: string | null | undefined,
): string {
	return effectiveWorkingDirectory(
		primary,
		workspace == null
			? null
			: Schema.decodeUnknownSync(Schema.fromJsonString(SessionWorkspaceSchema))(
					workspace,
				),
	);
}
