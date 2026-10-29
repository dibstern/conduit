import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import {
	type SessionWorkspace,
	SessionWorkspaceSchema,
} from "../contracts/session-workspace.js";
import { RelayError } from "../errors.js";

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

export const workspaceFolderPresent = (directory: string) =>
	Effect.tryPromise(() => stat(directory)).pipe(
		Effect.map((entry) => entry.isDirectory()),
		Effect.orElseSucceed(() => false),
	);

/** Availability is an observation; it never repairs a workspace or emits alerts. */
export const readWorkspaceFolders = (
	folders: readonly string[],
	workspace: SessionWorkspace | null | undefined,
	unavailable: ReadonlySet<string> = new Set(),
) =>
	Effect.gen(function* () {
		const result = sessionFolders(folders, workspace);
		const presence = new Map(
			yield* Effect.forEach(result.directories, (directory) =>
				workspaceFolderPresent(directory).pipe(
					Effect.map(
						(present) =>
							[directory, present && !unavailable.has(directory)] as const,
					),
				),
			),
		);
		return {
			...result,
			workspaceRootPresent: presence.get(result.workspaceRoot) === true,
			effectiveFolders: result.effectiveFolders.map((folder) => ({
				...folder,
				present: presence.get(folder.directory) === true,
			})),
		};
	});

const containsPath = (directory: string, path: string) => {
	const within = relative(directory, path);
	return (
		within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)
	);
};

/** Every Files read checks both lexical and realpath containment. */
export const guardWorkspacePath = (directory: string, path = ".") =>
	Effect.gen(function* () {
		const target = resolve(directory, path);
		const outside = () =>
			new RelayError("Path is outside the selected folder", {
				code: "PERMISSION_DENIED",
			});
		if (!containsPath(directory, target)) return yield* Effect.fail(outside());
		const [root, actual] = yield* Effect.tryPromise(() =>
			Promise.all([realpath(directory), realpath(target)]),
		);
		if (!containsPath(root, actual)) return yield* Effect.fail(outside());
	});

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
