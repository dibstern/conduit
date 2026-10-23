import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SessionGit } from "../../../../shared-types.js";
import {
	makeSubprocessRunner,
	type SubprocessRunner,
} from "../../Services/subprocess.js";

const GIT_COMMAND_TIMEOUT_MS = 2_000;
const DEFAULT_REFS = [
	"refs/remotes/origin/HEAD",
	"refs/heads/main",
	"refs/heads/master",
];

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

const readOptional = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8").trim();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
};

const fileStamp = (path: string): string => {
	const file = statSync(path, { throwIfNoEntry: false });
	return file
		? `${file.mtimeMs}:${file.ctimeMs}:${file.size}:${file.ino}`
		: "missing";
};

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
		return isOid(value) ? value : null;
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
			const entry = lstatSync(path, { throwIfNoEntry: false });
			if (entry) {
				if (entry.isDirectory()) gitDir = path;
				else if (entry.isFile()) {
					const target = readOptional(path)?.match(/^gitdir: ([^\r\n]+)$/)?.[1];
					if (!target) return undefined;
					gitDir = resolve(root, target);
				} else return undefined;
				break;
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
		if (oid === null) return undefined;
		return { gitDir, common, oid, branch: ref.slice(11) };
	} catch {
		return undefined;
	}
};

export const makeSessionGitReader = () => {
	const repositoryRefs = new Map<
		string,
		{
			refs: string[];
			files: Map<string, string>;
			unmerged: Map<string, string>;
		}
	>();

	/** Watchers and owner finalizers accept either a checkout or git directory. */
	function invalidateSessionGitRepository(directory: string): void {
		const common = readGitFiles(directory)?.common;
		if (common) repositoryRefs.delete(common);
		try {
			repositoryRefs.delete(realpathSync(directory));
		} catch {
			repositoryRefs.delete(resolve(directory));
		}
		// A removed project can no longer resolve its conventional git directory.
		repositoryRefs.delete(join(resolve(directory), ".git"));
	}

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
		let files: Map<string, string> | undefined;
		if (common) {
			try {
				const paths = new Set<string>();
				if (DEFAULT_REFS.every((ref) => readRef(common, ref, paths) !== null))
					files = new Map([...paths].map((path) => [path, fileStamp(path)]));
			} catch {
				// Unusual refs still use git, without caching an incomplete dependency set.
			}
		}
		const refs = await git(
			directory,
			runner,
			"for-each-ref",
			"--format=%(refname) %(symref) %(objecttype)",
			...DEFAULT_REFS,
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
		if (common && files && refs !== undefined && unchanged(files))
			repositoryRefs.set(common, { refs: result, files, unmerged: new Map() });
		return result;
	};

	async function readSessionGit(
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
				lines
					.find((line) => line.startsWith(`# ${key} `))
					?.slice(key.length + 3);
			const oid = header("branch.oid");
			const branchHead = header("branch.head");
			const branch =
				branchHead && branchHead !== "(detached)" ? branchHead : undefined;
			// --short HEAD fails on a branch with no commits yet.
			const born = oid !== undefined && oid !== "(initial)";
			const files = readGitFiles(directory);
			const fast =
				files &&
				files.branch === branch &&
				files.oid === (born ? oid : undefined)
					? files
					: undefined;
			const dirs = fast
				? [fast.gitDir, fast.common, fast.oid?.slice(0, 7)]
				: (
						await git(
							directory,
							runner,
							"rev-parse",
							"--absolute-git-dir",
							"--git-common-dir",
							...(born ? ["--short", "HEAD"] : []),
						)
					)?.split("\n");
			if (!dirs) return undefined;
			const [gitDir, commonDir, head] = dirs;
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
			const defaultBranches = await defaultRefs(
				directory,
				runner,
				fast?.common,
			);
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
			const defaultOids = fast
				? defaultBranches.map((ref) => readRef(common, ref))
				: [];
			const unmerged =
				fast && defaultOids.every((oid) => oid != null)
					? repositoryRefs.get(common)?.unmerged
					: undefined;
			const key = [tip, ...defaultOids].join(":");
			if (unmerged?.get(gitDir) === key) return { ...result, merged: false };
			const containingDefaults: string[] = [];
			for (const ref of defaultBranches) {
				const ancestor = await execGit(directory, runner, [
					"merge-base",
					"--is-ancestor",
					tip,
					ref,
				]).catch((error: { code?: number }) => {
					if (error.code !== 1) throw error;
					return undefined;
				});
				if (ancestor !== undefined) containingDefaults.push(ref);
			}
			if (containingDefaults.length === 0) {
				unmerged?.set(gitDir, key);
				return { ...result, merged: false };
			}
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
			if (!merged) {
				unmerged?.set(gitDir, key);
				return { ...result, merged };
			}
			let mergedAt =
				previous?.mergedHead === tip ? previous.mergedAt : undefined;
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

	return { read: readSessionGit, invalidate: invalidateSessionGitRepository };
};

const defaultReader = makeSessionGitReader();
export const readSessionGit = defaultReader.read;
export const invalidateSessionGitRepository = defaultReader.invalidate;
