import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import {
	WorkspaceMoveError,
	type WorktreeInfo,
} from "../contracts/session-workspace.js";

const execFileAsync = promisify(execFile);

export const realWorkspacePath = (path: string) =>
	Effect.tryPromise({
		try: () => realpath(path),
		catch: () => new WorkspaceMoveError({ path, reason: "missing" }),
	});

/** Read the owning repository, including when directory is a linked worktree. */
export const readWorktrees = (directory: string) =>
	Effect.gen(function* () {
		const git = (...args: string[]) =>
			Effect.tryPromise({
				try: () => {
					const env: NodeJS.ProcessEnv = {
						...process.env,
						GIT_OPTIONAL_LOCKS: "0",
					};
					for (const key of [
						"GIT_DIR",
						"GIT_INDEX_FILE",
						"GIT_WORK_TREE",
						"GIT_COMMON_DIR",
					])
						delete env[key];
					return execFileAsync("git", args, {
						cwd: directory,
						env,
						timeout: 2_000,
					});
				},
				catch: () =>
					new WorkspaceMoveError({ path: directory, reason: "not-a-worktree" }),
			});
		const common = yield* git("rev-parse", "--git-common-dir");
		const commonDir = yield* realWorkspacePath(
			resolve(directory, common.stdout.trim()),
		);
		// -z avoids quoting or splitting paths containing spaces, newlines or quotes.
		const listed = yield* git("worktree", "list", "--porcelain", "-z");
		const root = yield* git("rev-parse", "--show-toplevel");
		const worktrees: WorktreeInfo[] = [];
		const entries = listed.stdout.split("\0\0").filter(Boolean);
		for (const [index, entry] of entries.entries()) {
			const fields = entry.split("\0");
			const path = fields
				.find((field) => field.startsWith("worktree "))
				?.slice(9);
			if (
				!path ||
				fields.some(
					(field) => field === "bare" || field.startsWith("prunable"),
				) ||
				!existsSync(path)
			)
				continue;
			const normalized = yield* realWorkspacePath(path);
			const branch = fields
				.find((field) => field.startsWith("branch refs/heads/"))
				?.slice(18);
			worktrees.push({
				path: normalized,
				...(branch ? { branch } : {}),
				main: index === 0,
			});
		}
		return {
			commonDir,
			worktrees,
			root: yield* realWorkspacePath(root.stdout.trim()),
		};
	});

export const listProjectWorktrees = (folders: readonly string[]) =>
	Effect.gen(function* () {
		const repos = new Set<string>();
		const worktrees = new Map<string, WorktreeInfo>();
		for (const folder of folders) {
			const path = yield* realWorkspacePath(folder).pipe(Effect.option);
			if (path._tag === "None") continue;
			const repo = yield* readWorktrees(folder).pipe(Effect.option);
			const checkout =
				repo._tag === "Some"
					? repo.value.worktrees.find(({ path }) => path === repo.value.root)
					: undefined;
			// Configured folders are reset destinations, including repo subdirectories
			// and folders outside git. List each once, even for a shared repository.
			worktrees.set(path.value, {
				...checkout,
				path: path.value,
				main: checkout?.main ?? true,
			});
			if (repo._tag === "None" || repos.has(repo.value.commonDir)) continue;
			repos.add(repo.value.commonDir);
			for (const worktree of repo.value.worktrees)
				worktrees.set(worktree.path, worktree);
		}
		return [...worktrees.values()];
	});
