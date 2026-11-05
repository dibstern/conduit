import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Effect, Semaphore } from "effect";
import {
	SESSION_DIFF_TOO_LARGE_BYTES,
	SessionDiffEditError,
	type SessionDiffPatch,
} from "../../../contracts/session-diff.js";
import { FolderTimeline } from "../Services/folder-timeline.js";
import { SessionActivityTag } from "../Services/session-activity.js";
import { SessionDiff } from "../Services/session-diff.js";
import { SessionGit } from "../Services/session-git.js";
import { Subprocess, type SubprocessOptions } from "../Services/subprocess.js";
import type {
	WorkingTreeEdit,
	WorkingTreeEdits,
} from "../Services/working-tree-edits.js";
import { baseEnv, copyIndex } from "./folder-timeline-layer.js";

const GIT_TIMEOUT_MS = 10_000;

// The snapshot hashes without LFS's filters (folder-timeline-layer CONFIG), so its blobs are read back the same way.
const NO_LFS = [
	"-c",
	"filter.lfs.process=",
	"-c",
	"filter.lfs.clean=",
	"-c",
	"filter.lfs.smudge=",
	"-c",
	"filter.lfs.required=false",
];

const refuse = (reason: SessionDiffEditError["reason"], message: string) =>
	new SessionDiffEditError({ reason, message });

const stale = (path: string) =>
	refuse("stale", `${path} changed since it was listed`);

/** A folder-relative path as git lists one, so it cannot name anything outside the folder.
 *  An absolute path starts with an empty segment. */
const listable = (path: string) =>
	!path.includes("\n") &&
	path
		.split("/")
		.every((segment) => segment !== "" && segment !== "." && segment !== "..");

/**
 * One hunk of a one-file patch under that file's header, as the bytes git
 * printed. A header that renames, adds, deletes or changes the mode, a
 * symlink's, or a binary patch, has no hunk that applies on its own.
 */
const hunkPatch = ({ patch, notes }: SessionDiffPatch, index: number) => {
	const [header = "", ...hunks] = patch.split(/^(?=@@ )/m);
	const hunk = hunks[index];
	if (
		hunk === undefined ||
		/^(?:old|new|deleted|rename|copy|similarity|dissimilarity) |^index \S+ 120000$/m.test(
			header,
		)
	)
		return undefined;
	return Buffer.from(
		header + hunk,
		notes?.includes("latin1") ? "latin1" : "utf8",
	);
};

const fs = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => refuse("unavailable", String(cause)),
	});

const literal = (paths: readonly string[]) =>
	paths.map((path) => `:(literal)${path}`);

export const makeWorkingTreeEdits = Effect.gen(function* () {
	const subprocess = yield* Subprocess;
	const timeline = yield* FolderTimeline;
	const diff = yield* SessionDiff;
	const sessionGit = yield* SessionGit;
	const activity = yield* SessionActivityTag;
	// Edits are rare and short; one at a time across the daemon keeps every guard read fresh.
	const editing = yield* Semaphore.make(1);

	/** Git in the user's repository, with its own config, so filters run as in a terminal. */
	const git = (
		directory: string,
		args: readonly string[],
		{
			env = {},
			...options
		}: Pick<SubprocessOptions, "env" | "input" | "onStdout" | "maxBuffer"> = {},
	) =>
		subprocess
			.run("git", args, {
				cwd: directory,
				env: { ...baseEnv(), ...env },
				timeoutMs: GIT_TIMEOUT_MS,
				...options,
			})
			.pipe(
				Effect.mapError((error) =>
					refuse(
						error.reason === "timeout" ? "timeout" : "unavailable",
						error.message,
					),
				),
				Effect.flatMap(({ exitCode, stdout, stderr }) =>
					exitCode === 0
						? Effect.succeed(stdout)
						: Effect.fail(
								refuse("conflict", stderr.trim() || `git ${args[0]} failed`),
							),
				),
			);

	// 8.1 (2734): a session runs while the Run Ledger holds its active Run; SessionActivity reads it.
	const busy = (sessionId: string) =>
		Effect.suspend(() =>
			activity.background.activityOf(sessionId, { approvals: 0, questions: 0 })
				.foreground === "working"
				? Effect.fail(
						refuse("busy", "The agent is running; wait for it to finish"),
					)
				: Effect.void,
		);

	/**
	 * Re-reads the named paths now, never from a shared snapshot, which could
	 * predate another edit. The path must hold what the user saw and a renamed
	 * file's old path must still be gone. Answers which paths the index holds.
	 */
	const guard = (directory: string, edit: WorkingTreeEdit) =>
		Effect.gen(function* () {
			const paths = [edit.oldPath, edit.path].filter(
				(path) => path !== undefined,
			);
			const changed = stale(edit.path);
			if (!paths.every(listable)) return yield* changed;
			const snapshot = yield* timeline
				.snapshot(directory, paths)
				.pipe(
					Effect.mapError((error) =>
						error.reason === "timeout"
							? refuse("timeout", error.message)
							: changed,
					),
				);
			const { stdout } = yield* timeline
				.git(snapshot.store, ["cat-file", "--batch-check=%(objectname)"], {
					input: paths
						.flatMap((path) => [
							`${snapshot.worktree}:${snapshot.prefix}${path}`,
							`${snapshot.index}:${snapshot.prefix}${path}`,
						])
						.join("\n"),
				})
				.pipe(Effect.mapError(() => changed));
			const blobs = stdout
				.split("\n")
				.map((line) => (/^[0-9a-f]+$/.test(line) ? line : null));
			const worktree = (path: string) => blobs[paths.indexOf(path) * 2];
			if (
				worktree(edit.path) !== edit.expected ||
				(edit.oldPath !== undefined && worktree(edit.oldPath) !== null)
			)
				return yield* changed;
			return {
				store: snapshot.store,
				prefix: snapshot.prefix,
				paths,
				tracked: paths.filter((_, n) => blobs[n * 2 + 1] !== null),
			};
		});

	/** The hunk of the patch the user saw, from the listing it came from. */
	const hunkOf = (
		edit: WorkingTreeEdit,
		hunk: NonNullable<WorkingTreeEdit["hunk"]>,
	) =>
		diff
			.file({
				sessionId: edit.session.id,
				scope: { kind: "unstaged" },
				revision: hunk.revision,
				folder: edit.folder,
				path: edit.path,
				before: hunk.before,
				after: edit.expected,
			})
			.pipe(
				Effect.mapError((error) =>
					refuse(
						error.reason === "timeout" ? "timeout" : "stale",
						error.message,
					),
				),
				Effect.flatMap((patch) => {
					const bytes = hunkPatch(patch, hunk.index);
					return bytes
						? Effect.succeed(bytes)
						: Effect.fail(
								refuse(
									"conflict",
									`${edit.path} has no such hunk to apply alone`,
								),
							);
				}),
			);

	const noLongerApplies = (error: SessionDiffEditError) =>
		error.reason === "conflict"
			? refuse("conflict", "The hunk no longer applies, so nothing was written")
			: error;

	/** `git apply` checks the whole patch before it writes, so a refusal writes nothing. */
	const apply = (
		directory: string,
		prefix: string,
		patch: Buffer,
		args: readonly string[],
		env: NodeJS.ProcessEnv,
	) =>
		Effect.acquireUseRelease(
			fs(async () => {
				const file = join(tmpdir(), `conduit-hunk-${randomUUID()}.patch`);
				await writeFile(file, patch);
				return file;
			}),
			(file) =>
				git(
					directory,
					[
						"apply",
						...args,
						// The patch's paths are the folder's; git reads them from the repository root.
						...(prefix === "" ? [] : [`--directory=${prefix}`]),
						file,
					],
					{ env },
				).pipe(Effect.mapError(noLongerApplies)),
			(file) => Effect.promise(() => rm(file, { force: true })),
		);

	/**
	 * Git's own index lock is held while a copy of the index is edited, then the
	 * copy is renamed over it, so readers see the old index or the new one. A
	 * lock another git holds refuses the edit and stays its owner's.
	 */
	const swapIndex = (
		directory: string,
		write: (indexFile: string) => Effect.Effect<unknown, SessionDiffEditError>,
	) =>
		Effect.gen(function* () {
			const index = (yield* git(directory, [
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"index",
			])).trim();
			const lock = `${index}.lock`;
			const copy = `${index}.conduit-${randomUUID()}`;
			yield* Effect.acquireUseRelease(
				Effect.tryPromise({
					try: () => open(lock, "wx").then((handle) => handle.close()),
					catch: (cause) =>
						(cause as NodeJS.ErrnoException).code === "EEXIST"
							? refuse("conflict", "Another git process is using the index")
							: refuse("unavailable", String(cause)),
				}),
				() =>
					Effect.gen(function* () {
						// No index yet leaves no copy, which git reads as empty.
						yield* fs(() => copyIndex(index, copy)).pipe(Effect.ignore);
						yield* write(copy);
						yield* fs(() => rename(copy, index));
					}).pipe(
						Effect.ensuring(Effect.promise(() => rm(copy, { force: true }))),
					),
				() => Effect.promise(() => rm(lock, { force: true })),
			);
		});

	/**
	 * Moves the file out of reach in one rename, so a save after the guard is
	 * never what a discard deletes, then writes. The moved file must still hash
	 * to the blob the user saw, and it goes back if it does not or the write
	 * fails. A file saved at the path meanwhile keeps the path, and the moved
	 * one is kept where the refusal says. Uninterruptible, so it never stays hidden.
	 */
	const discardFile = (
		directory: string,
		path: string,
		expected: string,
		write: Effect.Effect<unknown, SessionDiffEditError>,
	) =>
		Effect.gen(function* () {
			const file = join(directory, path);
			const aside = (yield* git(directory, [
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				`conduit-discard-${randomUUID()}`,
			])).trim();
			yield* Effect.tryPromise({
				try: () => rename(file, aside),
				catch: (cause) =>
					(cause as NodeJS.ErrnoException).code === "ENOENT"
						? stale(path)
						: refuse("unavailable", String(cause)),
			});
			// Git hashes a symlink's target text, and link() would follow one.
			const target = (yield* fs(() => lstat(aside))).isSymbolicLink()
				? yield* fs(() => readlink(aside))
				: undefined;
			const putBack = fs(() =>
				target === undefined ? link(aside, file) : symlink(target, file),
			).pipe(
				Effect.andThen(fs(() => rm(aside))),
				Effect.mapError(() =>
					refuse(
						"conflict",
						`${path} changed since it was listed; what was there is kept at ${aside}`,
					),
				),
			);
			yield* Effect.gen(function* () {
				const blob = yield* git(
					directory,
					target === undefined
						? ["hash-object", `--path=${path}`, aside]
						: ["hash-object", "--no-filters", "--stdin"],
					target === undefined ? {} : { input: target },
				).pipe(Effect.orElseSucceed(() => ""));
				if (blob.trim() !== expected) return yield* stale(path);
				yield* write;
			}).pipe(
				Effect.catch((error) => Effect.andThen(putBack, Effect.fail(error))),
			);
			yield* fs(() => rm(aside, { force: true }));
		}).pipe(Effect.uninterruptible);

	/**
	 * The blob the user saw with one hunk reversed, as working-tree bytes. The
	 * patch applies in a scratch folder outside any repository, and the result
	 * goes through the folder's filters from a scratch object store, so the live
	 * file is never read and the repository is never written.
	 */
	const reversed = (
		directory: string,
		{ store, prefix }: { readonly store: string; readonly prefix: string },
		path: string,
		seen: string,
		patch: Buffer,
	) =>
		Effect.acquireUseRelease(
			fs(() => mkdtemp(join(tmpdir(), "conduit-hunk-"))),
			(scratch) =>
				Effect.gen(function* () {
					const bytes: Buffer[] = [];
					yield* timeline
						.git(store, ["cat-file", "blob", seen], {
							onStdout: (chunk) => bytes.push(chunk),
						})
						.pipe(Effect.mapError(() => stale(path)));
					const file = join(scratch, "tree", path);
					const objects = join(scratch, "objects");
					yield* fs(async () => {
						await mkdir(dirname(file), { recursive: true });
						await mkdir(objects);
						await writeFile(file, Buffer.concat(bytes));
						await writeFile(join(scratch, "hunk.patch"), patch);
					});
					yield* git(
						join(scratch, "tree"),
						["apply", "-R", join(scratch, "hunk.patch")],
						{ env: { GIT_CEILING_DIRECTORIES: dirname(scratch) } },
					).pipe(Effect.mapError(noLongerApplies));
					const env = { GIT_OBJECT_DIRECTORY: objects };
					const blob = (yield* git(
						directory,
						["hash-object", "-w", "--no-filters", file],
						{ env },
					)).trim();
					const content: Buffer[] = [];
					// cat-file's --path is from the repository root; hash-object's is from the folder.
					yield* git(
						directory,
						[
							...NO_LFS,
							"cat-file",
							"--filters",
							`--path=${prefix}${path}`,
							blob,
						],
						{
							env,
							onStdout: (chunk) => content.push(chunk),
							// A file with hunks is under the listing's size cap; line-ending filters can double it.
							maxBuffer: 2 * SESSION_DIFF_TOO_LARGE_BYTES,
						},
					);
					return Buffer.concat(content);
				}),
			(scratch) =>
				Effect.promise(() => rm(scratch, { recursive: true, force: true })),
		);

	/**
	 * Renames `content` over the file only while the file is still the one the
	 * user saw: a regular file, inside the folder, hashing to `seen`, with the
	 * same stat as when it was hashed. The temp file sits beside it with its
	 * mode, so the rename is atomic and keeps the mode. The last look and the
	 * rename are back-to-back syscalls; nothing in this process runs between them.
	 */
	const replace = (
		directory: string,
		path: string,
		seen: string,
		content: Buffer,
	) =>
		Effect.gen(function* () {
			const file = join(directory, path);
			const parent = join(yield* fs(() => realpath(directory)), dirname(path));
			const hashed = lstatSync(file, { bigint: true, throwIfNoEntry: false });
			if (!hashed?.isFile()) return yield* stale(path);
			const blob = yield* git(directory, [
				...NO_LFS,
				"hash-object",
				`--path=${path}`,
				file,
			]).pipe(Effect.orElseSucceed(() => ""));
			if (blob.trim() !== seen) return yield* stale(path);
			const temp = join(
				dirname(file),
				`.${basename(file)}.conduit-${randomUUID()}`,
			);
			const mode = Number(hashed.mode & 0o7777n);
			yield* Effect.gen(function* () {
				yield* fs(async () => {
					const handle = await open(temp, "wx", mode);
					try {
						await handle.writeFile(content);
						await handle.chmod(mode);
						await handle.sync();
					} finally {
						await handle.close();
					}
				});
				const unchanged = yield* Effect.try({
					try: () => {
						const now = lstatSync(file, {
							bigint: true,
							throwIfNoEntry: false,
						});
						if (
							!now ||
							now.dev !== hashed.dev ||
							now.ino !== hashed.ino ||
							now.mode !== hashed.mode ||
							now.size !== hashed.size ||
							now.mtimeNs !== hashed.mtimeNs ||
							now.ctimeNs !== hashed.ctimeNs ||
							realpathSync.native(dirname(file)) !== parent
						)
							return false;
						renameSync(temp, file);
						return true;
					},
					catch: (cause) => refuse("unavailable", String(cause)),
				});
				if (!unchanged) return yield* stale(path);
			}).pipe(Effect.ensuring(Effect.promise(() => rm(temp, { force: true }))));
		});

	const edit =
		(
			write: (
				directory: string,
				request: WorkingTreeEdit,
				guarded: Effect.Success<ReturnType<typeof guard>>,
			) => Effect.Effect<unknown, SessionDiffEditError>,
		) =>
		(request: WorkingTreeEdit) =>
			Effect.gen(function* () {
				const folder = request.session.folders.find(
					(candidate) => candidate.root === request.folder && candidate.present,
				);
				if (!folder)
					return yield* refuse(
						"unavailable",
						"That folder is not one of this session's",
					);
				yield* Effect.gen(function* () {
					const guarded = yield* guard(folder.directory, request);
					// After the guard's git reads, so a turn that starts during them refuses the edit.
					yield* busy(request.session.id);
					yield* write(folder.directory, request, guarded);
				}).pipe(editing.withPermits(1));
				yield* sessionGit.invalidate({ sessionId: request.session.id });
			});

	return {
		discard: edit((directory, request, guarded) => {
			const { expected, hunk } = request;
			if (hunk)
				return expected === null
					? refuse(
							"conflict",
							`${request.path} has no such hunk to apply alone`,
						)
					: hunkOf(request, hunk).pipe(
							Effect.flatMap((patch) =>
								reversed(directory, guarded, request.path, expected, patch),
							),
							Effect.flatMap((content) =>
								replace(directory, request.path, expected, content),
							),
						);
			const { tracked } = guarded;
			// Without --force git writes only paths that are absent, so a file saved since stays.
			const checkout =
				tracked.length === 0
					? Effect.void
					: git(directory, ["checkout-index", "-z", "--stdin"], {
							input: tracked.join("\0"),
						}).pipe(
							Effect.mapError((error) =>
								error.reason === "conflict" ? stale(request.path) : error,
							),
						);
			return expected === null
				? checkout
				: discardFile(directory, request.path, expected, checkout);
		}),
		stage: edit((directory, request, { prefix, paths }) =>
			request.hunk
				? Effect.flatMap(hunkOf(request, request.hunk), (patch) =>
						swapIndex(directory, (index) =>
							apply(directory, prefix, patch, ["--cached"], {
								GIT_INDEX_FILE: index,
							}),
						),
					)
				: swapIndex(directory, (index) =>
						Effect.gen(function* () {
							const env = { GIT_INDEX_FILE: index };
							yield* git(directory, ["add", "--all", "--", ...literal(paths)], {
								env,
							});
							// git add read the file again; a save since the guard leaves the index untouched.
							const staged = new Map(
								(yield* git(
									directory,
									["ls-files", "--stage", "-z", "--", ...literal(paths)],
									{ env },
								))
									.split("\0")
									.filter((entry) => entry !== "")
									.map((entry) => {
										const [meta = "", path] = entry.split("\t");
										return [path, meta.split(" ")[1]];
									}),
							);
							if (
								(staged.get(request.path) ?? null) !== request.expected ||
								(request.oldPath !== undefined && staged.has(request.oldPath))
							)
								return yield* stale(request.path);
						}),
					),
		),
	} satisfies WorkingTreeEdits["Service"];
});
