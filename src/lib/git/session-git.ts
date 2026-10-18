import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SessionWorkspace } from "../contracts/session-workspace.js";
import { DEFAULT_RECONCILIATION_INTERVAL_MS } from "../domain/relay/Services/session-status-poller.js";
import { labelProjectFolders } from "../project-folders.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../session/session-workspace.js";
import type { ProjectInfo, SessionGit, SessionInfo } from "../shared-types.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 2_000;

const git = async (
	directory: string,
	...args: string[]
): Promise<string | undefined> => {
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			delete env[key];
		const { stdout } = await execFileAsync("git", args, {
			cwd: directory,
			timeout: GIT_COMMAND_TIMEOUT_MS,
			env,
		});
		return stdout.trim();
	} catch {
		return undefined;
	}
};

const operationAt = (gitDir: string): SessionGit["operation"] => {
	if (
		existsSync(join(gitDir, "rebase-merge")) ||
		existsSync(join(gitDir, "rebase-apply"))
	)
		return "rebase";
	if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
	if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
	if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
	if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect";
	return undefined;
};

const defaultRefs = async (directory: string): Promise<string[]> => {
	const refs: string[] = [];
	const origin = await git(
		directory,
		"symbolic-ref",
		"-q",
		"refs/remotes/origin/HEAD",
	);
	if (
		origin &&
		(await git(directory, "rev-parse", "--verify", "-q", `${origin}^{commit}`))
	)
		refs.push(origin);
	const locals = await git(
		directory,
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads/main",
		"refs/heads/master",
	);
	refs.push(
		...(locals
			?.split("\n")
			.filter(
				(ref) => ref === "refs/heads/main" || ref === "refs/heads/master",
			) ?? []),
	);
	return refs;
};

/** Local default refs only, sharing merge detection's candidates. Never fetch. */
export async function hasNoCommitsBeyondDefault(
	directory: string,
	head: string,
): Promise<boolean> {
	for (const ref of await defaultRefs(directory))
		if (
			(await git(directory, "merge-base", "--is-ancestor", head, ref)) !==
			undefined
		)
			return true;
	return false;
}

export async function readSessionGit(
	directory: string,
): Promise<SessionGit | undefined> {
	try {
		const dirs = await git(
			directory,
			"rev-parse",
			"--absolute-git-dir",
			"--git-common-dir",
			"--is-inside-work-tree",
		);
		if (!dirs) return undefined;
		const [gitDir, commonDir, insideWorkTree] = dirs.split("\n");
		if (!gitDir || !commonDir || insideWorkTree !== "true") return undefined;
		const common = isAbsolute(commonDir)
			? resolve(commonDir)
			: resolve(directory, commonDir);
		const branch = await git(
			directory,
			"symbolic-ref",
			"-q",
			"--short",
			"HEAD",
		);
		const head = await git(
			directory,
			"rev-parse",
			"--verify",
			"--short",
			"HEAD",
		);
		const worktree =
			realpathSync(gitDir) !== realpathSync(common)
				? basename(gitDir)
				: undefined;
		const operation = operationAt(gitDir);
		const [status, upstream] = await Promise.all([
			git(directory, "status", "--porcelain=v1", "--untracked-files=normal"),
			branch
				? git(
						directory,
						"rev-list",
						"--left-right",
						"--count",
						"HEAD...@{upstream}",
					)
				: Promise.resolve(undefined),
		]);
		const counts = upstream?.match(/^(\d+)\s+(\d+)$/);
		const result: SessionGit = {
			...(branch ? { branch } : {}),
			...(head ? { head } : {}),
			...(worktree ? { worktree } : {}),
			...(status !== undefined ? { dirty: status.length > 0 } : {}),
			...(counts
				? { ahead: Number(counts[1]), behind: Number(counts[2]) }
				: {}),
			...(operation ? { operation } : {}),
		};
		if (!branch) return result;
		const defaultBranches = await defaultRefs(directory);
		if (defaultBranches.length === 0) return result;
		if (
			defaultBranches.some(
				(ref) =>
					`refs/heads/${branch}` === ref ||
					branch === ref.replace(/^refs\/remotes\/origin\//, ""),
			)
		) {
			return { ...result, merged: false };
		}
		if (!head) return { ...result, merged: false };
		const tip = await git(directory, "rev-parse", `refs/heads/${branch}`);
		if (!tip) return { ...result, merged: false };
		const containingDefaults: string[] = [];
		for (const ref of defaultBranches) {
			const ancestor = await git(
				directory,
				"merge-base",
				"--is-ancestor",
				tip,
				ref,
			);
			if (ancestor !== undefined) containingDefaults.push(ref);
		}
		if (containingDefaults.length === 0) return { ...result, merged: false };
		const reflog = await git(
			directory,
			"reflog",
			"show",
			"--format=%H %gD",
			"--date=unix",
			`refs/heads/${branch}`,
		);
		const creation = reflog
			?.split("\n")
			.at(-1)
			?.match(/^([a-f0-9]+) .+@\{(\d+)\}$/);
		const creationPoint = creation?.[1];
		// Squash merges are intentionally missed: a false negative cannot hide live work.
		let merged = Boolean(creationPoint && creationPoint !== tip);
		if (!merged && creation?.[2]) {
			// An existing branch can start at its final feature commit. Its default
			// ref at creation must exclude the tip; a fresh branch on default is
			// not merged work. Date lookup also resolves a clone's first fetch's old SHA.
			const createdAt = new Date(Number(creation[2]) * 1_000).toISOString();
			for (const ref of containingDefaults) {
				const previousDefault = await git(
					directory,
					"rev-parse",
					"--verify",
					"-q",
					`${ref}@{${createdAt}}`,
				);
				const base = previousDefault
					? await git(directory, "merge-base", tip, previousDefault)
					: undefined;
				merged = base !== undefined && base !== tip;
				if (merged) break;
			}
		}
		return {
			...result,
			merged,
			...(merged ? { mergedHead: tip } : {}),
		};
	} catch {
		return undefined;
	}
}

export const SESSION_GIT_REFRESH_INTERVAL_MS =
	DEFAULT_RECONCILIATION_INTERVAL_MS;

export function createSessionGitCache(
	read: (directory: string) => Promise<SessionGit | undefined> = readSessionGit,
) {
	const entries = new Map<
		string,
		{ value: SessionGit | undefined; refreshedAt: number }
	>();
	const inFlight = new Map<string, Promise<SessionGit | undefined>>();
	return {
		peek: (directory: string) => entries.get(directory)?.value,
		/** Serve `value`, already stale, until the folder is first read. */
		seed: (directory: string, value: SessionGit | undefined) => {
			if (!entries.has(directory))
				entries.set(directory, { value, refreshedAt: 0 });
		},
		isStale: (directory: string) => {
			const entry = entries.get(directory);
			return (
				!entry ||
				Date.now() - entry.refreshedAt >= SESSION_GIT_REFRESH_INTERVAL_MS
			);
		},
		refresh: (directory: string): Promise<SessionGit | undefined> => {
			const pending = inFlight.get(directory);
			if (pending) return pending;
			let reading: Promise<SessionGit | undefined>;
			try {
				reading = read(directory);
			} catch {
				reading = Promise.resolve(undefined);
			}
			const promise = reading
				.catch(() => undefined)
				.then((value) => {
					entries.set(directory, { value, refreshedAt: Date.now() });
					return value;
				})
				.finally(() => {
					inFlight.delete(directory);
				});
			inFlight.set(directory, promise);
			return promise;
		},
	};
}

export const daemonSessionGitCache = createSessionGitCache();

const cachedFolderGit = (
	folders: readonly [string, ...string[]],
	workspace: SessionWorkspace | null | undefined,
	cache: ReturnType<typeof createSessionGitCache>,
): SessionGit | undefined => {
	const roots = labelProjectFolders(folders);
	const statuses = effectiveSessionFolders(folders, workspace).flatMap(
		({ root, directory, shared }, index) => {
			const git = cache.peek(directory);
			return git || shared
				? [
						{
							...git,
							root,
							label: roots[index]?.label ?? root,
							...(shared ? { shared } : {}),
						},
					]
				: [];
		},
	);
	const primary = cache.peek(effectiveWorkingDirectory(folders[0], workspace));
	return primary || statuses.length
		? { ...primary, folders: statuses }
		: undefined;
};

export function withCachedSessionGit(
	session: SessionInfo,
	folders: readonly [string, ...string[]],
	cache = daemonSessionGitCache,
): SessionInfo {
	const git = cachedFolderGit(folders, session.workspace, cache);
	const { git: _previous, ...rest } = session;
	return git ? { ...rest, git } : rest;
}

export const withCachedProjectGit = <T extends ProjectInfo>(
	projects: ReadonlyArray<T>,
): Array<T & { readonly missing: boolean }> =>
	projects.map((project) => {
		const git = cachedFolderGit(project.folders, null, daemonSessionGitCache);
		return {
			...project,
			missing: !existsSync(project.folders[0]),
			...(git && { git }),
		};
	});
