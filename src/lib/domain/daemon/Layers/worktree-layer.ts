import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { Cause, Effect, Either, Layer, Stream } from "effect";
import type { SessionWorktreeOwnership } from "../../../contracts/session-workspace.js";
import {
	type WorkspaceMissing,
	WorktreeBranchRenameError,
	WorktreeCreationError,
	WorktreeRecoveryError,
} from "../../../contracts/worktree.js";
import {
	type CreatedWorktrees,
	type WorktreeFolder,
	type WorktreeService,
	WorktreeServiceTag,
	type WorktreeSetupResult,
	type WorktreeSetupUpdate,
} from "../Services/worktree-service.js";

const execFileAsync = promisify(execFile);
const hasCode = (cause: unknown, code: string) =>
	typeof cause === "object" &&
	cause !== null &&
	"code" in cause &&
	cause.code === code;

/** Resolve symlink ancestors even when the requested child has not been created. */
const realPathWithMissingChildren = (path: string): string => {
	let ancestor = resolve(path);
	const children: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(ancestor), ...children.reverse());
		} catch (cause) {
			if (!hasCode(cause, "ENOENT") && !hasCode(cause, "ENOTDIR")) throw cause;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw cause;
			children.push(basename(ancestor));
			ancestor = parent;
		}
	}
};

export const worktreesRoot = (configDir: string) =>
	realPathWithMissingChildren(join(configDir, "worktrees"));

export const isConduitWorktreePath = (configDir: string, candidate: string) => {
	const roots = [resolve(configDir, "worktrees"), worktreesRoot(configDir)];
	const paths = [resolve(candidate), realPathWithMissingChildren(candidate)];
	return roots.some((root) =>
		paths.some((path) => {
			const child = relative(root, path);
			return (
				child === "" ||
				(!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
			);
		}),
	);
};

const branchConflicts = (branches: ReadonlySet<string>, candidate: string) =>
	[...branches].some(
		(branch) =>
			branch === candidate ||
			branch.startsWith(`${candidate}/`) ||
			candidate.startsWith(`${branch}/`),
	);

const generatedBranchName = (label: string, branches: ReadonlySet<string>) => {
	const baseName = `${branches.has("conduit") ? "conduit-session-" : "conduit/session-"}${label}`;
	let name = baseName;
	for (let suffix = 2; branchConflicts(branches, name); suffix++)
		name = `${baseName}-${suffix}`;
	return name;
};

export const ownedWorktreePath = (
	configDir: string,
	folder: WorktreeFolder,
) => {
	const key = (value: string) =>
		encodeURIComponent(value).replaceAll(".", "%2E");
	const label =
		basename(folder.path).replace(/[^a-zA-Z0-9_-]/g, "-") || "folder";
	const hash = createHash("sha256")
		.update(resolve(folder.path))
		.digest("hex")
		.slice(0, 12);
	return join(
		worktreesRoot(configDir),
		key(folder.projectSlug),
		key(folder.sessionId),
		`${label}-${hash}`,
	);
};

export const makeWorktreeLive = (
	configDir: string,
	options: {
		readonly gitExecutable?: string;
		readonly gitTimeoutMs?: number;
		readonly setupTimeoutMs?: number;
	} = {},
) =>
	Layer.effect(
		WorktreeServiceTag,
		Effect.sync(() => {
			const runSetup: WorktreeService["runSetup"] = (cwd, script, env) =>
				Stream.asyncPush<WorktreeSetupUpdate>((emit) =>
					Effect.acquireRelease(
						Effect.sync(() => {
							const timeoutMs = options.setupTimeoutMs ?? 10 * 60_000;
							const limit = 64 * 1024;
							let child: ChildProcess | undefined;
							let timeout: ReturnType<typeof setTimeout> | undefined;
							let finished = false;
							let groupStopped = false;
							let capturedBytes = 0;
							let truncated = false;
							const decoder = new StringDecoder("utf8");
							const output = (text: string) => {
								if (text && !finished)
									emit.single({ _tag: "output", output: text });
							};
							const collect = (chunk: Buffer) => {
								if (truncated || finished) return;
								const remaining = limit - capturedBytes;
								const accepted = chunk.subarray(0, remaining);
								capturedBytes += accepted.length;
								output(decoder.write(accepted));
								if (chunk.length > remaining) {
									truncated = true;
									output("\n[Setup output truncated after 64 KiB]\n");
								}
							};
							const killGroup = () => {
								if (groupStopped || !child?.pid) return;
								groupStopped = true;
								try {
									if (process.platform === "win32") child.kill("SIGKILL");
									else process.kill(-child.pid, "SIGKILL");
								} catch {
									// The owned group may already be gone.
								}
							};
							const finish = (result: WorktreeSetupResult) => {
								if (finished) return;
								clearTimeout(timeout);
								killGroup();
								if (!truncated) output(decoder.end());
								finished = true;
								emit.single(result);
								emit.end();
							};
							const failedToStart = (cause: unknown) =>
								finish({
									_tag: "finished",
									status: "failed",
									message: `Could not start setup script: ${cause instanceof Error ? cause.message : String(cause)}`,
								});
							timeout = setTimeout(
								() =>
									finish({
										_tag: "finished",
										status: "timed_out",
										message: `Setup script timed out after ${timeoutMs}ms.`,
									}),
								timeoutMs,
							);
							timeout.unref();
							try {
								// Pipe EOF also owns cleanup after abrupt daemon death. Save
								// stdin before background shells substitute /dev/null; only
								// the watchdog keeps it while exec preserves the PID/group.
								const spawned = spawn(
									"/bin/sh",
									[
										"-c",
										`exec 2>&1
setup_group=$$
exec 3<&0
(
  while IFS= read -r setup_line; do :; done
  kill -KILL -- "-$setup_group"
) <&3 3<&- >/dev/null 2>&1 &
exec 3<&- </dev/null
if [ -n "$1" ] && command -v "$1" >/dev/null 2>&1; then exec "$1" -lc "$2"; else exec /bin/sh -c "$2"; fi`,
										"conduit-setup",
										env["SHELL"]?.trim() ?? "",
										script,
									],
									{
										cwd,
										env,
										stdio: ["pipe", "pipe", "ignore"],
										detached: process.platform !== "win32",
									},
								);
								child = spawned;
								spawned.stdout.on("data", collect);
								spawned.once("error", failedToStart);
								spawned.once("exit", killGroup);
								spawned.once("close", (code, signal) => {
									finish({
										_tag: "finished",
										status: code === 0 ? "succeeded" : "failed",
										...(code !== null
											? { exitCode: code }
											: {
													message: `Setup script terminated by ${signal ?? "an unknown signal"}.`,
												}),
									});
								});
							} catch (cause) {
								failedToStart(cause);
							}
							return () => {
								clearTimeout(timeout);
								finished = true;
								killGroup();
								child?.stdin?.destroy();
								child?.stdout?.destroy();
							};
						}),
						(cleanup) => Effect.sync(cleanup),
					),
				);
			const git = (folder: string, args: readonly string[], input?: string) =>
				Effect.tryPromise({
					try: async (signal) => {
						const env: NodeJS.ProcessEnv = { ...process.env };
						for (const name of Object.keys(env))
							if (name.startsWith("GIT_")) delete env[name];
						env["GIT_TERMINAL_PROMPT"] = "0";
						env["GIT_OPTIONAL_LOCKS"] = "0";
						env["LC_ALL"] = "C";
						const result = execFileAsync(
							options.gitExecutable ?? "git",
							["-c", "core.hooksPath=/dev/null", ...args],
							{
								cwd: folder,
								env,
								encoding: "utf8",
								timeout: options.gitTimeoutMs ?? 30_000,
								maxBuffer: 1_048_576,
								signal,
							},
						);
						if (input !== undefined) result.child.stdin?.end(input);
						return (await result).stdout.trim();
					},
					catch: (cause) => {
						const detail =
							typeof cause === "object" &&
							cause !== null &&
							"stderr" in cause &&
							typeof cause.stderr === "string" &&
							cause.stderr.trim().length > 0
								? cause.stderr.trim()
								: cause instanceof Error
									? cause.message
									: String(cause);
						return new WorktreeCreationError({
							path: folder,
							reason: "git-failed",
							message: hasCode(cause, "ENOENT")
								? "Git executable was not found. Install Git to create a worktree."
								: `Git ${args[0]} failed: ${detail.slice(0, 2_000)}`,
						});
					},
				});
			const filesystem = <A>(path: string, operation: () => Promise<A>) =>
				Effect.tryPromise({
					try: operation,
					catch: (cause) =>
						new WorktreeCreationError({
							path,
							reason: "git-failed",
							message: `Could not prepare worktree path ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
						}),
				});
			const recoveryError = (
				error: WorktreeCreationError | WorktreeRecoveryError,
			) =>
				error instanceof WorktreeRecoveryError
					? error
					: new WorktreeRecoveryError({
							path: error.path,
							reason: "git-failed",
							message: error.message,
						});
			const pathStat = (path: string) =>
				filesystem(path, async () => {
					try {
						return await lstat(path);
					} catch (cause) {
						if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR"))
							return undefined;
						throw cause;
					}
				});
			const renameBranch: WorktreeService["renameBranch"] = (
				ownership,
				newName,
			) =>
				Effect.gen(function* () {
					const checkouts = [
						...new Map(ownership.map((owned) => [owned.path, owned])).values(),
					];
					const failure = (
						owned: SessionWorktreeOwnership,
						reason: WorktreeBranchRenameError["reason"],
						message: string,
					) =>
						new WorktreeBranchRenameError({
							folder: owned.folder,
							reason,
							message,
						});
					const runGit = (
						owned: SessionWorktreeOwnership,
						args: readonly string[],
					) =>
						git(owned.path, args).pipe(
							Effect.mapError((error) =>
								failure(owned, "git-failed", error.message),
							),
						);
					for (const owned of checkouts) {
						const folder = yield* Effect.try({
							try: () => ({
								path: owned.folder,
								projectSlug: decodeURIComponent(
									basename(dirname(dirname(owned.path))),
								),
								sessionId: decodeURIComponent(basename(dirname(owned.path))),
							}),
							catch: (cause) =>
								failure(
									owned,
									"not-owned",
									`Invalid owned worktree path: ${String(cause)}`,
								),
						});
						const checkout = yield* readOwned(folder, owned).pipe(
							Effect.mapError((error) =>
								failure(
									owned,
									error.reason === "not-owned" ? "not-owned" : "git-failed",
									error.message,
								),
							),
						);
						if (checkout.missing)
							return yield* failure(
								owned,
								"worktree-missing",
								`Worktree missing: ${owned.path}`,
							);
						const validated = yield* runGit(owned, [
							"check-ref-format",
							"--branch",
							newName,
						]).pipe(
							Effect.mapError((error) =>
								/not a valid branch name|usage: git check-ref-format/.test(
									error.message,
								)
									? failure(
											owned,
											"invalid-name",
											`Invalid branch name: ${newName}`,
										)
									: error,
							),
						);
						// Git expands @{-1}; a user-supplied branch name must be literal.
						if (validated !== newName)
							return yield* failure(
								owned,
								"invalid-name",
								`Invalid branch name: ${newName}`,
							);
						const branches = new Set(
							(yield* runGit(owned, [
								"for-each-ref",
								"--format=%(refname)",
								"refs/heads",
							]))
								.split("\n")
								.map((ref) => ref.replace(/^refs\/heads\//, "")),
						);
						branches.delete(owned.branchName);
						if (
							newName !== owned.branchName &&
							branchConflicts(branches, newName)
						)
							return yield* failure(
								owned,
								"already-exists",
								`Branch already exists or conflicts with an existing branch: ${newName}`,
							);
						const head = yield* runGit(owned, [
							"symbolic-ref",
							"--quiet",
							"HEAD",
						]).pipe(
							Effect.catchAll((error) =>
								/Git symbolic-ref failed:/.test(error.message)
									? failure(
											owned,
											"head-mismatch",
											`HEAD is not on the owned branch ${owned.branchName}`,
										)
									: Effect.fail(error),
							),
						);
						if (head !== `refs/heads/${owned.branchName}`)
							return yield* failure(
								owned,
								"head-mismatch",
								`HEAD is not on the owned branch ${owned.branchName}`,
							);
					}
					const attempted: SessionWorktreeOwnership[] = [];
					return yield* Effect.gen(function* () {
						for (const owned of checkouts) {
							if (owned.branchName === newName) continue;
							attempted.push(owned);
							yield* runGit(owned, ["branch", "-m", owned.branchName, newName]);
						}
					}).pipe(
						Effect.catchAllCause((cause) =>
							Effect.gen(function* () {
								const errors: string[] = [];
								for (const owned of attempted.reverse()) {
									const rollback = yield* Effect.either(
										Effect.gen(function* () {
											// A timed-out Git command may have completed its rename.
											const head = yield* runGit(owned, [
												"symbolic-ref",
												"--quiet",
												"HEAD",
											]);
											// Git moves the ref before updating worktree HEADs. A HEAD.lock
											// failure can leave HEAD on the old, now absent branch.
											const refs = new Set(
												(yield* runGit(owned, [
													"for-each-ref",
													"--format=%(refname)",
													`refs/heads/${owned.branchName}`,
													`refs/heads/${newName}`,
												])).split("\n"),
											);
											const oldExists = refs.has(
												`refs/heads/${owned.branchName}`,
											);
											const newExists = refs.has(`refs/heads/${newName}`);
											if (
												head === `refs/heads/${owned.branchName}` &&
												oldExists &&
												!newExists
											)
												return;
											if (
												oldExists ||
												!newExists ||
												(head !== `refs/heads/${newName}` &&
													head !== `refs/heads/${owned.branchName}`)
											)
												return yield* failure(
													owned,
													"head-mismatch",
													"Branch refs or HEAD changed during branch rename rollback",
												);
											yield* runGit(owned, [
												"branch",
												"-m",
												newName,
												owned.branchName,
											]);
										}),
									);
									if (Either.isLeft(rollback))
										errors.push(`${owned.folder}: ${rollback.left.message}`);
								}
								if (errors.length > 0) {
									const original = Cause.failureOption(cause);
									return yield* new WorktreeBranchRenameError({
										folder:
											original._tag === "Some"
												? original.value.folder
												: (attempted[0]?.folder ?? ""),
										reason: "git-failed",
										message: `${original._tag === "Some" ? original.value.message : Cause.pretty(cause)}. Branch rollback failed: ${errors.join("; ")}`,
									});
								}
								return yield* Effect.failCause(cause);
							}).pipe(Effect.uninterruptible),
						),
					);
				});
			const readRecovery = (
				folder: WorktreeFolder,
				directory?: string,
				workspaceFolders: readonly string[] = [folder.path],
			) =>
				Effect.gen(function* () {
					const source = yield* filesystem(folder.path, async () =>
						realPathWithMissingChildren(folder.path),
					);
					// A project's subfolder may disappear from main while still existing
					// on the session branch. Read its refs through the nearest ancestor.
					let ancestor = source;
					while (!(yield* pathStat(ancestor))?.isDirectory()) {
						const parent = dirname(ancestor);
						if (parent === ancestor)
							return yield* new WorktreeRecoveryError({
								path: source,
								reason: "git-failed",
								message:
									"Could not locate the main repository for this worktree.",
							});
						ancestor = parent;
					}
					const root = yield* git(ancestor, ["rev-parse", "--show-toplevel"]);
					const subfolder = relative(root, source);
					const owned = yield* Effect.try({
						try: () => ownedWorktreePath(configDir, folder),
						catch: (cause) =>
							new WorktreeRecoveryError({
								path: directory ?? folder.path,
								reason: "not-owned",
								message: `Could not resolve the owned worktree path: ${String(cause)}`,
							}),
					});
					const mapped = resolve(directory ?? join(owned, subfolder));
					const path = resolve(
						mapped,
						...subfolder
							.split(sep)
							.filter(Boolean)
							.map(() => ".."),
					);
					// Forks share the parent's mapping. Validate that recorded owner's path
					// rather than inventing a checkout under the fork's id.
					const expected = yield* Effect.try({
						try: () =>
							workspaceFolders.map((ownerFolder) =>
								ownedWorktreePath(configDir, {
									...folder,
									path: ownerFolder,
									sessionId: decodeURIComponent(basename(dirname(path))),
								}),
							),
						catch: (cause) =>
							new WorktreeRecoveryError({
								path: mapped,
								reason: "not-owned",
								message: `Invalid owned worktree path: ${String(cause)}`,
							}),
					});
					if (!expected.includes(path) || mapped !== join(path, subfolder))
						return yield* new WorktreeRecoveryError({
							path: mapped,
							reason: "not-owned",
							message:
								"Could not recreate worktree: the recorded folder is not a Conduit-owned worktree.",
						});
					const listed = yield* git(root, [
						"worktree",
						"list",
						"--porcelain",
						"-z",
					]);
					const entries = listed.split("\0\0");
					const entry = entries.find((entry) =>
						entry.split("\0").includes(`worktree ${path}`),
					);
					const targetStat = yield* pathStat(path);
					const markerStat = yield* pathStat(join(path, ".git"));
					const directoryStat = yield* pathStat(mapped);
					const usable = Boolean(
						entry &&
							targetStat?.isDirectory() &&
							!targetStat.isSymbolicLink() &&
							markerStat?.isFile() &&
							directoryStat?.isDirectory() &&
							(yield* filesystem(path, () => realpath(path))) === path &&
							(yield* git(mapped, ["rev-parse", "--show-toplevel"])) === path,
					);
					const branch = entry
						?.split("\0")
						.find((field) => field.startsWith("branch refs/heads/"))
						?.slice(18);
					const refs =
						branch && !usable
							? (yield* git(root, [
									"for-each-ref",
									"--format=%(refname)",
									"refs/heads",
								])).split("\n")
							: [];
					// --force is needed for this path's prunable registration, but must
					// not bypass Git's protection of another checkout on this branch.
					const branchInUse =
						branch && !usable
							? yield* Effect.exists(entries, (other) => {
									const fields = other.split("\0");
									const otherPath = fields
										.find((field) => field.startsWith("worktree "))
										?.slice(9);
									return otherPath &&
										otherPath !== path &&
										fields.includes(`branch refs/heads/${branch}`)
										? pathStat(otherPath).pipe(Effect.map(Boolean))
										: Effect.succeed(false);
								})
							: false;
					const reason = !branch
						? ("branch-unknown" as const)
						: !usable && !refs.includes(`refs/heads/${branch}`)
							? ("branch-missing" as const)
							: branchInUse
								? ("branch-in-use" as const)
								: undefined;
					return {
						source: root,
						path,
						directory: mapped,
						usable,
						branch,
						reason,
					};
				}).pipe(Effect.mapError(recoveryError));
			const inspectMissing: WorktreeService["inspectMissing"] = (
				folder,
				directory,
				workspaceFolders,
			) =>
				readRecovery(folder, directory, workspaceFolders).pipe(
					Effect.map((state): WorkspaceMissing | undefined =>
						state.usable
							? undefined
							: {
									path: state.directory,
									...(state.branch ? { branch: state.branch } : {}),
									canRecreate: state.reason === undefined,
									...(state.reason ? { reason: state.reason } : {}),
								},
					),
				);
			const recreate: WorktreeService["recreate"] = (
				folder,
				directory,
				workspaceFolders,
			) =>
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const state = yield* restore(
							readRecovery(folder, directory, workspaceFolders),
						);
						if (yield* pathStat(state.path))
							return yield* new WorktreeRecoveryError({
								path: state.path,
								reason: "target-exists",
								message: `Could not recreate worktree: the target is already occupied: ${state.path}`,
							});
						if (!state.branch || state.reason)
							return yield* new WorktreeRecoveryError({
								path: state.directory,
								reason: state.reason ?? "branch-unknown",
								message:
									state.reason === "branch-missing"
										? `Could not recreate worktree: branch "${state.branch}" no longer exists. Continue in main folder instead.`
										: state.reason === "branch-in-use"
											? `Could not recreate worktree: branch "${state.branch}" is checked out in another worktree. Continue in main folder instead.`
											: "Could not recreate worktree: Git no longer records its branch. Continue in main folder instead.",
							});
						yield* filesystem(dirname(state.path), () =>
							mkdir(dirname(state.path), { recursive: true }),
						);
						// Claim only an absent path, including refusing dangling symlinks.
						yield* Effect.tryPromise({
							try: () => mkdir(state.path),
							catch: (cause) =>
								new WorktreeRecoveryError({
									path: state.path,
									reason: hasCode(cause, "EEXIST")
										? "target-exists"
										: "git-failed",
									message: `Could not recreate worktree: ${hasCode(cause, "EEXIST") ? "the target is already occupied" : String(cause)}`,
								}),
						});
						// --force permits reusing this branch's prunable registration. It
						// neither makes a new branch nor prunes unrelated worktrees.
						return yield* git(state.source, [
							"worktree",
							"add",
							"--force",
							"--",
							state.path,
							state.branch,
						]).pipe(
							Effect.zipRight(restore(Effect.succeed(state.directory))),
							Effect.catchAllCause((cause) =>
								// Keep the branch and registration available for another attempt.
								filesystem(state.path, () =>
									rm(state.path, { recursive: true, force: true }),
								).pipe(Effect.zipRight(Effect.failCause(cause))),
							),
						);
					}),
				).pipe(Effect.mapError(recoveryError));
			const recreateAll: WorktreeService["recreateAll"] = (folders) =>
				Effect.uninterruptibleMask((restore) => {
					const recreated: { folder: string; path: string }[] = [];
					const workspaceFolders = folders.map(({ folder }) => folder.path);
					return Effect.forEach(
						folders,
						({ folder, directory }) =>
							Effect.gen(function* () {
								const state = yield* restore(
									readRecovery(folder, directory, workspaceFolders),
								);
								if (state.usable) return;
								yield* restore(recreate(folder, directory, workspaceFolders));
								recreated.push({ folder: folder.path, path: state.path });
							}).pipe(
								Effect.mapError(
									(error) =>
										new WorktreeRecoveryError({
											path: error.path,
											reason: error.reason,
											message: `Folder "${folder.path}": ${error.message}`,
										}),
								),
							),
						{ discard: true },
					).pipe(
						Effect.catchAllCause((cause) =>
							Effect.gen(function* () {
								// Retain prunable registrations and branch refs, just as single
								// checkout recovery does on failure, so another attempt can retry.
								const cleanup = yield* Effect.either(
									Effect.validateAll(
										[...recreated].reverse(),
										({ folder, path }) =>
											filesystem(path, () =>
												rm(path, { recursive: true, force: true }),
											).pipe(
												Effect.mapError(
													(error) => `Folder "${folder}": ${error.message}`,
												),
											),
									),
								);
								if (Either.isLeft(cleanup)) {
									const failure = Cause.failureOption(cause);
									return yield* new WorktreeRecoveryError({
										path:
											failure._tag === "Some"
												? failure.value.path
												: (recreated[0]?.path ?? ""),
										reason: "git-failed",
										message: `${failure._tag === "Some" ? failure.value.message : Cause.pretty(cause)}. Worktree rollback failed: ${cleanup.left.join("; ")}`,
									});
								}
								return yield* Effect.failCause(cause);
							}),
						),
					);
				});
			const creationBase = (source: string, branch: string) =>
				git(source, [
					"reflog",
					"show",
					"--format=%H%x00%gs",
					`refs/heads/${branch}`,
				]).pipe(
					Effect.map((log) => {
						const [head, message] = (log.split("\n").at(-1) ?? "").split("\0");
						return message?.startsWith("conduit: created session worktree ")
							? head
							: undefined;
					}),
					Effect.orElseSucceed(() => undefined),
				);
			const legacyOwnership: WorktreeService["legacyOwnership"] = (
				folder,
				directory,
			) =>
				Effect.gen(function* () {
					const state = yield* readRecovery(folder, directory);
					// A fork's inherited path belongs to its parent, even though its origin is Conduit.
					if (
						state.path !== ownedWorktreePath(configDir, folder) ||
						!state.branch
					)
						return undefined;
					const head = yield* creationBase(state.source, state.branch);
					return head
						? {
								folder: folder.path,
								path: state.path,
								branchName: state.branch,
								head,
							}
						: undefined;
				}).pipe(Effect.mapError(recoveryError));
			const readOwned = (
				folder: WorktreeFolder,
				owned: SessionWorktreeOwnership,
			) =>
				Effect.gen(function* () {
					const expected = yield* filesystem(owned.path, async () =>
						ownedWorktreePath(configDir, folder),
					);
					if (
						folder.path !== owned.folder ||
						resolve(owned.path) !== expected ||
						(yield* filesystem(owned.path, async () =>
							realPathWithMissingChildren(owned.path),
						)) !== expected
					)
						return yield* new WorktreeRecoveryError({
							path: owned.path,
							reason: "not-owned",
							message:
								"The recorded checkout is not this session's Conduit-created worktree.",
						});
					let source = owned.folder;
					while (!(yield* pathStat(source))?.isDirectory()) {
						const parent = dirname(source);
						if (parent === source)
							return yield* new WorktreeRecoveryError({
								path: owned.path,
								reason: "git-failed",
								message: "Could not locate the original worktree repository.",
							});
						source = parent;
					}
					const root = yield* git(source, ["rev-parse", "--show-toplevel"]);
					const stat = yield* pathStat(owned.path);
					if (!stat) return { source: root, missing: true };
					const registered = (yield* git(root, [
						"worktree",
						"list",
						"--porcelain",
						"-z",
					]))
						.split("\0\0")
						.some((entry) =>
							entry.split("\0").includes(`worktree ${owned.path}`),
						);
					if (
						!registered ||
						!stat.isDirectory() ||
						stat.isSymbolicLink() ||
						!(yield* pathStat(join(owned.path, ".git")))?.isFile() ||
						(yield* git(owned.path, ["rev-parse", "--show-toplevel"])) !==
							owned.path ||
						(yield* git(owned.path, [
							"rev-parse",
							"--path-format=absolute",
							"--git-common-dir",
						])) !==
							(yield* git(root, [
								"rev-parse",
								"--path-format=absolute",
								"--git-common-dir",
							]))
					)
						return yield* new WorktreeRecoveryError({
							path: owned.path,
							reason: "not-owned",
							message:
								"The owned path is no longer the registered checkout of its original repository.",
						});
					return { source: root, missing: false };
				}).pipe(Effect.mapError(recoveryError));
			const defaultBranch = (source: string) =>
				Effect.gen(function* () {
					const remote = yield* git(source, [
						"symbolic-ref",
						"-q",
						"refs/remotes/origin/HEAD",
					]).pipe(Effect.orElseSucceed(() => undefined));
					for (const ref of [
						...(remote ? [remote] : []),
						"refs/heads/main",
						"refs/heads/master",
					]) {
						const head = yield* git(source, [
							"rev-parse",
							"--verify",
							`${ref}^{commit}`,
						]).pipe(Effect.orElseSucceed(() => undefined));
						if (head) return { ref, head };
					}
					return undefined;
				});
			const isMerged = (source: string, head: string, base: string) =>
				git(source, ["merge-base", "--is-ancestor", head, base]).pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false),
				);
			const inspectRemoval: WorktreeService["inspectRemoval"] = (
				folder,
				owned,
			) =>
				Effect.gen(function* () {
					const state = yield* readOwned(folder, owned);
					if (state.missing) return [];
					const reasons: string[] = [];
					if (
						yield* git(owned.path, [
							"status",
							"--porcelain",
							"--untracked-files=all",
						])
					)
						reasons.push("Uncommitted changes");
					const upstream = yield* git(owned.path, [
						"rev-parse",
						"--verify",
						"@{upstream}^{commit}",
					]).pipe(Effect.orElseSucceed(() => undefined));
					const ahead = yield* git(owned.path, [
						"rev-list",
						"--count",
						`${upstream ?? owned.head}..HEAD`,
					]);
					if (Number(ahead) > 0) reasons.push("Unpushed commits");
					const main = yield* defaultBranch(state.source);
					if (!main) reasons.push("Unknown default branch");
					else if (!(yield* isMerged(owned.path, "HEAD", main.head)))
						reasons.push("Commits not merged into the default branch");
					return reasons;
				}).pipe(Effect.mapError(recoveryError));
			const remove: WorktreeService["remove"] = (folder, owned, inUse) =>
				Effect.gen(function* () {
					const state = yield* readOwned(folder, owned);
					if (state.missing) return;
					// Git also rechecks dirtiness while removing, so a write racing this read is protected.
					if (
						yield* git(owned.path, [
							"status",
							"--porcelain",
							"--untracked-files=all",
						])
					)
						return yield* new WorktreeRecoveryError({
							path: owned.path,
							reason: "git-failed",
							message: "Worktree kept because it has uncommitted changes.",
						});
					if (!(yield* git(owned.path, ["branch", "--show-current"]))) {
						const main = yield* defaultBranch(state.source);
						if (!main || !(yield* isMerged(owned.path, "HEAD", main.head)))
							return yield* new WorktreeRecoveryError({
								path: owned.path,
								reason: "git-failed",
								message:
									"Worktree kept because detached commits are not known to be merged into the default branch.",
							});
					}
					if (inUse && (yield* inUse))
						return yield* new WorktreeRecoveryError({
							path: owned.path,
							reason: "branch-in-use",
							message: "Worktree kept because another session uses it.",
						});
					yield* git(state.source, ["worktree", "remove", "--", owned.path]);
					// Never infer ref ownership from whichever user branch happens to be checked out.
					if (
						(yield* creationBase(state.source, owned.branchName)) !== owned.head
					)
						return;
					const tip = yield* git(state.source, [
						"rev-parse",
						"--verify",
						`refs/heads/${owned.branchName}^{commit}`,
					]).pipe(Effect.orElseSucceed(() => undefined));
					const main = yield* defaultBranch(state.source);
					if (!tip || !main || !(yield* isMerged(state.source, tip, main.head)))
						return;
					const listed = yield* git(state.source, [
						"worktree",
						"list",
						"--porcelain",
						"-z",
					]);
					if (
						listed.split("\0").includes(`branch refs/heads/${owned.branchName}`)
					)
						return;
					// Both tips are compared in one ref transaction. Concurrent commits or a moved default
					// branch keep the owned branch instead of deleting work checked after the merge proof.
					yield* git(
						state.source,
						["update-ref", "--stdin"],
						`start\nverify ${main.ref} ${main.head}\ndelete refs/heads/${owned.branchName} ${tip}\nprepare\ncommit\n`,
					);
				}).pipe(Effect.mapError(recoveryError));
			const rollback: WorktreeService["rollback"] = (created) =>
				Effect.validateAll([...created.ownership].reverse(), (owned) =>
					Effect.gen(function* () {
						const listed = yield* git(owned.folder, [
							"worktree",
							"list",
							"--porcelain",
							"-z",
						]);
						if (listed.split("\0").includes(`worktree ${owned.path}`))
							yield* git(owned.folder, [
								"worktree",
								"remove",
								"--force",
								"--force",
								"--",
								owned.path,
							]);
						yield* filesystem(owned.path, () =>
							rm(owned.path, { recursive: true, force: true }),
						);
						// Compare the original commit so a ref changed by someone else is preserved.
						yield* git(owned.folder, [
							"update-ref",
							"-d",
							`refs/heads/${owned.branchName}`,
							owned.head,
						]);
					}),
				).pipe(
					Effect.mapError(
						(errors) =>
							new WorktreeCreationError({
								path: errors[0].path,
								reason: errors[0].reason,
								message: errors.map((error) => error.message).join("; "),
							}),
					),
					Effect.asVoid,
					Effect.uninterruptible,
				);
			const create: WorktreeService["create"] = (
				folders,
				baseBranches,
				requestedBranch,
			) =>
				Effect.uninterruptibleMask((restore) => {
					let owned: CreatedWorktrees | undefined;
					let reservedPath: string | undefined;
					return Effect.gen(function* () {
						const discovered = yield* restore(
							Effect.forEach(folders, (folder) =>
								Effect.gen(function* () {
									const baseBranch = baseBranches?.[folder.path];
									const source = yield* filesystem(folder.path, () =>
										realpath(folder.path),
									);
									const insideWorkTree = yield* git(source, [
										"rev-parse",
										"--is-inside-work-tree",
									]).pipe(
										Effect.catchIf(
											(error) => error.message.includes("not a git repository"),
											() => Effect.succeed("false"),
										),
									);
									if (insideWorkTree !== "true") {
										if (baseBranch !== undefined)
											return yield* new WorktreeCreationError({
												path: folder.path,
												reason: "unsupported-project",
												message:
													"A worktree base requires a Git project folder.",
											});
										return undefined;
									}
									const rootPath = yield* git(source, [
										"rev-parse",
										"--show-toplevel",
									]);
									const root = yield* filesystem(rootPath, () =>
										realpath(rootPath),
									);
									const commonPath = yield* git(source, [
										"rev-parse",
										"--path-format=absolute",
										"--git-common-dir",
									]);
									const commonDir = yield* filesystem(commonPath, () =>
										realpath(commonPath),
									);
									const currentBranch = yield* git(source, [
										"branch",
										"--show-current",
									]);
									if (!currentBranch && baseBranch === undefined)
										return yield* new WorktreeCreationError({
											path: folder.path,
											reason: "detached-head",
											message:
												"The project folder has detached HEAD. Check out a branch before creating a worktree.",
										});
									// Snapshot the committed base. Staged, unstaged and untracked edits stay in source.
									const head = yield* baseBranch === undefined
										? git(source, ["rev-parse", "--verify", "HEAD^{commit}"])
										: git(source, [
												"show-ref",
												"--verify",
												"--hash",
												`refs/heads/${baseBranch}`,
											]).pipe(
												Effect.flatMap((ref) =>
													git(source, [
														"rev-parse",
														"--verify",
														`${ref}^{commit}`,
													]),
												),
												Effect.mapError(
													() =>
														new WorktreeCreationError({
															path: folder.path,
															reason: "invalid-branch",
															message: `Local base branch does not exist or is invalid: ${baseBranch}`,
														}),
												),
											);
									if (requestedBranch !== undefined) {
										const valid = yield* git(source, [
											"check-ref-format",
											"--branch",
											requestedBranch,
										]).pipe(
											Effect.mapError(
												() =>
													new WorktreeCreationError({
														path: folder.path,
														reason: "invalid-branch",
														message: `Invalid worktree branch name: ${requestedBranch}`,
													}),
											),
										);
										if (valid !== requestedBranch)
											return yield* new WorktreeCreationError({
												path: folder.path,
												reason: "invalid-branch",
												message: `Invalid worktree branch name: ${requestedBranch}`,
											});
									}
									const branches = new Set(
										(yield* git(source, [
											"for-each-ref",
											"--format=%(refname:lstrip=2)",
											"refs/heads",
										])).split("\n"),
									);
									if (
										requestedBranch !== undefined &&
										branchConflicts(branches, requestedBranch)
									)
										return yield* new WorktreeCreationError({
											path: folder.path,
											reason: "branch-exists",
											message: `Worktree branch already exists: ${requestedBranch}`,
										});
									const path = yield* Effect.try({
										try: () => ownedWorktreePath(configDir, folder),
										catch: (cause) =>
											new WorktreeCreationError({
												path: configDir,
												reason: "git-failed",
												message: `Could not resolve the worktrees root: ${String(cause)}`,
											}),
									});
									return {
										folder,
										source,
										root,
										commonDir,
										head,
										branches,
										path,
									};
								}),
							),
						);
						const targets = discovered.filter((target) => target !== undefined);
						const first = targets[0];
						if (!first)
							return yield* new WorktreeCreationError({
								path: folders[0]?.path ?? "",
								reason: "unsupported-project",
								message: "New worktree requires at least one Git folder.",
							});
						const label =
							first.folder.sessionId
								.replace(/[^a-zA-Z0-9-]/g, "-")
								.replace(/^-+|-+$/g, "")
								.slice(0, 12) || "new";
						const allBranches = new Set(
							targets.flatMap((target) => [...target.branches]),
						);
						let branchName =
							requestedBranch ?? generatedBranchName(label, allBranches);
						const checkouts = new Map<string, { path: string; head: string }>();
						for (const target of targets) {
							// Folders of one repository share its checkout; Git permits a branch
							// to be checked out only once in the same common directory.
							const checkout = checkouts.get(target.commonDir);
							if (checkout && owned) {
								if (checkout.head !== target.head)
									return yield* new WorktreeCreationError({
										path: target.folder.path,
										reason: "unsupported-project",
										message:
											"Folders sharing a repository have different base commits. Choose matching checkouts before creating a worktree.",
									});
								owned = {
									...owned,
									worktrees: {
										...owned.worktrees,
										[target.folder.path]: join(
											checkout.path,
											relative(target.root, target.source),
										),
									},
								};
								continue;
							}
							yield* filesystem(dirname(target.path), () =>
								mkdir(dirname(target.path), { recursive: true }),
							);
							// mkdir is the cross-instance ownership claim; Git accepts an existing empty directory.
							yield* Effect.tryPromise({
								try: () => mkdir(target.path),
								catch: (cause) =>
									new WorktreeCreationError({
										path: target.path,
										reason: hasCode(cause, "EEXIST")
											? "target-exists"
											: "git-failed",
										message: hasCode(cause, "EEXIST")
											? `Worktree target already exists: ${target.path}`
											: `Could not create worktree directory: ${String(cause)}`,
									}),
							});
							reservedPath = target.path;
							const creationMarker = `conduit: created session worktree ${randomUUID()}`;
							for (;;) {
								const created: CreatedWorktrees = {
									branchName,
									worktrees: {
										...owned?.worktrees,
										[target.folder.path]: join(
											target.path,
											relative(target.root, target.source),
										),
									},
									ownership: [
										...(owned?.ownership ?? []),
										{
											folder: target.source,
											path: target.path,
											branchName,
											head: target.head,
										},
									],
								};
								// An empty expected old ref creates only when absent. Its reflog marker
								// proves ownership if Git writes the ref before failure or timeout.
								const result = yield* Effect.either(
									git(target.source, [
										"update-ref",
										"--create-reflog",
										"-m",
										creationMarker,
										`refs/heads/${branchName}`,
										target.head,
										"",
									]),
								);
								if (Either.isRight(result)) {
									owned = created;
									reservedPath = undefined;
									yield* git(target.source, [
										"worktree",
										"add",
										"--",
										target.path,
										branchName,
									]);
									checkouts.set(target.commonDir, {
										path: target.path,
										head: target.head,
									});
									break;
								}
								const branches = new Set(
									(yield* git(target.source, [
										"for-each-ref",
										"--format=%(refname:lstrip=2)",
										"refs/heads",
									])).split("\n"),
								);
								if (branches.has(branchName)) {
									const reflog = yield* git(target.source, [
										"reflog",
										"show",
										"--format=%gs",
										"-1",
										`refs/heads/${branchName}`,
									]);
									if (reflog === creationMarker) {
										owned = created;
										reservedPath = undefined;
										return yield* result.left;
									}
								}
								if (!branchConflicts(branches, branchName))
									return yield* result.left;
								if (requestedBranch !== undefined || owned !== undefined)
									return yield* new WorktreeCreationError({
										path: target.folder.path,
										reason: "branch-exists",
										message: `Worktree branch already exists: ${branchName}`,
									});
								for (const branch of branches) allBranches.add(branch);
								branchName = generatedBranchName(label, allBranches);
							}
						}
						// Observe pending interruption before transferring all ownership to the caller.
						if (owned) return yield* restore(Effect.succeed(owned));
						return yield* Effect.dieMessage(
							"No worktrees created for discovered Git folders",
						);
					}).pipe(
						Effect.catchAllCause((cause) => {
							const path = reservedPath;
							const cleanup = Effect.validateAll(
								[
									owned ? rollback(owned) : Effect.void,
									path
										? filesystem(path, () =>
												rm(path, { recursive: true, force: true }),
											).pipe(Effect.asVoid)
										: Effect.void,
								],
								(operation) => operation,
							);
							const failure = Cause.failureOption(cause);
							return cleanup.pipe(
								Effect.mapError(
									(errors) =>
										new WorktreeCreationError({
											path: errors[0].path,
											reason: errors[0].reason,
											message: `${failure._tag === "Some" ? failure.value.message : Cause.pretty(cause)}. Worktree rollback failed: ${errors.map((error) => error.message).join("; ")}`,
										}),
								),
								Effect.zipRight(Effect.failCause(cause)),
							);
						}),
					);
				});
			return {
				renameBranch,
				runSetup,
				create,
				rollback,
				inspectMissing,
				recreate,
				recreateAll,
				legacyOwnership,
				inspectRemoval,
				remove,
			} satisfies WorktreeService;
		}),
	);
