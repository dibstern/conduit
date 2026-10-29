import { createHash, randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	readdir,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Clock, Deferred, Effect, Semaphore } from "effect";
import type { RunChangesCaptured } from "../../../contracts/stored-event.js";
import {
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
const SETTLE_WAIT_MS = 5_000;
/** A run that changes more paths than this records a gap instead. */
const MAX_CHANGES = 5_000;
const SESSION_REF = "refs/conduit/session";
const PINS = "refs/conduit/runs/";
const IDENTITY = {
	GIT_AUTHOR_NAME: "conduit",
	GIT_AUTHOR_EMAIL: "conduit@localhost",
	GIT_COMMITTER_NAME: "conduit",
	GIT_COMMITTER_EMAIL: "conduit@localhost",
};

// Copied indexes must never split, monitor or trigger maintenance, and LFS
// clean filters would write into the repository's .git/lfs.
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
	"filter.lfs.required=false",
];

const baseEnv = () => {
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

const fs = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new FolderTimelineError({ reason: "failed", message: String(cause) }),
	});

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
}

const gapOf = (error: FolderTimelineError) => ({
	gap: error.reason,
	message: error.message,
});

/** `diff-tree -z --raw --no-renames`: a status record, then its path. */
function parseRaw(output: string): Change[] {
	const tokens = output.split("\0");
	const changes: Change[] = [];
	for (let at = 0; tokens[at]?.startsWith(":"); at += 2) {
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
	return changes;
}

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
		// A session's captures and its forgetting write one store, one at a time.
		const sessionLocks = new Map<string, Semaphore.Semaphore>();
		const sessionStore = (sessionId: string) =>
			join(
				root,
				"sessions",
				`${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.git`,
			);
		const sessionLock = (sessionId: string) => {
			const known = sessionLocks.get(sessionId);
			if (known) return known;
			const lock = Semaphore.makeUnsafe(1);
			sessionLocks.set(sessionId, lock);
			return lock;
		};

		const run = (
			cwd: string,
			args: readonly string[],
			options: {
				readonly env?: NodeJS.ProcessEnv;
				readonly input?: string;
				readonly maxBuffer?: number;
			} = {},
		) =>
			subprocess
				.run("git", ["--no-optional-locks", ...CONFIG, ...args], {
					cwd,
					env: { ...baseEnv(), ...options.env },
					timeoutMs: GIT_TIMEOUT_MS,
					maxBuffer: options.maxBuffer ?? MAX_OUTPUT_BYTES,
					...(options.input === undefined ? {} : { input: options.input }),
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

		const take = (directory: string) =>
			Effect.gen(function* () {
				const repository = yield* resolve(directory);
				const temp = join(repository.store, `snapshot-${randomUUID()}.index`);
				const env = {
					GIT_INDEX_FILE: temp,
					GIT_OBJECT_DIRECTORY: join(repository.store, "objects"),
				};
				return yield* Effect.gen(function* () {
					// Racy-git: an mtime floored to the second re-hashes same-second edits.
					// A repository with no index yet leaves no copy, which git reads as empty.
					yield* fs(async () => {
						const { mtimeMs } = await stat(repository.indexFile);
						await copyFile(repository.indexFile, temp);
						const seconds = Math.floor(mtimeMs / 1000);
						await utimes(temp, seconds, seconds);
					}).pipe(Effect.ignore);
					const index = (yield* run(directory, ["write-tree"], {
						env,
					})).stdout.trim();
					yield* run(directory, ["add", "--all", "--", "."], { env });
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
						.filter((ref) => ref !== "" && !runs.has(ref.slice(PINS.length)));
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

		const snapshot = (directory: string) =>
			Effect.gen(function* () {
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
			} = {},
		) => run(store, ["--git-dir", store, ...args], options);

		const unpin = (runId: string, live: LiveRun) =>
			Effect.forEach(live.starts.values(), (start) =>
				"store" in start
					? git(start.store, ["update-ref", "-d", `${PINS}${runId}`]).pipe(
							Effect.ignore,
						)
					: Effect.void,
			);
		const drop = (runId: string) =>
			Effect.gen(function* () {
				const live = runs.get(runId);
				if (!live) return;
				yield* unpin(runId, live);
				runs.delete(runId);
				yield* Deferred.succeed(live.done, undefined);
			});

		/** A tree of only the changed paths, as they were on one side of the run. */
		const sparseTree = (
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
				}).pipe(
					Effect.ensuring(Effect.promise(() => rm(index, { force: true }))),
				);
			});

		const captureFolder = (live: LiveRun, store: string, directory: string) =>
			Effect.gen(function* (): Effect.fn.Return<
				RunChangesCaptured["folders"][number],
				FolderTimelineError
			> {
				const start = live.starts.get(directory) ?? {
					gap: "failed" as const,
					message: "The run had no start checkpoint",
				};
				if (!("store" in start)) return { directory, ...start };
				const end = yield* snapshot(directory);
				const { stdout } = yield* git(start.store, [
					"diff-tree",
					"-r",
					"-z",
					"--raw",
					"--no-renames",
					...(start.prefix === "" ? [] : [`--relative=${start.prefix}`]),
					start.worktree,
					end.worktree,
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
					before: yield* sparseTree(store, changes, "before"),
					after: yield* sparseTree(store, changes, "after"),
					shared: live.shared.has(directory),
					changes,
				};
			}).pipe(
				Effect.catch((error) => Effect.succeed({ directory, ...gapOf(error) })),
			);

		/** Chains the capture under the session's ref and copies its objects into the store. */
		const commitCapture = (store: string, capture: RunChangesCaptured) =>
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
					[
						"pack-objects",
						"--revs",
						"-q",
						join(store, "objects", "pack", "pack"),
					],
					{ input: `${commit}\n${previous === "" ? "" : `^${previous}\n`}` },
				);
				yield* git(store, [
					"update-ref",
					SESSION_REF,
					commit,
					...parent.slice(1),
				]);
			});

		/** Creates the session's store, borrowing from every store its run's folders use. */
		const openSessionStore = (sessionId: string, live: LiveRun) =>
			Effect.gen(function* () {
				const store = sessionStore(sessionId);
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

		return {
			snapshot,
			git,
			collect,
			sessionStore,
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
					};
					for (const other of runs.values())
						if (other.sessionId !== sessionId)
							for (const directory of directories)
								if (other.directories.includes(directory)) {
									other.shared.add(directory);
									live.shared.add(directory);
								}
					runs.set(runId, live);
					yield* Effect.forEach(
						directories,
						(directory) =>
							Effect.gen(function* () {
								const start = yield* snapshot(directory);
								// The pin keeps the start tree's objects past the grace period.
								yield* git(start.store, [
									"update-ref",
									`${PINS}${runId}`,
									start.worktree,
								]);
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
							),
						{ concurrency: "unbounded", discard: true },
					);
				}),
			runJoined: drop,
			runEnded: (runId, record) =>
				Effect.gen(function* () {
					const live = runs.get(runId);
					if (!live) return;
					yield* sessionLock(live.sessionId).withPermits(1)(
						Effect.gen(function* () {
							const store = yield* openSessionStore(live.sessionId, live);
							const capture = {
								runId,
								folders: yield* Effect.forEach(
									live.directories,
									(directory) => captureFolder(live, store, directory),
									{ concurrency: "unbounded" },
								),
							};
							yield* commitCapture(store, capture);
							yield* record(live.sessionId, capture);
						}),
					);
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("Run capture failed", { runId, cause }),
					),
					Effect.ensuring(drop(runId)),
				),
			settled: (runId) =>
				Effect.gen(function* () {
					const live = runs.get(runId);
					if (live)
						yield* Deferred.await(live.done).pipe(
							Effect.timeout(SETTLE_WAIT_MS),
							Effect.ignore,
						);
				}),
			forget: (sessionId) =>
				Effect.gen(function* () {
					for (const [runId, live] of [...runs])
						if (live.sessionId === sessionId) yield* drop(runId);
					yield* sessionLock(sessionId).withPermits(1)(
						fs(() =>
							rm(sessionStore(sessionId), { recursive: true, force: true }),
						).pipe(Effect.ignore),
					);
					sessionLocks.delete(sessionId);
				}),
		} satisfies FolderTimeline["Service"];
	});
