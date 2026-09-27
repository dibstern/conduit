import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_RECONCILIATION_INTERVAL_MS } from "../domain/relay/Services/session-status-poller.js";
import type { SessionGit } from "../shared-types.js";

const execFileAsync = promisify(execFile);
const git = async (
	directory: string,
	...args: string[]
): Promise<string | undefined> => {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd: directory,
			timeout: 2_000,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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

const defaultRef = async (directory: string): Promise<string | undefined> => {
	const origin = await git(
		directory,
		"symbolic-ref",
		"-q",
		"refs/remotes/origin/HEAD",
	);
	if (origin && (await git(directory, "rev-parse", "--verify", "-q", origin)))
		return origin;
	const locals = await git(
		directory,
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads/main",
		"refs/heads/master",
	);
	return (
		locals?.split("\n").find((ref) => ref === "refs/heads/main") ??
		locals?.split("\n").find((ref) => ref === "refs/heads/master")
	);
};

export async function readSessionGit(
	directory: string,
): Promise<SessionGit | undefined> {
	try {
		const dirs = await git(
			directory,
			"rev-parse",
			"--absolute-git-dir",
			"--git-common-dir",
		);
		if (!dirs) return undefined;
		const [gitDir, commonDir] = dirs.split("\n");
		if (!gitDir || !commonDir) return undefined;
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
		const result: SessionGit = {
			...(branch ? { branch } : {}),
			...(head ? { head } : {}),
			...(worktree ? { worktree } : {}),
			...(operation ? { operation } : {}),
		};
		if (!branch) return result;
		const defaultBranch = await defaultRef(directory);
		if (!defaultBranch) return result;
		if (
			`refs/heads/${branch}` === defaultBranch ||
			branch === defaultBranch.replace(/^refs\/remotes\/origin\//, "")
		) {
			return { ...result, merged: false };
		}
		if (!head) return { ...result, merged: false };
		const ancestor = await git(
			directory,
			"merge-base",
			"--is-ancestor",
			`refs/heads/${branch}`,
			defaultBranch,
		);
		if (ancestor === undefined) return { ...result, merged: false };
		const reflog = await git(
			directory,
			"reflog",
			"show",
			"--format=%H",
			`refs/heads/${branch}`,
		);
		const creationPoint = reflog?.split("\n").at(-1);
		const tip = await git(directory, "rev-parse", `refs/heads/${branch}`);
		// Squash merges are intentionally missed: a false negative cannot hide live work.
		return {
			...result,
			merged: Boolean(creationPoint && tip && creationPoint !== tip),
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
