import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import {
	SessionDiffEditError,
	type SessionDiffPatch,
} from "../../../contracts/session-diff.js";
import { FolderTimeline } from "../Services/folder-timeline.js";
import { SessionDiff } from "../Services/session-diff.js";
import { SessionGit } from "../Services/session-git.js";
import { Subprocess } from "../Services/subprocess.js";
import type {
	WorkingTreeEdit,
	WorkingTreeEdits,
} from "../Services/working-tree-edits.js";
import { baseEnv, copyIndex } from "./folder-timeline-layer.js";

const GIT_TIMEOUT_MS = 10_000;

const refuse = (reason: SessionDiffEditError["reason"], message: string) =>
	new SessionDiffEditError({ reason, message });

/** A folder-relative path as git lists one, so it cannot name anything outside the folder. */
const listable = (path: string) =>
	!isAbsolute(path) &&
	!path.includes("\n") &&
	path
		.split("/")
		.every((segment) => segment !== "" && segment !== "." && segment !== "..");

/**
 * One hunk of a one-file patch under that file's header, as the bytes git
 * printed. A header that renames, adds, deletes or changes the mode, or a
 * binary patch, has no hunk that applies on its own.
 */
const hunkPatch = ({ patch, notes }: SessionDiffPatch, index: number) => {
	const [header = "", ...hunks] = patch.split(/^(?=@@ )/m);
	const hunk = hunks[index];
	if (
		hunk === undefined ||
		/^(?:old|new|deleted|rename|copy|similarity|dissimilarity) /m.test(header)
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
	const sql = yield* SqlClient.SqlClient;
	// Edits are rare and short; one at a time across the daemon keeps every guard read fresh.
	const editing = yield* Semaphore.make(1);

	/** Git in the user's repository, with its own config, so filters run as in a terminal. */
	const git = (
		directory: string,
		args: readonly string[],
		env: NodeJS.ProcessEnv = {},
		input?: string,
	) =>
		subprocess
			.run("git", args, {
				cwd: directory,
				env: { ...baseEnv(), ...env },
				timeoutMs: GIT_TIMEOUT_MS,
				...(input === undefined ? {} : { input }),
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

	const busy = (sessionId: string) =>
		sql<{
			status: string;
		}>`SELECT status FROM sessions WHERE id = ${sessionId}`.pipe(
			Effect.mapError((error) => refuse("unavailable", error.message)),
			Effect.flatMap(([row]) =>
				row?.status === "busy" || row?.status === "retry"
					? Effect.fail(
							refuse("busy", "The agent is running; wait for it to finish"),
						)
					: Effect.void,
			),
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
			const stale = refuse("stale", `${edit.path} changed since it was listed`);
			if (!paths.every(listable)) return yield* stale;
			const snapshot = yield* timeline
				.snapshot(directory, paths)
				.pipe(
					Effect.mapError((error) =>
						error.reason === "timeout"
							? refuse("timeout", error.message)
							: stale,
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
				.pipe(Effect.mapError(() => stale));
			const blobs = stdout
				.split("\n")
				.map((line) => (/^[0-9a-f]+$/.test(line) ? line : null));
			const worktree = (path: string) => blobs[paths.indexOf(path) * 2];
			if (
				worktree(edit.path) !== edit.expected ||
				(edit.oldPath !== undefined && worktree(edit.oldPath) !== null)
			)
				return yield* stale;
			return {
				prefix: snapshot.prefix,
				paths,
				tracked: paths.filter((_, n) => blobs[n * 2 + 1] !== null),
				untracked: paths.filter((_, n) => blobs[n * 2 + 1] === null),
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

	/** `git apply` checks the whole patch before it writes, so a refusal writes nothing. */
	const apply = (
		directory: string,
		prefix: string,
		patch: Buffer,
		args: readonly string[],
		env?: NodeJS.ProcessEnv,
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
					env,
				),
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
					yield* busy(request.session.id);
					const guarded = yield* guard(folder.directory, request);
					yield* write(folder.directory, request, guarded);
				}).pipe(editing.withPermits(1));
				yield* sessionGit.invalidate({ sessionId: request.session.id });
			});

	return {
		discard: edit((directory, request, { prefix, tracked, untracked }) =>
			request.hunk
				? Effect.flatMap(hunkOf(request, request.hunk), (patch) =>
						apply(directory, prefix, patch, ["-R"]),
					)
				: Effect.gen(function* () {
						if (tracked.length > 0)
							yield* git(
								directory,
								["checkout-index", "--force", "-z", "--stdin"],
								{},
								tracked.join("\0"),
							);
						for (const path of untracked)
							yield* fs(() => rm(join(directory, path)));
					}),
		),
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
						git(directory, ["add", "--all", "--", ...literal(paths)], {
							GIT_INDEX_FILE: index,
						}),
					),
		),
	} satisfies WorkingTreeEdits["Service"];
});
