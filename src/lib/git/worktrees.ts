import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import {
	WorkspaceMoveError,
	type WorktreeInfo,
} from "../contracts/session-workspace.js";
import { Subprocess } from "../domain/daemon/Services/subprocess.js";

export const realWorkspacePath = (path: string) =>
	Effect.tryPromise({
		try: () => realpath(path),
		catch: () => new WorkspaceMoveError({ path, reason: "missing" }),
	});

const git = (directory: string, ...args: string[]) =>
	Effect.gen(function* () {
		const owner = yield* Subprocess;
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
		const result = yield* owner.run("git", args, {
			cwd: directory,
			env,
			timeoutMs: 2_000,
		});
		if (result.exitCode !== 0)
			return yield* new WorkspaceMoveError({
				path: directory,
				reason: "not-a-worktree",
			});
		return result;
	}).pipe(
		Effect.mapError(
			() =>
				new WorkspaceMoveError({ path: directory, reason: "not-a-worktree" }),
		),
	);

/** Fresh local refs and ancestry for a destructive cleanup recheck. Never fetch. */
export const hasNoCommitsBeyondDefault = (directory: string, head: string) =>
	Effect.gen(function* () {
		const refs = yield* git(
			directory,
			"for-each-ref",
			"--format=%(refname) %(symref) %(objecttype)",
			"refs/remotes/origin/HEAD",
			"refs/heads/main",
			"refs/heads/master",
		).pipe(Effect.option);
		if (refs._tag === "None") return false;
		const candidates = refs.value.stdout.split("\n").flatMap((line) => {
			const [ref, symref, type] = line.split(" ");
			if (type !== "commit") return [];
			if (ref === "refs/remotes/origin/HEAD") return symref ? [symref] : [];
			return ref === "refs/heads/main" || ref === "refs/heads/master"
				? [ref]
				: [];
		});
		for (const ref of candidates) {
			const ancestor = yield* git(
				directory,
				"merge-base",
				"--is-ancestor",
				head,
				ref,
			).pipe(Effect.option);
			if (ancestor._tag === "Some") return true;
		}
		return false;
	});

/** The primary folder's local branch names, without tags or remote refs. */
export const listLocalBranches = (directory: string) =>
	Effect.gen(function* () {
		const current = (yield* git(
			directory,
			"branch",
			"--show-current",
		)).stdout.trim();
		const listed = yield* git(
			directory,
			"for-each-ref",
			"--sort=refname",
			"--format=%(refname:lstrip=2)",
			"refs/heads/",
		);
		return {
			...(current ? { current } : {}),
			branches: listed.stdout.trim().split("\n").filter(Boolean),
		};
	}).pipe(Effect.orElseSucceed(() => ({ branches: [] })));

/** Read the owning repository, including when directory is a linked worktree. */
export const readWorktrees = (directory: string) =>
	Effect.gen(function* () {
		const common = yield* git(directory, "rev-parse", "--git-common-dir");
		const commonDir = yield* realWorkspacePath(
			resolve(directory, common.stdout.trim()),
		);
		// -z avoids quoting or splitting paths containing spaces, newlines or quotes.
		const listed = yield* git(
			directory,
			"worktree",
			"list",
			"--porcelain",
			"-z",
		);
		const root = yield* git(directory, "rev-parse", "--show-toplevel");
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
