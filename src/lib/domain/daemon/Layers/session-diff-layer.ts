import { createHash } from "node:crypto";
import { Effect, Fiber, PubSub, Semaphore, Stream } from "effect";
import {
	SESSION_DIFF_AUTO_LINES,
	SESSION_DIFF_TOO_LARGE_BYTES,
	type SessionDiffBase,
	SessionDiffError,
	type SessionDiffFile,
	type SessionDiffFolder,
	type SessionDiffListing,
	type SessionDiffScope,
} from "../../../contracts/session-diff.js";
import {
	type FolderSnapshot,
	FolderTimeline,
	type FolderTimelineError,
} from "../Services/folder-timeline.js";
import type {
	SessionDiff,
	SessionDiffSession,
	SessionDiffFolder as SessionFolder,
} from "../Services/session-diff.js";
import { SessionGit } from "../Services/session-git.js";
import type { SubprocessResult } from "../Services/subprocess.js";

const MEMO_LIMIT = 64;
const STATUS = {
	A: "added",
	D: "deleted",
	M: "modified",
	R: "renamed",
	T: "typeChanged",
} as const satisfies Record<string, SessionDiffFile["status"]>;

interface Change {
	readonly status: SessionDiffFile["status"];
	readonly before: string | null;
	readonly after: string | null;
	readonly path: string;
	readonly oldPath?: string;
}

const blob = (id: string | undefined) =>
	id === undefined || /^0+$/.test(id) ? null : id;

/** `diff-tree -z --raw --numstat` prints every raw record, then every numstat record. */
export function parseDiffTree(output: string) {
	const tokens = output.split("\0");
	let at = 0;
	const next = () => tokens[at++] ?? "";
	const changes: Change[] = [];
	while (tokens[at]?.startsWith(":")) {
		const [, , before, after, letter = "M"] = next().split(" ");
		// Renames and copies name their source before their destination.
		const oldPath = /^[RC]/.test(letter) ? next() : undefined;
		changes.push({
			status: STATUS[letter[0] as keyof typeof STATUS] ?? "modified",
			before: blob(before),
			after: blob(after),
			path: next(),
			...(oldPath === undefined ? {} : { oldPath }),
		});
	}
	return changes.map((change) => {
		const [insertions = "-", deletions = "-", path] = next().split("\t");
		// A rename's numstat leaves its path empty and lists both paths after it.
		if (path === "") at += 2;
		return {
			...change,
			insertions: Number(insertions) || 0,
			deletions: Number(deletions) || 0,
			binary: insertions === "-",
		};
	});
}

/** A failed command reads as absent; a timeout still fails the folder. */
const output = (effect: Effect.Effect<SubprocessResult, FolderTimelineError>) =>
	effect.pipe(
		Effect.map(({ stdout }) => stdout.trim() || null),
		Effect.catch((error) =>
			error.reason === "timeout" ? Effect.fail(error) : Effect.succeed(null),
		),
	);

type Listed =
	| {
			readonly folder: string;
			readonly snapshot: FolderSnapshot;
			/** The tree-ish the snapshot's working tree is compared against. */
			readonly from: string;
			readonly base?: SessionDiffBase;
			readonly files: readonly SessionDiffFile[];
	  }
	| Extract<SessionDiffFolder, { readonly error: unknown }>;

export const makeSessionDiff = Effect.gen(function* () {
	const timeline = yield* FolderTimeline;
	const git = yield* SessionGit;
	const layerScope = yield* Effect.scope;
	const memo = new Map<
		string,
		{
			readonly sessionId: string;
			readonly scope: string;
			readonly listing: SessionDiffListing;
			readonly folders: ReadonlyMap<
				string,
				{
					readonly snapshot: FolderSnapshot;
					readonly from: string;
					readonly files: ReadonlyMap<string, SessionDiffFile>;
				}
			>;
		}
	>();
	// One per subscribed (session, folders, scope): the only thing that snapshots on a change.
	interface Hub {
		readonly revisions: PubSub.PubSub<string>;
		watcher?: Fiber.Fiber<void>;
		latest?: string;
		subscribers: number;
	}
	const live = new Map<string, Hub>();
	const joining = yield* Semaphore.make(1);

	const relative = (snapshot: FolderSnapshot) =>
		snapshot.prefix === "" ? [] : [`--relative=${snapshot.prefix}`];

	/** Override, then launch base, then default branch, then HEAD; the first with a merge-base wins. */
	const branchBase = (
		folder: SessionFolder,
		snapshot: FolderSnapshot,
		override: string | null,
	) =>
		Effect.gen(function* () {
			const git = (...args: string[]) =>
				output(timeline.folderGit(folder.directory, args));
			const verify = (ref: string) =>
				git("rev-parse", "--verify", "--quiet", "--end-of-options", ref);
			let fallback: SessionDiffBase["fallback"];
			const attempt = (ref: string, source: SessionDiffBase["source"]) =>
				Effect.gen(function* () {
					const commit = yield* verify(`${ref}^{commit}`);
					const mergeBase =
						commit && (yield* git("merge-base", commit, "HEAD"));
					if (mergeBase)
						return {
							from: mergeBase,
							base: { ref, source, ...(fallback ? { fallback } : {}) },
						};
					fallback ??= {
						wanted: ref,
						reason: !commit
							? "missing"
							: (yield* git("rev-parse", "--is-shallow-repository")) === "true"
								? "shallow"
								: "unrelated",
					};
					return undefined;
				});
			const wanted = [
				override === null ? undefined : attempt(override, "override"),
				folder.launchBase === undefined
					? undefined
					: attempt(folder.launchBase, "launch"),
				// origin/HEAD can name a branch the remote has since renamed, so each default gets its try.
				...[
					git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"),
					verify("refs/heads/main").pipe(
						Effect.map((found) => found && "main"),
					),
					verify("refs/heads/master").pipe(
						Effect.map((found) => found && "master"),
					),
				].map((ref) =>
					Effect.flatMap(ref, (found) =>
						found === null ? Effect.undefined : attempt(found, "default"),
					),
				),
			];
			for (const effect of wanted) {
				const resolved = effect && (yield* effect);
				if (resolved) return resolved;
			}
			// An unborn HEAD compares against the empty tree, so everything shows as added.
			const head =
				(yield* verify("HEAD")) ??
				(yield* timeline.git(
					snapshot.store,
					["hash-object", "-t", "tree", "--stdin"],
					{ input: "" },
				)).stdout.trim();
			return {
				from: head,
				base: {
					ref: "HEAD",
					source: "head",
					...(fallback ? { fallback } : {}),
				} satisfies SessionDiffBase,
			};
		});

	const listFiles = (snapshot: FolderSnapshot, from: string) =>
		Effect.gen(function* () {
			const { stdout } = yield* timeline.git(snapshot.store, [
				"-c",
				"core.bigFileThreshold=1m",
				"diff-tree",
				"-r",
				"-z",
				"-M",
				"--raw",
				"--numstat",
				...relative(snapshot),
				from,
				snapshot.worktree,
			]);
			const changes = parseDiffTree(stdout);
			const ids = [
				...new Set(
					changes.flatMap(({ before, after }) =>
						[before, after].filter((id) => id !== null),
					),
				),
			];
			const sizes = new Map<string, number>();
			if (ids.length > 0) {
				const batch = yield* timeline.git(
					snapshot.store,
					[
						"cat-file",
						"--batch-check=%(objectname) %(objecttype) %(objectsize)",
					],
					{ input: `${ids.join("\n")}\n` },
				);
				for (const line of batch.stdout.split("\n")) {
					const [id, type, size] = line.split(" ");
					if (id && type === "blob") sizes.set(id, Number(size));
				}
			}
			return changes.map(
				({ insertions, deletions, binary, before, after, ...change }) => {
					const bytes = Math.max(
						before === null ? 0 : (sizes.get(before) ?? 0),
						after === null ? 0 : (sizes.get(after) ?? 0),
					);
					const base = { ...change, before, after, bytes };
					if (bytes > SESSION_DIFF_TOO_LARGE_BYTES)
						return { ...base, tier: "tooLarge" as const };
					return {
						...base,
						tier:
							!binary && insertions + deletions > SESSION_DIFF_AUTO_LINES
								? ("onDemand" as const)
								: ("auto" as const),
						insertions,
						deletions,
						binary,
					};
				},
			);
		});

	const listFolder = (folder: SessionFolder, scope: SessionDiffScope) =>
		Effect.gen(function* (): Effect.fn.Return<Listed, FolderTimelineError> {
			if (!folder.present)
				return {
					folder: folder.root,
					error: "unavailable" as const,
					message: `Folder is missing: ${folder.directory}`,
				};
			const snapshot = yield* timeline.snapshot(folder.directory);
			const compared =
				scope.kind === "branch"
					? yield* branchBase(folder, snapshot, scope.base)
					: { from: snapshot.index };
			return {
				folder: folder.root,
				snapshot,
				...compared,
				files: yield* listFiles(snapshot, compared.from),
			};
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed<Listed>({
					folder: folder.root,
					error:
						error.reason === "timeout"
							? ("timeout" as const)
							: ("unavailable" as const),
					message: error.message,
				}),
			),
		);

	/** The listing a revision names, if this (session, scope) made it. */
	const recall = (sessionId: string, scopeKey: string, revision?: string) => {
		const remembered = revision === undefined ? undefined : memo.get(revision);
		return remembered?.sessionId === sessionId && remembered.scope === scopeKey
			? remembered.listing
			: undefined;
	};

	const list: SessionDiff["Service"]["list"] = (session, scope, revision) =>
		Effect.gen(function* () {
			const scopeKey = JSON.stringify(scope);
			const recalled = recall(session.id, scopeKey, revision);
			if (recalled) return recalled;
			const folders = yield* Effect.forEach(
				session.folders,
				(folder) => listFolder(folder, scope),
				{ concurrency: "unbounded" },
			);
			const listed = createHash("sha256")
				.update(
					JSON.stringify([
						session.id,
						scopeKey,
						folders.map((folder) =>
							"snapshot" in folder
								? [folder.folder, folder.snapshot, folder.from, folder.base]
								: [folder.folder, folder.error, folder.message],
						),
					]),
				)
				.digest("hex")
				.slice(0, 32);
			const listing = {
				revision: listed,
				folders: folders.map(
					(folder): SessionDiffFolder =>
						"snapshot" in folder
							? {
									folder: folder.folder,
									files: folder.files,
									...(folder.base ? { base: folder.base } : {}),
								}
							: folder,
				),
			} satisfies SessionDiffListing;
			memo.delete(listed);
			memo.set(listed, {
				sessionId: session.id,
				scope: scopeKey,
				listing,
				folders: new Map(
					folders.flatMap((folder) =>
						"snapshot" in folder
							? [
									[
										folder.folder,
										{
											snapshot: folder.snapshot,
											from: folder.from,
											files: new Map(
												folder.files.map((file) => [file.path, file]),
											),
										},
									],
								]
							: [],
					),
				),
			});
			for (const stale of memo.keys()) {
				if (memo.size <= MEMO_LIMIT) break;
				memo.delete(stale);
			}
			return listing;
		});

	/**
	 * Lists once on opening, then once per change, keeping at most one change waiting
	 * behind a running list. A change published before the feed opens precedes the
	 * first snapshot, so that list already sees it.
	 */
	const watch = (
		session: SessionDiffSession,
		scope: SessionDiffScope,
		hub: Hub,
	) =>
		git.changes.pipe(
			Stream.filter((change) => change.sessionIds.includes(session.id)),
			Stream.merge(Stream.make(undefined)),
			Stream.buffer({ capacity: 1, strategy: "sliding" }),
			Stream.runForEach(() =>
				Effect.flatMap(list(session, scope), ({ revision }) => {
					if (revision === hub.latest) return Effect.void;
					hub.latest = revision;
					return PubSub.publish(hub.revisions, revision);
				}),
			),
		);

	return {
		list,
		changes: (session, scope) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const key = JSON.stringify([session, scope]);
					// Joining is uninterruptible and registers leaving, so no join outlives its viewer.
					const hub = yield* Effect.acquireRelease(
						joining.withPermits(1)(
							Effect.gen(function* () {
								const open = live.get(key);
								if (open) {
									open.subscribers += 1;
									return open;
								}
								// A subscriber only needs the newest revision.
								const opened: Hub = {
									revisions: yield* PubSub.sliding<string>(1),
									subscribers: 1,
								};
								opened.watcher = yield* watch(session, scope, opened).pipe(
									Effect.forkIn(layerScope),
								);
								live.set(key, opened);
								return opened;
							}),
						),
						(hub) =>
							joining.withPermits(1)(
								Effect.suspend(() => {
									hub.subscribers -= 1;
									if (hub.subscribers > 0) return Effect.void;
									live.delete(key);
									return Effect.andThen(
										hub.watcher ? Fiber.interrupt(hub.watcher) : Effect.void,
										PubSub.shutdown(hub.revisions),
									);
								}),
							),
					);
					const subscription = yield* PubSub.subscribe(hub.revisions);
					// A joiner starts from the hub's revision; one published meanwhile repeats it.
					return Stream.concat(
						hub.latest === undefined ? Stream.empty : Stream.make(hub.latest),
						Stream.fromSubscription(subscription),
					).pipe(Stream.changes);
				}),
			),
		file: (request) =>
			Effect.gen(function* () {
				const listed = memo.get(request.revision);
				if (!listed)
					return yield* new SessionDiffError({
						reason: "gone",
						message: "The listing is no longer available",
					});
				const folder =
					listed.sessionId === request.sessionId &&
					listed.scope === JSON.stringify(request.scope)
						? listed.folders.get(request.folder)
						: undefined;
				const file = folder?.files.get(request.path);
				if (
					!folder ||
					!file ||
					file.before !== request.before ||
					file.after !== request.after
				)
					return yield* new SessionDiffError({
						reason: "not-listed",
						message: `${request.path} is not in the listing`,
					});
				if (file.tier === "tooLarge")
					return yield* new SessionDiffError({
						reason: "too-large",
						message: `${request.path} is too large to diff`,
					});
				const { snapshot, from } = folder;
				const { stdout } = yield* timeline
					.git(snapshot.store, [
						"diff-tree",
						"-p",
						"-M",
						...relative(snapshot),
						from,
						snapshot.worktree,
						"--",
						...[file.oldPath, file.path].flatMap((path) =>
							// Literal, so a name like `[id].ts` cannot match other files.
							path === undefined ? [] : [`:(literal)${snapshot.prefix}${path}`],
						),
					])
					.pipe(
						Effect.mapError(
							(error) =>
								new SessionDiffError({
									reason: error.reason === "timeout" ? "timeout" : "gone",
									message: error.message,
								}),
						),
					);
				return { patch: stdout };
			}),
	} satisfies SessionDiff["Service"];
});
