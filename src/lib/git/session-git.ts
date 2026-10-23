import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { SessionWorkspace } from "../contracts/session-workspace.js";
import {
	makeSubprocessRunner,
	type SubprocessRunner,
} from "../domain/daemon/Services/subprocess.js";
import { DEFAULT_RECONCILIATION_INTERVAL_MS } from "../domain/relay/Services/session-status-poller.js";
import { labelProjectFolders } from "../project-folders.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../session/session-workspace.js";
import type { ProjectInfo, SessionGit, SessionInfo } from "../shared-types.js";

const GIT_COMMAND_TIMEOUT_MS = 2_000;

const execGit = (
	directory: string,
	runner: SubprocessRunner,
	args: string[],
): Promise<string> => {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	for (const key of [
		"GIT_DIR",
		"GIT_INDEX_FILE",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
	])
		delete env[key];
	return runner("git", args, {
		cwd: directory,
		timeoutMs: GIT_COMMAND_TIMEOUT_MS,
		priority: "background",
		env,
	}).then(({ stdout, stderr, exitCode }) => {
		if (exitCode !== 0)
			throw Object.assign(new Error(stderr || `git exited ${exitCode}`), {
				code: exitCode,
				stdout,
				stderr,
			});
		return stdout;
	});
};

const git = (
	directory: string,
	runner: SubprocessRunner,
	...args: string[]
): Promise<string | undefined> =>
	execGit(directory, runner, args).then(
		(stdout) => stdout.trim(),
		() => undefined,
	);

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

// Every spawn blocks the daemon's event loop until the child execs, which takes
// hundreds of ms on a loaded machine, so each read uses as few git calls as it can.
const defaultRefs = async (
	directory: string,
	runner: SubprocessRunner,
): Promise<string[]> => {
	const refs = await git(
		directory,
		runner,
		"for-each-ref",
		"--format=%(refname) %(symref) %(objecttype)",
		"refs/remotes/origin/HEAD",
		"refs/heads/main",
		"refs/heads/master",
	);
	// Patterns also match refs nested below them, so keep exact names only.
	return (refs?.split("\n") ?? []).flatMap((line) => {
		const [ref, symref, type] = line.split(" ");
		if (ref === "refs/remotes/origin/HEAD")
			return symref && type === "commit" ? [symref] : [];
		return ref === "refs/heads/main" || ref === "refs/heads/master"
			? [ref]
			: [];
	});
};

/** Local default refs only, sharing merge detection's candidates. Never fetch. */
export async function hasNoCommitsBeyondDefault(
	directory: string,
	head: string,
	runner: SubprocessRunner = makeSubprocessRunner(),
): Promise<boolean> {
	for (const ref of await defaultRefs(directory, runner))
		if (
			(await git(
				directory,
				runner,
				"merge-base",
				"--is-ancestor",
				head,
				ref,
			)) !== undefined
		)
			return true;
	return false;
}

export async function readSessionGit(
	directory: string,
	previous?: SessionGit,
	runner: SubprocessRunner = makeSubprocessRunner(),
): Promise<SessionGit | undefined> {
	try {
		// Fails outside a work tree. A huge change list can outgrow maxBuffer; the
		// branch headers come first and one entry marks it dirty, so keep the cut output.
		const status = await execGit(directory, runner, [
			"status",
			"--porcelain=v2",
			"--branch",
			"--untracked-files=normal",
		]).catch((error: { reason?: string; stdout?: string }) =>
			error.reason === "output-limit" ? error.stdout : undefined,
		);
		if (status === undefined) return undefined;
		const lines = status.split("\n");
		const header = (key: string) =>
			lines.find((line) => line.startsWith(`# ${key} `))?.slice(key.length + 3);
		const oid = header("branch.oid");
		const branchHead = header("branch.head");
		const branch =
			branchHead && branchHead !== "(detached)" ? branchHead : undefined;
		// --short HEAD fails on a branch with no commits yet.
		const born = oid !== undefined && oid !== "(initial)";
		const dirs = await git(
			directory,
			runner,
			"rev-parse",
			"--absolute-git-dir",
			"--git-common-dir",
			...(born ? ["--short", "HEAD"] : []),
		);
		if (!dirs) return undefined;
		const [gitDir, commonDir, head] = dirs.split("\n");
		if (!gitDir || !commonDir) return undefined;
		const common = isAbsolute(commonDir)
			? resolve(commonDir)
			: resolve(directory, commonDir);
		const worktree =
			realpathSync(gitDir) !== realpathSync(common)
				? basename(gitDir)
				: undefined;
		const operation = operationAt(gitDir);
		const counts = header("branch.ab")?.match(/^\+(\d+) -(\d+)$/);
		const result: SessionGit = {
			...(branch ? { branch } : {}),
			...(head ? { head } : {}),
			...(worktree ? { worktree } : {}),
			dirty: lines.some((line) => line !== "" && !line.startsWith("#")),
			...(counts
				? { ahead: Number(counts[1]), behind: Number(counts[2]) }
				: {}),
			...(operation ? { operation } : {}),
		};
		if (!branch) return result;
		const defaultBranches = await defaultRefs(directory, runner);
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
		if (!head || !born) return { ...result, merged: false };
		// HEAD is the checked-out branch, so its oid is the branch tip.
		const tip = oid;
		const containingDefaults: string[] = [];
		for (const ref of defaultBranches) {
			const ancestor = await git(
				directory,
				runner,
				"merge-base",
				"--is-ancestor",
				tip,
				ref,
			);
			if (ancestor !== undefined) containingDefaults.push(ref);
		}
		if (containingDefaults.length === 0) return { ...result, merged: false };
		// A merged tip that has not moved stays merged; skip re-deriving it every poll.
		if (
			previous?.merged &&
			previous.mergedHead === tip &&
			previous.mergedAt !== undefined
		)
			return {
				...result,
				merged: true,
				mergedHead: tip,
				mergedAt: previous.mergedAt,
			};
		const reflog = await git(
			directory,
			runner,
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
					runner,
					"rev-parse",
					"--verify",
					"-q",
					`${ref}@{${createdAt}}`,
				);
				const base = previousDefault
					? await git(directory, runner, "merge-base", tip, previousDefault)
					: undefined;
				merged = base !== undefined && base !== tip;
				if (merged) break;
			}
		}
		if (!merged) return { ...result, merged };
		let mergedAt = previous?.mergedHead === tip ? previous.mergedAt : undefined;
		if (mergedAt === undefined) {
			for (const ref of containingDefaults) {
				const ancestry = await git(
					directory,
					runner,
					"log",
					"--ancestry-path",
					"--format=%H %ct %P",
					`${tip}..${ref}`,
				);
				const descendants = new Set([tip]);
				let refMergedAt: number | undefined;
				for (const line of ancestry?.split("\n") ?? []) {
					const [sha, committedAt, ...parents] = line.split(" ");
					if (!sha || !committedAt) continue;
					descendants.add(sha);
					const time = Number(committedAt) * 1_000;
					if (parents.slice(1).includes(tip) && Number.isFinite(time))
						refMergedAt = Math.min(
							refMergedAt ?? Number.POSITIVE_INFINITY,
							time,
						);
				}
				if (refMergedAt === undefined) {
					const defaultReflog = await git(
						directory,
						runner,
						"reflog",
						"show",
						"--date=unix",
						"--format=%H %gd",
						ref,
					);
					// Entries are newest first, so retain the oldest containing entry.
					for (const line of defaultReflog?.split("\n") ?? []) {
						const entry = line.match(/^([a-f0-9]+) .+@\{(\d+)\}$/);
						if (entry?.[1] && descendants.has(entry[1]))
							refMergedAt = Number(entry[2]) * 1_000;
					}
				}
				if (refMergedAt === undefined) {
					// An underestimate can miss an auto-settle, but cannot hide newer work.
					const committedAt = await git(
						directory,
						runner,
						"log",
						"-1",
						"--format=%ct",
						tip,
					);
					if (committedAt && Number.isFinite(Number(committedAt)))
						refMergedAt = Number(committedAt) * 1_000;
				}
				if (refMergedAt !== undefined)
					mergedAt = Math.min(
						mergedAt ?? Number.POSITIVE_INFINITY,
						refMergedAt,
					);
			}
		}
		return {
			...result,
			merged,
			mergedHead: tip,
			...(mergedAt !== undefined ? { mergedAt } : {}),
		};
	} catch {
		return undefined;
	}
}

export const SESSION_GIT_REFRESH_INTERVAL_MS =
	DEFAULT_RECONCILIATION_INTERVAL_MS;

export function createSessionGitCache(
	read: (
		directory: string,
		previous?: SessionGit,
	) => Promise<SessionGit | undefined> = readSessionGit,
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
				reading = read(directory, entries.get(directory)?.value);
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
