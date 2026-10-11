import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { Cause, Effect, Either, Layer } from "effect";
import {
	type WorkspaceMissing,
	WorktreeCreationError,
	WorktreeRecoveryError,
} from "../../../contracts/worktree.js";
import {
	type CreatedWorktrees,
	type WorktreeFolder,
	type WorktreeService,
	WorktreeServiceTag,
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
	} = {},
) =>
	Layer.effect(
		WorktreeServiceTag,
		Effect.sync(() => {
			const git = (folder: string, args: readonly string[]) =>
				Effect.tryPromise({
					try: async (signal) => {
						const env: NodeJS.ProcessEnv = { ...process.env };
						for (const name of Object.keys(env))
							if (name.startsWith("GIT_")) delete env[name];
						env["GIT_TERMINAL_PROMPT"] = "0";
						return (
							await execFileAsync(
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
							)
						).stdout.trim();
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
			const readRecovery = (folder: WorktreeFolder, directory?: string) =>
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
							ownedWorktreePath(configDir, {
								...folder,
								sessionId: decodeURIComponent(basename(dirname(path))),
							}),
						catch: (cause) =>
							new WorktreeRecoveryError({
								path: mapped,
								reason: "not-owned",
								message: `Invalid owned worktree path: ${String(cause)}`,
							}),
					});
					if (path !== expected || mapped !== join(path, subfolder))
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
			) =>
				readRecovery(folder, directory).pipe(
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
			const recreate: WorktreeService["recreate"] = (folder, directory) =>
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const state = yield* restore(readRecovery(folder, directory));
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
			const rollback: WorktreeService["rollback"] = (created) =>
				Effect.forEach(
					[...created.ownership].reverse(),
					(owned) =>
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
					{ discard: true },
				).pipe(Effect.uninterruptible);
			const create: WorktreeService["create"] = (
				folders,
				baseBranches,
				requestedBranch,
			) =>
				Effect.uninterruptibleMask((restore) => {
					let owned: CreatedWorktrees | undefined;
					let reservedPath: string | undefined;
					return Effect.gen(function* () {
						const folder = folders[0];
						if (folders.length !== 1 || !folder)
							return yield* new WorktreeCreationError({
								path: folder?.path ?? "",
								reason: "unsupported-project",
								message:
									"New worktree requires a project with exactly one Git folder.",
							});
						const target = yield* restore(
							Effect.gen(function* () {
								const source = yield* filesystem(folder.path, () =>
									realpath(folder.path),
								);
								const rootPath = yield* git(source, [
									"rev-parse",
									"--show-toplevel",
								]);
								const root = yield* filesystem(rootPath, () =>
									realpath(rootPath),
								);
								const currentBranch = yield* git(source, [
									"branch",
									"--show-current",
								]);
								if (!currentBranch)
									return yield* new WorktreeCreationError({
										path: folder.path,
										reason: "detached-head",
										message:
											"The project folder has detached HEAD. Check out a branch before creating a worktree.",
									});
								// Snapshot the committed base. Staged, unstaged and untracked edits stay in source.
								const head = yield* git(source, [
									"rev-parse",
									"--verify",
									`${baseBranches?.[folder.path] ?? "HEAD"}^{commit}`,
								]);
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
								const label =
									folder.sessionId
										.replace(/[^a-zA-Z0-9-]/g, "-")
										.replace(/^-+|-+$/g, "")
										.slice(0, 12) || "new";
								const branchName =
									requestedBranch ?? generatedBranchName(label, branches);
								const path = yield* Effect.try({
									try: () => ownedWorktreePath(configDir, folder),
									catch: (cause) =>
										new WorktreeCreationError({
											path: configDir,
											reason: "git-failed",
											message: `Could not resolve the worktrees root: ${String(cause)}`,
										}),
								});
								return { source, root, head, branchName, label, path };
							}),
						);
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
						let branchName = target.branchName;
						const creationMarker = `conduit: created session worktree ${randomUUID()}`;
						for (;;) {
							const created: CreatedWorktrees = {
								branchName,
								worktrees: {
									[folder.path]: join(
										target.path,
										relative(target.root, target.source),
									),
								},
								ownership: [
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
								yield* git(target.source, [
									"worktree",
									"add",
									"--",
									target.path,
									branchName,
								]);
								// Observe pending interruption before transferring ownership to the caller.
								return yield* restore(Effect.succeed(created));
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
									return yield* result.left;
								}
							}
							if (!branchConflicts(branches, branchName))
								return yield* result.left;
							if (requestedBranch !== undefined)
								return yield* new WorktreeCreationError({
									path: folder.path,
									reason: "branch-exists",
									message: `Worktree branch already exists: ${requestedBranch}`,
								});
							branchName = generatedBranchName(target.label, branches);
						}
					}).pipe(
						Effect.catchAllCause((cause) => {
							const path = reservedPath;
							const cleanup = owned
								? rollback(owned)
								: path
									? filesystem(path, () =>
											rm(path, { recursive: true, force: true }),
										).pipe(Effect.asVoid)
									: Effect.void;
							const failure = Cause.failureOption(cause);
							return cleanup.pipe(
								Effect.mapError(
									(error) =>
										new WorktreeCreationError({
											path: error.path,
											reason: error.reason,
											message: `${failure._tag === "Some" ? failure.value.message : Cause.pretty(cause)}. Worktree rollback failed: ${error.message}`,
										}),
								),
								Effect.zipRight(Effect.failCause(cause)),
							);
						}),
					);
				});
			return {
				create,
				rollback,
				inspectMissing,
				recreate,
			} satisfies WorktreeService;
		}),
	);
