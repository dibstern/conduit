import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
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
import { WorktreeCreationError } from "../../../contracts/worktree.js";
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
						env["LC_ALL"] = "C";
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
									if (insideWorkTree !== "true") return undefined;
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
			return { create, rollback } satisfies WorktreeService;
		}),
	);
