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
import { Clock, Deferred, Effect } from "effect";
import {
	type FolderSnapshot,
	FolderTimelineError,
} from "../Services/folder-timeline.js";
import { Subprocess, SubprocessPriority } from "../Services/subprocess.js";

/** Diff git work has its own deadline, above session git's 2s reads. */
const GIT_TIMEOUT_MS = 10_000;
const COLLECT_INTERVAL_MS = 5 * 60_000;
const GRACE_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

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
		let swept = false;

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
			const exists = yield* fs(() => stat(join(store, "objects"))).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			if (!exists) {
				yield* fs(() => mkdir(root, { recursive: true }));
				yield* run(root, ["init", "--bare", "--quiet", "--template=", store]);
			}
			yield* fs(() =>
				writeFile(
					join(store, "objects", "info", "alternates"),
					`${join(commonDir, "objects")}\n`,
				),
			);
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
						if (!touched.has(join(root, name)))
							touched.set(join(root, name), 0);
				}
				const now = yield* Clock.currentTimeMillis;
				const expire =
					graceMs === 0 ? "now" : `${Math.ceil(graceMs / 1000)}.seconds.ago`;
				for (const [store, at] of [...touched]) {
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

		return {
			snapshot: (directory: string) =>
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
				}),
			git: (
				store: string,
				args: readonly string[],
				options: { readonly input?: string; readonly maxBuffer?: number } = {},
			) => run(store, ["--git-dir", store, ...args], options),
			collect,
		};
	});
