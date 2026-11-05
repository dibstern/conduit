import { createHash, randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	readdir,
	rm,
	rmdir,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	Clock,
	Deferred,
	Effect,
	Exit,
	Option,
	Result,
	Schema,
	Semaphore,
} from "effect";
import type { RunChangesCaptured } from "../../../contracts/stored-event.js";
import * as Failure from "../../../effect/failure-classification.js";
import {
	FolderRestoreRefused,
	type FolderSnapshot,
	type FolderTimeline,
	FolderTimelineError,
} from "../Services/folder-timeline.js";
import { Subprocess, SubprocessPriority } from "../Services/subprocess.js";

/** Diff git work has its own deadline, above session git's 2s reads. */
const GIT_TIMEOUT_MS = 10_000;
const COLLECT_INTERVAL_MS = 5 * 60_000;
const GRACE_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** A start checkpoint delays the run, so it gets less than a full git deadline. */
const START_BUDGET_MS = 3_000;
/** A run that changes more paths than this records a gap instead. */
const MAX_CHANGES = 5_000;
const SESSION_REF = "refs/conduit/session";
const PINS = "refs/conduit/runs/";
/** A session's kept refs in a repository store: its checkpoints, then its receipts. */
const KEPT = "refs/conduit/sessions/";
const IDENTITY = {
	GIT_AUTHOR_NAME: "conduit",
	GIT_AUTHOR_EMAIL: "conduit@localhost",
	GIT_COMMITTER_NAME: "conduit",
	GIT_COMMITTER_EMAIL: "conduit@localhost",
};

/**
 * A pin is a commit whose subject names what a restart needs to capture its
 * run. Its tree is the folder's start tree, then its end tree once `end` is set.
 */
const Pin = Schema.Struct({
	sessionId: Schema.String,
	directories: Schema.Array(Schema.String),
	prefix: Schema.String,
	end: Schema.optionalKey(
		Schema.Struct({ start: Schema.String, shared: Schema.Boolean }),
	),
});
const decodePin = Schema.decodeUnknownOption(Schema.fromJsonString(Pin));
/** A Restore Receipt's subject: the move that restored the folder. */
const Receipt = Schema.Struct({
	sessionId: Schema.String,
	moveId: Schema.String,
	directory: Schema.String,
});
const decodeReceipt = Schema.decodeUnknownOption(
	Schema.fromJsonString(Receipt),
);

// Copied indexes must never split, monitor or trigger maintenance, and LFS
// filters would read or write the repository's .git/lfs.
const CONFIG = [
	"-c",
	"core.splitIndex=false",
	"-c",
	"splitIndex.sharedIndexExpire=never",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
	"-c",
	"filter.lfs.process=",
	"-c",
	"filter.lfs.clean=",
	"-c",
	"filter.lfs.smudge=",
	"-c",
	"filter.lfs.required=false",
];

export const baseEnv = () => {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	for (const key of [
		"GIT_DIR",
		"GIT_INDEX_FILE",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	])
		delete env[key];
	return env;
};

/**
 * Copies an index for git to work on. Racy-git: an mtime floored to the second
 * re-hashes same-second edits. A repository with no index yet rejects, and
 * leaves no copy, which git reads as empty.
 */
export const copyIndex = async (indexFile: string, copy: string) => {
	const { mtimeMs } = await stat(indexFile);
	await copyFile(indexFile, copy);
	const seconds = Math.floor(mtimeMs / 1000);
	await utimes(copy, seconds, seconds);
};

const fs = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new FolderTimelineError({ reason: "failed", message: String(cause) }),
	});

/** Bytes of the files under `path`; 0 when it is gone. */
const bytesUnder = async (path: string) => {
	const entries = await readdir(path, {
		recursive: true,
		withFileTypes: true,
	}).catch(() => []);
	const sizes = await Promise.all(
		entries
			.filter((entry) => entry.isFile())
			.map((entry) =>
				stat(join(entry.parentPath, entry.name)).then(
					({ size }) => size,
					() => 0,
				),
			),
	);
	return sizes.reduce((total, size) => total + size, 0);
};

interface Repository {
	readonly indexFile: string;
	readonly store: string;
	readonly prefix: string;
}

type Gap = Extract<
	RunChangesCaptured["folders"][number],
	{ readonly gap: unknown }
>;
type Change = Extract<
	RunChangesCaptured["folders"][number],
	{ readonly changes: unknown }
>["changes"][number];

/** A run between its start and end checkpoints. */
interface LiveRun {
	readonly sessionId: string;
	readonly directories: readonly string[];
	readonly starts: Map<string, FolderSnapshot | Omit<Gap, "directory">>;
	/** Folders another session ran in while this run was live. */
	readonly shared: Set<string>;
	readonly done: Deferred.Deferred<void>;
	/** Set at the run's end; its capture may still be recording. */
	ended: boolean;
}

const gapOf = (error: FolderTimelineError) => ({
	gap: error.reason,
	message: error.message,
});

/**
 * `diff-tree -z --raw --numstat --no-renames`: status records with their paths,
 * then each path's line counts ("-" for a binary file, which gets none).
 */
function parseRaw(output: string): Change[] {
	const tokens = output.split("\0");
	const changes: Change[] = [];
	let at = 0;
	for (; tokens[at]?.startsWith(":"); at += 2) {
		const [beforeMode = "", afterMode = "", before = "", after = ""] =
			tokens[at]?.slice(1).split(" ") ?? [];
		const side = (mode: string, blob: string) =>
			/^0+$/.test(mode) ? null : { mode, blob };
		changes.push({
			path: tokens[at + 1] ?? "",
			before: side(beforeMode, before),
			after: side(afterMode, after),
		});
	}
	const counts = new Map(
		tokens.slice(at).flatMap((token) => {
			const match = /^(\d+)\t(\d+)\t(.*)$/s.exec(token);
			return match
				? [
						[
							match[3],
							{ insertions: Number(match[1]), deletions: Number(match[2]) },
						] as const,
					]
				: [];
		}),
	);
	return changes.map((change) => ({ ...change, ...counts.get(change.path) }));
}

type Git = (
	store: string,
	args: readonly string[],
	options?: {
		readonly input?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly maxBuffer?: number;
	},
) => Effect.Effect<{ readonly stdout: string }, FolderTimelineError>;
type Snapshot = (
	directory: string,
) => Effect.Effect<FolderSnapshot, FolderTimelineError>;
type End = readonly [
	directory: string,
	end: Result.Result<FolderSnapshot, FolderTimelineError>,
];

/** Moves the folder's pin to a commit of `tree` that says what it holds. */
const pin = (
	git: Git,
	store: string,
	ref: string,
	tree: string,
	content: typeof Pin.Type,
	parent: readonly string[] = [],
) =>
	git(store, ["commit-tree", tree, ...parent, "-m", JSON.stringify(content)], {
		env: IDENTITY,
	}).pipe(
		Effect.flatMap(({ stdout }) =>
			git(store, ["update-ref", ref, stdout.trim()]),
		),
	);

/** A test holds a restore at `step`, so a test can stop the daemon there. */
const pause = (step: "receipt" | "deleted" | "written") =>
	Effect.suspend(() =>
		process.env["NODE_ENV"] === "test" &&
		process.env["CONDUIT_TEST_RESTORE_PAUSE_AT"] === step
			? Effect.never
			: Effect.void,
	);

/** Whether the folder is still there to restore. */
const present = (directory: string) =>
	Effect.promise(() =>
		stat(directory).then(
			(found) => found.isDirectory(),
			() => false,
		),
	);

/** Deletes folder-relative files, then the folders they leave empty. */
const remove = (directory: string, paths: readonly string[]) =>
	fs(async () => {
		for (const path of paths) {
			await rm(join(directory, path), { force: true });
			for (
				let parent = dirname(join(directory, path));
				parent.startsWith(`${directory}/`);
				parent = dirname(parent)
			)
				if (
					!(await rmdir(parent).then(
						() => true,
						() => false,
					))
				)
					break;
		}
	});

/** Marks the folders a new run shares with live runs of other sessions, on both sides. */
function markShared(runs: Iterable<LiveRun>, live: LiveRun) {
	for (const other of runs)
		if (!other.ended && other.sessionId !== live.sessionId)
			for (const directory of live.directories)
				if (other.directories.includes(directory)) {
					other.shared.add(directory);
					live.shared.add(directory);
				}
}

/** A tree of only the changed paths, as they were on one side of the run. */
const sparseTree = (
	git: Git,
	store: string,
	changes: readonly Change[],
	side: "before" | "after",
) =>
	Effect.gen(function* () {
		const index = join(store, `sparse-${randomUUID()}.index`);
		const env = { GIT_INDEX_FILE: index };
		return yield* Effect.gen(function* () {
			yield* git(store, ["update-index", "-z", "--index-info"], {
				env,
				input: changes
					.flatMap((change) => {
						const entry = change[side];
						return entry
							? [`${entry.mode} ${entry.blob}\t${change.path}\0`]
							: [];
					})
					.join(""),
			});
			return (yield* git(store, ["write-tree"], { env })).stdout.trim();
		}).pipe(Effect.ensuring(Effect.promise(() => rm(index, { force: true }))));
	});

const captureFolder = (
	git: Git,
	live: LiveRun,
	store: string,
	directory: string,
	end: Result.Result<FolderSnapshot, FolderTimelineError>,
) =>
	Effect.gen(function* (): Effect.fn.Return<
		RunChangesCaptured["folders"][number],
		FolderTimelineError
	> {
		const start = live.starts.get(directory) ?? {
			gap: "failed" as const,
			message: "The run had no start checkpoint",
		};
		if (!("store" in start)) return { directory, ...start };
		const { worktree } = yield* Effect.fromResult(end);
		const { stdout } = yield* git(start.store, [
			"diff-tree",
			"-r",
			"-z",
			"--raw",
			"--numstat",
			"--no-renames",
			...(start.prefix === "" ? [] : [`--relative=${start.prefix}`]),
			start.worktree,
			worktree,
		]);
		const changes = parseRaw(stdout);
		if (changes.length > MAX_CHANGES)
			return {
				directory,
				gap: "failed",
				message: `The run changed ${changes.length} files, more than ${MAX_CHANGES}`,
			};
		return {
			directory,
			before: yield* sparseTree(git, store, changes, "before"),
			after: yield* sparseTree(git, store, changes, "after"),
			shared: live.shared.has(directory),
			changes,
		};
	}).pipe(
		Effect.catch((error) => Effect.succeed({ directory, ...gapOf(error) })),
	);

/** Chains the capture under the session's ref and copies its objects into the store. */
const commitCapture = (git: Git, store: string, capture: RunChangesCaptured) =>
	Effect.gen(function* () {
		const trees = capture.folders.flatMap((folder, index) =>
			"changes" in folder
				? [
						`040000 tree ${folder.before}\t${index}-before`,
						`040000 tree ${folder.after}\t${index}-after`,
					]
				: [],
		);
		if (trees.length === 0) return;
		const root = (yield* git(store, ["mktree"], {
			input: `${trees.join("\n")}\n`,
		})).stdout.trim();
		const previous = yield* git(store, [
			"rev-parse",
			"--verify",
			"--quiet",
			SESSION_REF,
		]).pipe(
			Effect.map(({ stdout }) => stdout.trim()),
			Effect.orElseSucceed(() => ""),
		);
		const parent = previous === "" ? [] : ["-p", previous];
		const commit = (yield* git(
			store,
			["commit-tree", root, ...parent, "-m", capture.runId],
			{ env: IDENTITY },
		)).stdout.trim();
		// Without --local, objects borrowed through alternates are copied in.
		yield* git(
			store,
			["pack-objects", "--revs", "-q", join(store, "objects", "pack", "pack")],
			{ input: `${commit}\n${previous === "" ? "" : `^${previous}\n`}` },
		);
		yield* git(store, ["update-ref", SESSION_REF, commit, ...parent.slice(1)]);
	});

/** Creates the session's store, borrowing from every store its run's folders use. */
const openSessionStore = (
	run: Git,
	root: string,
	store: string,
	live: LiveRun,
) =>
	Effect.gen(function* () {
		const borrowed = [
			...new Set(
				[...live.starts.values()].flatMap((start) =>
					"store" in start ? [join(start.store, "objects")] : [],
				),
			),
		];
		const exists = yield* fs(() => stat(store)).pipe(
			Effect.as(true),
			Effect.orElseSucceed(() => false),
		);
		if (!exists) {
			yield* fs(() => mkdir(join(root, "sessions"), { recursive: true }));
			yield* run(root, ["init", "--bare", "--quiet", "--template=", store]);
		}
		// Captures are self-contained, so only this run needs borrowing.
		yield* fs(() =>
			writeFile(
				join(store, "objects", "info", "alternates"),
				borrowed.map((path) => `${path}\n`).join(""),
			),
		);
		return store;
	});

/** Pins a folder's start tree for the run, or records the gap that stopped it. */
const checkpointStart = (
	{ git, snapshot }: { readonly git: Git; readonly snapshot: Snapshot },
	runId: string,
	live: LiveRun,
	directory: string,
	index: number,
) =>
	Effect.gen(function* () {
		const start = yield* snapshot(directory);
		// The pin keeps the start tree's objects past the grace period. Folders
		// sharing a store each need their own.
		yield* pin(git, start.store, `${PINS}${runId}/${index}`, start.worktree, {
			sessionId: live.sessionId,
			directories: live.directories,
			prefix: start.prefix,
		});
		live.starts.set(directory, start);
	}).pipe(
		Effect.timeoutOrElse({
			duration: START_BUDGET_MS,
			orElse: () =>
				Effect.fail(
					new FolderTimelineError({
						reason: "timeout",
						message: `The start checkpoint took over ${START_BUDGET_MS}ms`,
					}),
				),
		}),
		Effect.catch((error) =>
			Effect.sync(() => live.starts.set(directory, gapOf(error))),
		),
	);

export const makeFolderTimeline = (configDir: string) =>
	Effect.gen(function* () {
		const subprocess = yield* Subprocess;
		const scope = yield* Effect.scope;
		const root = join(configDir, "folder-timeline");
		const repositories = new Map<string, Repository>();
		const inFlight = new Map<
			string,
			Deferred.Deferred<FolderSnapshot, FolderTimelineError>
		>();
		// Stores keep a sweep entry until a sweep runs a full grace after their last snapshot.
		const touched = new Map<string, number>();
		// Worktrees of one repository share its store, so one creates it at a time.
		const creating = yield* Semaphore.make(1);
		let swept = false;
		const runs = new Map<string, LiveRun>();
		const lockIn =
			(locks: Map<string, Semaphore.Semaphore>) => (key: string) => {
				const known = locks.get(key);
				if (known) return known;
				const lock = Semaphore.makeUnsafe(1);
				locks.set(key, lock);
				return lock;
			};
		// A session's captures and its forgetting write one store, one at a time.
		const sessionLocks = new Map<string, Semaphore.Semaphore>();
		const sessionLock = lockIn(sessionLocks);
		// A restore applies while no run takes a start checkpoint in its folders.
		const folderLock = lockIn(new Map());
		const hash = (text: string) =>
			createHash("sha256").update(text).digest("hex").slice(0, 16);
		const sessionStore = (sessionId: string) =>
			join(root, "sessions", `${hash(sessionId)}.git`);
		const checkpointRef = (
			sessionId: string,
			runId: string,
			directory: string,
		) => `${KEPT}${hash(sessionId)}/checkpoints/${runId}/${hash(directory)}`;
		const receiptRef = (sessionId: string, moveId: string, directory: string) =>
			`${KEPT}${hash(sessionId)}/receipts/${moveId}/${hash(directory)}`;

		const run = (
			cwd: string,
			args: readonly string[],
			{
				env,
				maxBuffer = MAX_OUTPUT_BYTES,
				...rest
			}: {
				readonly env?: NodeJS.ProcessEnv;
				readonly input?: string;
				readonly maxBuffer?: number;
				readonly onStdout?: (chunk: Buffer) => void;
			} = {},
		) =>
			subprocess
				.run("git", ["--no-optional-locks", ...CONFIG, ...args], {
					cwd,
					env: { ...baseEnv(), ...env },
					timeoutMs: GIT_TIMEOUT_MS,
					maxBuffer,
					...rest,
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new FolderTimelineError({
								reason: error.reason === "timeout" ? "timeout" : "failed",
								message: error.message,
							}),
					),
					Effect.flatMap((result) =>
						result.exitCode === 0
							? Effect.succeed(result)
							: Effect.fail(
									new FolderTimelineError({
										reason: "failed",
										message: result.stderr.trim() || `git ${args[0]} failed`,
									}),
								),
					),
				);

		const resolve = Effect.fnUntraced(function* (directory: string) {
			const known = repositories.get(directory);
			if (known) return known;
			const { stdout } = yield* run(directory, [
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"index",
				"--git-common-dir",
				"--show-prefix",
			]);
			const [indexFile = "", commonDir = "", prefix = ""] = stdout.split("\n");
			const key = createHash("sha256").update(commonDir).digest("hex");
			const store = join(root, `${key.slice(0, 16)}.git`);
			// The store is named for its repository, so alternates never change once written.
			const alternates = join(store, "objects", "info", "alternates");
			yield* Effect.gen(function* () {
				const exists = yield* fs(() => stat(alternates)).pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false),
				);
				if (exists) return;
				yield* fs(() => mkdir(root, { recursive: true }));
				yield* run(root, ["init", "--bare", "--quiet", "--template=", store]);
				yield* fs(() =>
					writeFile(alternates, `${join(commonDir, "objects")}\n`),
				);
			}).pipe(creating.withPermits(1));
			const repository = { indexFile, store, prefix };
			repositories.set(directory, repository);
			return repository;
		});

		const take = (directory: string, pathspecs: readonly string[] = ["."]) =>
			Effect.gen(function* () {
				const repository = yield* resolve(directory);
				const temp = join(repository.store, `snapshot-${randomUUID()}.index`);
				const env = {
					GIT_INDEX_FILE: temp,
					GIT_OBJECT_DIRECTORY: join(repository.store, "objects"),
				};
				return yield* Effect.gen(function* () {
					yield* fs(() => copyIndex(repository.indexFile, temp)).pipe(
						Effect.ignore,
					);
					const index = (yield* run(directory, ["write-tree"], {
						env,
					})).stdout.trim();
					yield* run(directory, ["add", "--all", "--", ...pathspecs], { env });
					const worktree = (yield* run(directory, ["write-tree"], {
						env,
					})).stdout.trim();
					touched.set(repository.store, yield* Clock.currentTimeMillis);
					return {
						store: repository.store,
						prefix: repository.prefix,
						index,
						worktree,
					};
				}).pipe(
					Effect.ensuring(Effect.promise(() => rm(temp, { force: true }))),
				);
			}).pipe(
				Effect.tapError(() =>
					Effect.sync(() => repositories.delete(directory)),
				),
			);

		const collect = (graceMs: number) =>
			Effect.gen(function* () {
				if (!swept) {
					swept = true;
					// Stores left by earlier runs are swept once.
					const names = yield* fs(() => readdir(root)).pipe(
						Effect.orElseSucceed((): string[] => []),
					);
					for (const name of names)
						if (name.endsWith(".git") && !touched.has(join(root, name)))
							touched.set(join(root, name), 0);
				}
				const now = yield* Clock.currentTimeMillis;
				const expire =
					graceMs === 0 ? "now" : `${Math.ceil(graceMs / 1000)}.seconds.ago`;
				for (const [store, at] of [...touched]) {
					// A pin outlives its run only when the daemon lost the run's end.
					const { stdout } = yield* run(store, [
						"--git-dir",
						store,
						"for-each-ref",
						"--format=%(refname)",
						PINS,
					]).pipe(Effect.orElseSucceed(() => ({ stdout: "" })));
					const orphans = stdout
						.split("\n")
						.filter(
							(ref) =>
								ref !== "" &&
								!runs.has(ref.slice(PINS.length, ref.lastIndexOf("/"))),
						);
					if (orphans.length > 0)
						yield* run(store, ["--git-dir", store, "update-ref", "--stdin"], {
							input: orphans.map((ref) => `delete ${ref}\n`).join(""),
						}).pipe(Effect.ignore);
					yield* run(store, [
						"--git-dir",
						store,
						"prune",
						`--expire=${expire}`,
					]).pipe(Effect.ignore);
					if (now - at >= graceMs) touched.delete(store);
				}
			});

		yield* Effect.sleep(COLLECT_INTERVAL_MS).pipe(
			Effect.andThen(collect(GRACE_MS)),
			Effect.forever,
			Effect.provideService(SubprocessPriority, "background"),
			Effect.forkScoped,
		);

		const snapshot = (directory: string, paths?: readonly string[]) =>
			Effect.gen(function* () {
				if (paths)
					return yield* take(
						directory,
						paths.map((path) => `:(literal)${path}`),
					);
				const running = inFlight.get(directory);
				if (running) return yield* Deferred.await(running);
				const deferred = yield* Deferred.make<
					FolderSnapshot,
					FolderTimelineError
				>();
				inFlight.set(directory, deferred);
				yield* take(directory).pipe(
					Effect.onExit((exit) =>
						Effect.sync(() => inFlight.delete(directory)).pipe(
							Effect.andThen(Deferred.done(deferred, exit)),
						),
					),
					Effect.forkIn(scope),
				);
				return yield* Deferred.await(deferred);
			});
		const git = (
			store: string,
			args: readonly string[],
			options: {
				readonly input?: string;
				readonly env?: NodeJS.ProcessEnv;
				readonly maxBuffer?: number;
				readonly onStdout?: (chunk: Buffer) => void;
			} = {},
		) => run(store, ["--git-dir", store, ...args], options);

		/** Deletes the session's kept refs in every repository store. */
		const dropKept = (sessionId: string) =>
			Effect.gen(function* () {
				const names = yield* fs(() => readdir(root)).pipe(
					Effect.orElseSucceed((): string[] => []),
				);
				for (const name of names.filter((name) => name.endsWith(".git"))) {
					const store = join(root, name);
					const { stdout } = yield* git(store, [
						"for-each-ref",
						"--format=%(refname)",
						`${KEPT}${hash(sessionId)}/`,
					]).pipe(Effect.orElseSucceed(() => ({ stdout: "" })));
					const refs = stdout.split("\n").filter((ref) => ref !== "");
					if (refs.length > 0)
						yield* git(store, ["update-ref", "--stdin"], {
							input: refs.map((ref) => `delete ${ref}\n`).join(""),
						}).pipe(Effect.ignore);
				}
			});
		/** A kept ref's tree and its parent's tree, or nothing once it is gone. */
		const readKept = (store: string, ref: string) =>
			git(store, ["rev-parse", `${ref}^{tree}`, `${ref}^1^{tree}`]).pipe(
				Effect.map(({ stdout }) => {
					const [tree, parent] = stdout.trim().split("\n");
					return tree && parent ? { tree, parent } : undefined;
				}),
				Effect.orElseSucceed(() => undefined),
			);
		/** Keeps `tree` under `ref`, its parent a commit of `parent`. */
		const keep = (
			store: string,
			ref: string,
			tree: string,
			parent: string,
			subject: string,
		) =>
			Effect.gen(function* () {
				const base = (yield* git(
					store,
					["commit-tree", parent, "-m", "target"],
					{
						env: IDENTITY,
					},
				)).stdout.trim();
				const commit = (yield* git(
					store,
					["commit-tree", tree, "-p", base, "-m", subject],
					{ env: IDENTITY },
				)).stdout.trim();
				yield* git(store, ["update-ref", ref, commit]);
			});
		/** The folder's paths (folder-relative) that differ between two trees; submodules excepted. */
		const diff = (store: string, prefix: string, from: string, to: string) =>
			git(store, [
				"diff-tree",
				"-r",
				"-z",
				"--raw",
				"--no-renames",
				...(prefix === "" ? [] : [`--relative=${prefix}`]),
				from,
				to,
			]).pipe(
				Effect.map(({ stdout }) =>
					parseRaw(stdout).filter(
						({ before, after }) =>
							before?.mode !== "160000" && after?.mode !== "160000",
					),
				),
			);
		/**
		 * A fresh snapshot against a move from `from` to `to`: the planned paths
		 * still as planned are written, those already at `to` are skipped, and any
		 * other planned path changed since the plan.
		 */
		const classify = (directory: string, from: string, to: string) =>
			Effect.gen(function* () {
				const now = yield* take(directory);
				const [planned, pending, moved] = yield* Effect.all(
					[
						diff(now.store, now.prefix, from, to),
						diff(now.store, now.prefix, now.worktree, to),
						diff(now.store, now.prefix, now.worktree, from),
					],
					{ concurrency: "unbounded" },
				);
				const plannedPaths = new Set(planned.map(({ path }) => path));
				const movedPaths = new Set(moved.map(({ path }) => path));
				const changes = pending.filter(({ path }) => plannedPaths.has(path));
				return {
					now,
					writes: changes.filter(({ path }) => !movedPaths.has(path)),
					conflicts: changes
						.filter(({ path }) => movedPaths.has(path))
						.map(({ path }) => path),
				};
			});
		/** Writes folder-relative paths as `tree` holds them, through an index of its own. */
		const checkout = (
			directory: string,
			store: string,
			tree: string,
			paths: readonly string[],
		) =>
			paths.length === 0
				? Effect.void
				: Effect.suspend(() => {
						const index = join(store, `restore-${randomUUID()}.index`);
						const env = {
							GIT_INDEX_FILE: index,
							GIT_OBJECT_DIRECTORY: join(store, "objects"),
						};
						return run(directory, ["read-tree", tree], { env }).pipe(
							Effect.andThen(
								run(directory, ["checkout-index", "-f", "-z", "--stdin"], {
									env,
									input: paths.map((path) => `${path}\0`).join(""),
								}),
							),
							Effect.ensuring(Effect.promise(() => rm(index, { force: true }))),
						);
					});
		const deletes = (writes: readonly Change[]) =>
			writes.filter(({ after }) => after === null).map(({ path }) => path);
		const updates = (writes: readonly Change[]) =>
			writes.filter(({ after }) => after !== null).map(({ path }) => path);
		/** Moves the folder's paths still at `from` to `to`, leaving any other change be. */
		const putBack = (directory: string, from: string, to: string) =>
			Effect.gen(function* () {
				if (!(yield* present(directory))) return;
				const { now, writes } = yield* classify(directory, from, to);
				yield* remove(directory, deletes(writes));
				yield* checkout(directory, now.store, to, updates(writes));
			});
		const unpin = (runId: string, live: LiveRun) =>
			Effect.forEach(live.directories, (directory, index) => {
				const start = live.starts.get(directory);
				return start && "store" in start
					? git(start.store, [
							"update-ref",
							"-d",
							`${PINS}${runId}/${index}`,
						]).pipe(Effect.ignore)
					: Effect.void;
			});
		const drop = (runId: string) =>
			Effect.gen(function* () {
				const live = runs.get(runId);
				if (!live) return;
				yield* unpin(runId, live);
				runs.delete(runId);
				yield* Deferred.succeed(live.done, undefined);
			});

		/** Copies the run's changes into its session's store and records them. */
		const capture = <E>(
			runId: string,
			live: LiveRun,
			ends: readonly End[],
			record: (
				sessionId: string,
				capture: RunChangesCaptured,
			) => Effect.Effect<void, E>,
		) =>
			sessionLock(live.sessionId).withPermits(1)(
				Effect.gen(function* () {
					// Forgotten while its end checkpoint was taken.
					if (!runs.has(runId)) return;
					const capture = yield* Effect.gen(function* () {
						const store = yield* openSessionStore(
							run,
							root,
							sessionStore(live.sessionId),
							live,
						);
						const capture = {
							runId,
							folders: yield* Effect.forEach(
								ends,
								([directory, end]) =>
									captureFolder(git, live, store, directory, end),
								{ concurrency: "unbounded" },
							),
						};
						yield* commitCapture(git, store, capture);
						return capture;
					}).pipe(
						// A capture the store cannot save still says why each folder is missing.
						Effect.catch((error) =>
							Effect.succeed({
								runId,
								folders: live.directories.map((directory) => ({
									directory,
									...gapOf(error),
									message: `Saving the capture failed: ${error.message}`,
								})),
							}),
						),
					);
					// The end pin (its parent the start pin) outlives the run as the
					// folder's checkpoint, for head moves with files.
					yield* Effect.forEach(
						live.directories,
						(directory, index) => {
							const start = live.starts.get(directory);
							return start && "store" in start
								? git(start.store, [
										"update-ref",
										checkpointRef(live.sessionId, runId, directory),
										`${PINS}${runId}/${index}`,
									]).pipe(Effect.ignore)
								: Effect.void;
						},
						{ concurrency: "unbounded", discard: true },
					);
					yield* record(live.sessionId, capture);
				}),
			);
		const finish =
			(runId: string) =>
			<E>(effect: Effect.Effect<void, E>) =>
				effect.pipe(
					// A shutdown keeps the run's pins, so the next start finishes its capture.
					Effect.onExit((exit) =>
						Exit.isFailure(exit) && Failure.isInterrupted(exit.cause)
							? Effect.void
							: drop(runId),
					),
					Effect.catchCause((cause) =>
						Effect.logWarning("Run capture failed", { runId, cause }),
					),
				);

		return {
			snapshot,
			git,
			folderGit: (directory: string, args: readonly string[]) =>
				run(directory, args),
			collect,
			sessionStore,
			runsIn: (directory) =>
				Effect.sync(() =>
					[...runs]
						.filter(([, live]) => live.directories.includes(directory))
						.map(([runId, { sessionId }]) => ({ sessionId, runId })),
				),
			checkpoint: (sessionId, runId, directory) =>
				Effect.gen(function* () {
					const { store, prefix } = yield* resolve(directory);
					// A pin without a parent is a start whose end was never pinned.
					const kept = yield* readKept(
						store,
						checkpointRef(sessionId, runId, directory),
					);
					return kept && { store, prefix, start: kept.parent, end: kept.tree };
				}),
			plan: (directory, to) =>
				Effect.gen(function* () {
					if (!(yield* present(directory)))
						return yield* new FolderRestoreRefused({
							reason: "folder_missing",
							directory,
							paths: [],
						});
					const now = yield* take(directory);
					const changes = yield* diff(now.store, now.prefix, now.worktree, to);
					return {
						from: now.worktree,
						key: createHash("sha256")
							.update(
								JSON.stringify(
									changes.map(({ path, before, after }) => [
										path,
										before,
										after,
									]),
								),
							)
							.digest("hex"),
						changes: changes.map(({ path, before, after }) => ({
							path,
							change:
								before === null
									? ("added" as const)
									: after === null
										? ("deleted" as const)
										: ("modified" as const),
						})),
					};
				}),
			restore: ({ sessionId, moveId, folders, guard, journal }) => {
				const apply = Effect.gen(function* () {
					yield* guard;
					// Every folder is checked before any is written.
					const checked = yield* Effect.forEach(folders, (folder) =>
						Effect.gen(function* () {
							const { directory, from, to } = folder;
							if (!(yield* present(directory)))
								return yield* new FolderRestoreRefused({
									reason: "folder_missing",
									directory,
									paths: [],
								});
							const { now, writes, conflicts } = yield* classify(
								directory,
								from,
								to,
							);
							if (conflicts.length > 0)
								return yield* new FolderRestoreRefused({
									reason: "changed",
									directory,
									paths: conflicts,
								});
							return {
								folder,
								now,
								writes,
								ref: receiptRef(sessionId, moveId, directory),
							};
						}),
					);
					const receipted: typeof checked = [];
					return yield* Effect.gen(function* () {
						for (const entry of checked) {
							yield* keep(
								entry.now.store,
								entry.ref,
								entry.now.worktree,
								entry.folder.to,
								JSON.stringify({
									sessionId,
									moveId,
									directory: entry.folder.directory,
								} satisfies typeof Receipt.Type),
							);
							receipted.push(entry);
						}
						yield* pause("receipt");
						for (const { folder, writes } of checked)
							yield* remove(folder.directory, deletes(writes));
						yield* pause("deleted");
						for (const { folder, now, writes } of checked)
							yield* checkout(
								folder.directory,
								now.store,
								folder.to,
								updates(writes),
							);
						yield* pause("written");
						return yield* journal;
					}).pipe(
						Effect.tapError(() =>
							Effect.forEach(
								receipted,
								({ folder, now, ref }) =>
									putBack(folder.directory, folder.to, now.worktree).pipe(
										Effect.andThen(git(now.store, ["update-ref", "-d", ref])),
										Effect.catch((error) =>
											Effect.logWarning("Restore not rolled back", {
												directory: folder.directory,
												error,
											}),
										),
									),
								{ discard: true },
							),
						),
					);
				});
				// Sorted, so two restores sharing folders take their locks in one order.
				return [...new Set(folders.map(({ directory }) => directory))]
					.sort()
					.reduceRight(
						(locked, directory) => folderLock(directory).withPermits(1)(locked),
						sessionLock(sessionId).withPermits(1)(apply),
					);
			},
			receipt: (sessionId, moveId, directory) =>
				Effect.gen(function* () {
					const { store } = yield* resolve(directory);
					const kept = yield* readKept(
						store,
						receiptRef(sessionId, moveId, directory),
					);
					return kept && { store, before: kept.tree, target: kept.parent };
				}),
			recoverRestores: (journalled) =>
				Effect.gen(function* () {
					const names = yield* fs(() => readdir(root)).pipe(
						Effect.orElseSucceed((): string[] => []),
					);
					for (const name of names.filter((name) => name.endsWith(".git"))) {
						const store = join(root, name);
						const { stdout } = yield* git(store, [
							"for-each-ref",
							"--format=%(refname)%00%(contents:subject)",
							KEPT,
						]).pipe(Effect.orElseSucceed(() => ({ stdout: "" })));
						for (const line of stdout.split("\n")) {
							const [ref = "", subject = ""] = line.split("\0");
							const receipt = ref.includes("/receipts/")
								? decodeReceipt(subject)
								: Option.none();
							if (Option.isNone(receipt)) continue;
							const { sessionId, moveId, directory } = receipt.value;
							// A journalled move was applied whole; its receipt stays for undo.
							if (yield* journalled(sessionId, moveId)) continue;
							const kept = yield* readKept(store, ref);
							yield* (
								kept ? putBack(directory, kept.parent, kept.tree) : Effect.void
							).pipe(
								Effect.andThen(git(store, ["update-ref", "-d", ref])),
								folderLock(directory).withPermits(1),
								Effect.catch((error) =>
									Effect.logWarning("Unjournalled restore not rolled back", {
										directory,
										error,
									}),
								),
							);
						}
					}
				}),
			runStarted: ({ sessionId, runId, directories }) =>
				Effect.gen(function* () {
					// A retried send keeps its first checkpoint.
					if (runs.has(runId)) return;
					const live: LiveRun = {
						sessionId,
						directories,
						starts: new Map(),
						shared: new Set(),
						done: yield* Deferred.make<void>(),
						ended: false,
					};
					markShared(runs.values(), live);
					runs.set(runId, live);
					yield* Effect.forEach(
						directories,
						(directory, index) =>
							folderLock(directory).withPermits(1)(
								checkpointStart(
									{ git, snapshot },
									runId,
									live,
									directory,
									index,
								),
							),
						{ concurrency: "unbounded", discard: true },
					);
				}),
			runJoined: drop,
			runEnded: (runId, record) =>
				Effect.gen(function* () {
					const live = runs.get(runId);
					if (!live) return;
					live.ended = true;
					// The end checkpoint is taken now; only writing the session's store waits.
					const ends = yield* Effect.forEach(
						live.directories,
						(directory) =>
							Effect.result(snapshot(directory)).pipe(
								Effect.map((end): End => [directory, end]),
							),
						{ concurrency: "unbounded" },
					);
					// Pinned beside its start, so a restart captures the folder as the run left it.
					yield* Effect.forEach(
						ends,
						([directory, end], index) => {
							const start = live.starts.get(directory);
							if (!start || !("store" in start) || Result.isFailure(end))
								return Effect.void;
							const ref = `${PINS}${runId}/${index}`;
							return pin(
								git,
								start.store,
								ref,
								end.success.worktree,
								{
									sessionId: live.sessionId,
									directories: live.directories,
									prefix: start.prefix,
									end: {
										start: start.worktree,
										shared: live.shared.has(directory),
									},
								},
								["-p", ref],
							).pipe(Effect.ignore);
						},
						{ concurrency: "unbounded", discard: true },
					);
					yield* capture(runId, live, ends, record);
				}).pipe(finish(runId)),
			recover: (owed, record) =>
				Effect.gen(function* () {
					const pinned = new Map<
						string,
						{ readonly live: LiveRun; readonly ends: Map<string, End[1]> }
					>();
					const names = yield* fs(() => readdir(root)).pipe(
						Effect.orElseSucceed((): string[] => []),
					);
					for (const name of names.filter((name) => name.endsWith(".git"))) {
						const store = join(root, name);
						const { stdout } = yield* git(store, [
							"for-each-ref",
							"--format=%(refname)%00%(tree)%00%(contents:subject)",
							PINS,
						]).pipe(Effect.orElseSucceed(() => ({ stdout: "" })));
						for (const line of stdout.split("\n")) {
							const [ref = "", tree = "", subject = ""] = line.split("\0");
							const slash = ref.lastIndexOf("/");
							const runId = ref.slice(PINS.length, slash);
							// The old code pinned bare trees; collect drops those.
							const decoded = decodePin(subject);
							if (Option.isNone(decoded)) continue;
							const { sessionId, directories, prefix, end } = decoded.value;
							const directory = directories[Number(ref.slice(slash + 1))];
							if (directory === undefined) continue;
							const known = pinned.get(runId) ?? {
								live: {
									sessionId,
									directories,
									starts: new Map(),
									shared: new Set(),
									done: yield* Deferred.make<void>(),
									ended: false,
								},
								ends: new Map(),
							};
							pinned.set(runId, known);
							const start = end?.start ?? tree;
							known.live.starts.set(directory, {
								store,
								prefix,
								index: start,
								worktree: start,
							});
							if (!end) continue;
							known.ends.set(
								directory,
								Result.succeed({ store, prefix, index: tree, worktree: tree }),
							);
							if (end.shared) known.live.shared.add(directory);
						}
					}
					const owing: [string, LiveRun, readonly End[]][] = [];
					for (const [runId, { live, ends }] of pinned) {
						const fate = yield* owed(live.sessionId, runId);
						if (fate === "running") markShared(runs.values(), live);
						live.ended = fate !== "running";
						runs.set(runId, live);
						if (fate === "done") yield* drop(runId);
						if (fate === "ended")
							owing.push([
								runId,
								live,
								live.directories.map(
									(directory): End => [
										directory,
										ends.get(directory) ??
											Result.fail(
												new FolderTimelineError({
													reason: "failed",
													message:
														"The daemon restarted before the run's end checkpoint",
												}),
											),
									],
								),
							]);
					}
					for (const [runId, live, ends] of owing)
						yield* capture(runId, live, ends, record).pipe(
							finish(runId),
							Effect.forkIn(scope),
						);
				}),
			settled: (runId) =>
				Effect.gen(function* () {
					const live = runs.get(runId);
					if (live) yield* Deferred.await(live.done);
				}),
			forget: (sessionId) =>
				Effect.gen(function* () {
					for (const [runId, live] of [...runs])
						if (live.sessionId === sessionId) yield* drop(runId);
					yield* sessionLock(sessionId).withPermits(1)(
						fs(() =>
							rm(sessionStore(sessionId), { recursive: true, force: true }),
						).pipe(Effect.ignore, Effect.andThen(dropKept(sessionId))),
					);
					sessionLocks.delete(sessionId);
				}),
			storeBytes: (sessionId) =>
				Effect.promise(() => bytesUnder(sessionStore(sessionId))),
			diskUse: Effect.promise(() => bytesUnder(join(root, "sessions"))),
			evict: (sessionId, append) =>
				sessionLock(sessionId).withPermits(1)(
					Effect.gen(function* () {
						if (!(yield* append)) return false;
						const store = sessionStore(sessionId);
						// The ref goes first: a store without it holds nothing reachable.
						yield* git(store, ["update-ref", "-d", SESSION_REF]).pipe(
							Effect.ignore,
						);
						yield* dropKept(sessionId);
						yield* fs(() => rm(store, { recursive: true, force: true })).pipe(
							Effect.catch((error) =>
								Effect.logWarning("Evicted store not removed", {
									sessionId,
									error,
								}),
							),
						);
						return true;
					}),
				),
		} satisfies FolderTimeline["Service"];
	});
