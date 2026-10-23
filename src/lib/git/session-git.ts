import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

const missingFile = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT" ||
	(error as NodeJS.ErrnoException).code === "ENOTDIR";

const readOptional = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8").trim();
	} catch (error) {
		if (missingFile(error)) return undefined;
		throw error;
	}
};

const fileStamp = (path: string): string => {
	try {
		const { mtimeMs, ctimeMs, size, ino } = statSync(path);
		return `${mtimeMs}:${ctimeMs}:${size}:${ino}`;
	} catch (error) {
		if (missingFile(error)) return "missing";
		throw error;
	}
};

const snapshot = (paths: Iterable<string>) =>
	new Map([...paths].map((path) => [path, fileStamp(path)]));
const unchanged = (files: ReadonlyMap<string, string>) =>
	[...files].every(([path, stamp]) => fileStamp(path) === stamp);
const isOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

// Missing refs are unborn; null asks the caller to fall back to git.
const readRef = (
	common: string,
	ref: string,
	paths = new Set<string>(),
	depth = 0,
): string | null | undefined => {
	if (
		depth > 8 ||
		!/^refs\/[^\s\\]+$/.test(ref) ||
		ref.split("/").some((part) => !part || part === "." || part === "..")
	)
		return null;
	const path = join(common, ref);
	paths.add(path);
	const value = readOptional(path);
	if (value !== undefined) {
		if (!lstatSync(path).isFile()) return null;
		if (value.startsWith("ref: "))
			return readRef(common, value.slice(5), paths, depth + 1);
		if (isOid(value)) return value;
		return null;
	}
	const packed = join(common, "packed-refs");
	paths.add(packed);
	for (const line of readOptional(packed)?.split("\n") ?? []) {
		if (!line || line.startsWith("#") || line.startsWith("^")) continue;
		const [oid, name] = line.split(" ");
		if (!oid || !isOid(oid) || !name) return null;
		if (name === ref) return oid;
	}
	return undefined;
};

const readGitFiles = (directory: string) => {
	try {
		let root = realpathSync(directory);
		let gitDir: string;
		for (;;) {
			const path = join(root, ".git");
			try {
				const entry = lstatSync(path);
				if (entry.isDirectory()) gitDir = path;
				else if (entry.isFile()) {
					const target = readOptional(path)?.match(/^gitdir: ([^\r\n]+)$/)?.[1];
					if (!target) return undefined;
					gitDir = resolve(root, target);
				} else return undefined;
				break;
			} catch (error) {
				if (!missingFile(error)) throw error;
			}
			const parent = dirname(root);
			if (parent === root) return undefined;
			root = parent;
		}
		gitDir = realpathSync(gitDir);
		const shared = readOptional(join(gitDir, "commondir"));
		if (shared !== undefined && (!shared || /[\r\n]/.test(shared)))
			return undefined;
		const common = realpathSync(shared ? resolve(gitDir, shared) : gitDir);
		const config = readFileSync(join(common, "config"), "utf8");
		if (
			/^\s*refStorage\s*=/im.test(config) ||
			existsSync(join(common, "reftable"))
		)
			return undefined;
		const headPath = join(gitDir, "HEAD");
		if (!lstatSync(headPath).isFile()) return undefined;
		const head = readFileSync(headPath, "utf8").trim();
		if (isOid(head)) return { gitDir, common, oid: head, branch: undefined };
		if (!head.startsWith("ref: refs/heads/")) return undefined;
		const ref = head.slice(5);
		const oid = readRef(common, ref);
		return oid === null
			? undefined
			: { gitDir, common, oid, branch: ref.slice(11) };
	} catch {
		return undefined;
	}
};

const repositoryRefs = new Map<
	string,
	{
		refs: string[];
		files: Map<string, string>;
		merges: Map<
			string,
			{
				key: string;
				previousAt?: number;
				value: Pick<SessionGit, "merged" | "mergedHead" | "mergedAt">;
			}
		>;
	}
>();

/** The watcher can evict a repository without knowing its worktrees. */
export function invalidateSessionGitRepository(commonDir: string): void {
	try {
		repositoryRefs.delete(realpathSync(commonDir));
	} catch {
		repositoryRefs.delete(resolve(commonDir));
	}
}

// Porcelain v2 emits a full oid. Let git choose the exact abbreviation, then
// reuse it while config and the object files that can affect it stay unchanged.
const shortHeads = new Map<
	string,
	{ oid: string; head: string; files: Map<string, string>; env: string }
>();
const shortHead = async (
	directory: string,
	gitDir: string,
	common: string,
	oid: string,
	runner: SubprocessRunner,
) => {
	const configPaths = [
		join(gitDir, "HEAD"),
		join(common, "config"),
		join(gitDir, "config.worktree"),
		process.env["GIT_CONFIG_GLOBAL"] ?? join(homedir(), ".gitconfig"),
		join(
			process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
			"git/config",
		),
		process.env["GIT_CONFIG_SYSTEM"] ?? "/etc/gitconfig",
		"/opt/homebrew/etc/gitconfig",
		"/usr/local/etc/gitconfig",
	];
	// Alternate object stores need git's object discovery on every read.
	const cacheable =
		!existsSync(join(common, "objects/info/alternates")) &&
		!process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] &&
		!process.env["GIT_OBJECT_DIRECTORY"];
	const paths = [
		...configPaths,
		join(common, "objects/pack"),
		join(common, "objects", oid.slice(0, 2)),
	];
	const env = JSON.stringify([
		homedir(),
		process.env["XDG_CONFIG_HOME"],
		Object.entries(process.env).filter(([key]) => key.startsWith("GIT_CONFIG")),
	]);
	const cached = shortHeads.get(gitDir);
	if (
		cacheable &&
		cached?.oid === oid &&
		cached.env === env &&
		unchanged(cached.files)
	)
		return cached.head;
	// Git resolves quoted paths and conditional includes. Watch their origins and
	// even absent include targets so creating a config file invalidates the cache.
	const config = await git(
		directory,
		runner,
		"config",
		"--null",
		"--list",
		"--show-origin",
	);
	const fields = config?.split("\0") ?? [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const origin = fields[index]?.replace(/^file:/, "");
		if (!origin || !fields[index]?.startsWith("file:")) continue;
		paths.push(resolve(directory, origin));
		const entry = fields[index + 1] ?? "";
		const newline = entry.indexOf("\n");
		if (/^include(?:if\..+)?\.path$/i.test(entry.slice(0, newline))) {
			const target = entry.slice(newline + 1);
			paths.push(
				target.startsWith("~/")
					? join(homedir(), target.slice(2))
					: resolve(dirname(resolve(directory, origin)), target),
			);
		}
	}
	const files = snapshot(paths);
	const head = await git(directory, runner, "rev-parse", "--short", "HEAD");
	if (cacheable && config !== undefined && head && unchanged(files))
		shortHeads.set(gitDir, { oid, head, files, env });
	return head;
};

// Every spawn blocks the daemon's event loop until the child execs, which takes
// hundreds of ms on a loaded machine, so each read uses as few git calls as it can.
const defaultRefs = async (
	directory: string,
	runner: SubprocessRunner,
	common?: string,
): Promise<string[]> => {
	const cached = common ? repositoryRefs.get(common) : undefined;
	if (cached && unchanged(cached.files)) return cached.refs;
	if (common) repositoryRefs.delete(common);
	const paths = new Set(
		common
			? [
					join(common, "config"),
					join(common, "packed-refs"),
					join(common, "refs/heads"),
					join(common, "refs/remotes/origin"),
					join(common, "shallow"),
					join(common, "info/grafts"),
				]
			: [],
	);
	if (common) {
		try {
			for (const ref of [
				"refs/remotes/origin/HEAD",
				"refs/heads/main",
				"refs/heads/master",
			]) {
				if (readRef(common, ref, paths) === null) {
					common = undefined;
					break;
				}
			}
		} catch {
			// Unusual refs still use git, without caching an incomplete dependency set.
			common = undefined;
		}
	}
	const files = snapshot(paths);
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
	const result = (refs?.split("\n") ?? []).flatMap((line) => {
		const [ref, symref, type] = line.split(" ");
		if (ref === "refs/remotes/origin/HEAD")
			return symref && type === "commit" ? [symref] : [];
		return ref === "refs/heads/main" || ref === "refs/heads/master"
			? [ref]
			: [];
	});
	if (common && refs !== undefined && unchanged(files))
		repositoryRefs.set(common, { refs: result, files, merges: new Map() });
	return result;
};

/** Local default refs only, sharing merge detection's candidates. Never fetch. */
export async function hasNoCommitsBeyondDefault(
	directory: string,
	head: string,
	runner: SubprocessRunner = makeSubprocessRunner(),
): Promise<boolean> {
	for (const ref of await defaultRefs(
		directory,
		runner,
		readGitFiles(directory)?.common,
	))
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
		let branch =
			branchHead && branchHead !== "(detached)" ? branchHead : undefined;
		// --short HEAD fails on a branch with no commits yet.
		const born = oid !== undefined && oid !== "(initial)";
		const files = readGitFiles(directory);
		const fast =
			files && files.branch === branch && files.oid === (born ? oid : undefined)
				? files
				: undefined;
		let gitDir: string;
		let common: string;
		let head: string | undefined;
		if (fast) {
			({ gitDir, common, branch } = fast);
			head =
				born && fast.oid
					? await shortHead(directory, gitDir, common, fast.oid, runner)
					: undefined;
			if (born && !head) return undefined;
		} else {
			const dirs = await git(
				directory,
				runner,
				"rev-parse",
				"--absolute-git-dir",
				"--git-common-dir",
				...(born ? ["--short", "HEAD"] : []),
			);
			if (!dirs) return undefined;
			const [local, shared, short] = dirs.split("\n");
			if (!local || !shared) return undefined;
			gitDir = local;
			common = isAbsolute(shared)
				? resolve(shared)
				: resolve(directory, shared);
			head = short;
		}
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
		const defaultBranches = await defaultRefs(directory, runner, fast?.common);
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
		const repository =
			fast &&
			!existsSync(join(common, "refs/replace")) &&
			!process.env["GIT_REPLACE_REF_BASE"] &&
			!process.env["GIT_NO_REPLACE_OBJECTS"]
				? repositoryRefs.get(common)
				: undefined;
		const mergeKey = JSON.stringify([
			branch,
			tip,
			...[...defaultBranches, `refs/heads/${branch}`].map((ref) =>
				fileStamp(join(common, "logs", ref)),
			),
		]);
		const cachedMerge = repository?.merges.get(gitDir);
		if (
			cachedMerge?.key === mergeKey &&
			(cachedMerge.previousAt === undefined ||
				(previous?.mergedHead === tip &&
					previous.mergedAt === cachedMerge.previousAt))
		)
			return {
				...result,
				...cachedMerge.value,
				...(cachedMerge.value.merged &&
				previous?.mergedHead === tip &&
				previous.mergedAt !== undefined
					? { mergedAt: previous.mergedAt }
					: {}),
			};
		let complete = true;
		const mergeRunner: SubprocessRunner = async (
			command,
			args,
			options,
			signal,
		) => {
			try {
				const result = await runner(command, args, options, signal);
				if (
					result.exitCode !== 0 &&
					!(
						result.exitCode === 1 &&
						args[0] === "merge-base" &&
						args[1] === "--is-ancestor"
					)
				)
					complete = false;
				return result;
			} catch (error) {
				complete = false;
				throw error;
			}
		};
		const withMerge = (
			value: Pick<SessionGit, "merged" | "mergedHead" | "mergedAt">,
			previousAt?: number,
		): SessionGit => {
			if (complete)
				repository?.merges.set(gitDir, {
					key: mergeKey,
					value,
					...(previousAt !== undefined ? { previousAt } : {}),
				});
			return { ...result, ...value };
		};
		const containingDefaults: string[] = [];
		for (const ref of defaultBranches) {
			const ancestor = await git(
				directory,
				mergeRunner,
				"merge-base",
				"--is-ancestor",
				tip,
				ref,
			);
			if (ancestor !== undefined) containingDefaults.push(ref);
		}
		if (containingDefaults.length === 0) return withMerge({ merged: false });
		// A merged tip that has not moved stays merged; skip re-deriving it every poll.
		if (
			previous?.merged &&
			previous.mergedHead === tip &&
			previous.mergedAt !== undefined
		)
			return withMerge(
				{
					merged: true,
					mergedHead: tip,
					mergedAt: previous.mergedAt,
				},
				previous.mergedAt,
			);
		const reflog = await git(
			directory,
			mergeRunner,
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
					mergeRunner,
					"rev-parse",
					"--verify",
					"-q",
					`${ref}@{${createdAt}}`,
				);
				const base = previousDefault
					? await git(
							directory,
							mergeRunner,
							"merge-base",
							tip,
							previousDefault,
						)
					: undefined;
				merged = base !== undefined && base !== tip;
				if (merged) break;
			}
		}
		if (!merged) return withMerge({ merged });
		let mergedAt = previous?.mergedHead === tip ? previous.mergedAt : undefined;
		if (mergedAt === undefined) {
			for (const ref of containingDefaults) {
				const ancestry = await git(
					directory,
					mergeRunner,
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
						mergeRunner,
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
						mergeRunner,
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
		return withMerge(
			{
				merged,
				mergedHead: tip,
				...(mergedAt !== undefined ? { mergedAt } : {}),
			},
			previous?.mergedHead === tip ? previous.mergedAt : undefined,
		);
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
