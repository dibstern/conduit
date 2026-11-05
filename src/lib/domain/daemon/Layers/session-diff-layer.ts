import { isUtf8 } from "node:buffer";
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
	type SessionDiffPatch,
	type SessionDiffScope,
} from "../../../contracts/session-diff.js";
import type { RunChangesCaptured } from "../../../contracts/stored-event.js";
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
import { listToolCall } from "./session-diff-tool-call.js";

const MEMO_LIMIT = 64;
const STATUS = {
	A: "added",
	D: "deleted",
	M: "modified",
	R: "renamed",
	T: "typeChanged",
} as const satisfies Record<string, SessionDiffFile["status"]>;
/** Git modes whose entry is not a regular file's text. */
const KIND: Readonly<Record<string, "submodule" | "symlink" | undefined>> = {
	"160000": "submodule",
	"120000": "symlink",
};

interface Change {
	readonly status: SessionDiffFile["status"];
	readonly before: string | null;
	readonly after: string | null;
	readonly path: string;
	readonly oldPath?: string;
	readonly kind?: SessionDiffFile["kind"];
	readonly mode?: SessionDiffFile["mode"];
}

const blob = (id: string | undefined) =>
	id === undefined || /^0+$/.test(id) ? null : id;

/** A raw record's modes as the file's kind, and its mode change when both sides exist (a missing side's mode is all zeros). */
const modes = (before = "", after = "") => {
	const kind = KIND[after] ?? KIND[before];
	return {
		...(kind === undefined ? {} : { kind }),
		...(before !== after && blob(before) && blob(after)
			? { mode: { before, after } }
			: {}),
	};
};

/** A captured change whose content was evicted: its record, without bytes or a patch. */
const prunedFile = (
	change: Extract<
		RunChangesCaptured["folders"][number],
		{ readonly changes: unknown }
	>["changes"][number],
): SessionDiffFile => {
	const { before, after } = change;
	const status =
		before === null
			? "added"
			: after === null
				? "deleted"
				: before.mode.slice(0, 2) === after.mode.slice(0, 2)
					? "modified"
					: "typeChanged";
	return {
		path: change.path,
		status,
		before: before?.blob ?? null,
		after: after?.blob ?? null,
		...modes(before?.mode, after?.mode),
		tier: "pruned",
		...(change.insertions === undefined
			? {}
			: { insertions: change.insertions, deletions: change.deletions ?? 0 }),
	};
};

/** `diff-tree -z --raw --numstat` prints every raw record, then every numstat record. */
export function parseDiffTree(output: string) {
	const tokens = output.split("\0");
	let at = 0;
	const next = () => tokens[at++] ?? "";
	const changes: Change[] = [];
	while (tokens[at]?.startsWith(":")) {
		const [beforeMode, afterMode, before, after, letter = "M"] = next()
			.slice(1)
			.split(" ");
		// Renames and copies name their source before their destination.
		const oldPath = /^[RC]/.test(letter) ? next() : undefined;
		changes.push({
			status: STATUS[letter[0] as keyof typeof STATUS] ?? "modified",
			before: blob(before),
			after: blob(after),
			path: next(),
			...(oldPath === undefined ? {} : { oldPath }),
			...modes(beforeMode, afterMode),
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
			readonly shared?: true;
	  }
	/** A tool call's files, with the patches its Tool File Changes carried. */
	| {
			readonly folder: string;
			readonly files: readonly SessionDiffFile[];
			readonly patches: ReadonlyMap<string, SessionDiffPatch>;
	  }
	| Extract<SessionDiffFolder, { readonly error: unknown }>;

/** What file() needs to serve a listed folder's patches again. */
type MemoFolder = (
	| { readonly snapshot: FolderSnapshot; readonly from: string }
	| { readonly patches: ReadonlyMap<string, SessionDiffPatch> }
) & { readonly files: ReadonlyMap<string, SessionDiffFile> };

/** What a listed folder's revision hashes. */
const revisionOf = (folder: Listed) => {
	if ("snapshot" in folder)
		return [folder.folder, folder.snapshot, folder.from, folder.base];
	// A tool call's notes can change with its capture while its files do not.
	if ("files" in folder)
		return [folder.folder, folder.files, [...folder.patches]];
	return [folder.folder, folder.error, folder.message];
};

const listingOf = (folder: Listed): SessionDiffFolder => {
	if ("snapshot" in folder)
		return {
			folder: folder.folder,
			files: folder.files,
			...(folder.base ? { base: folder.base } : {}),
			...(folder.shared ? { shared: true as const } : {}),
		};
	if ("files" in folder) return { folder: folder.folder, files: folder.files };
	return folder;
};

const memoOf = (folder: Listed): (readonly [string, MemoFolder])[] => {
	if (!("files" in folder)) return [];
	const files = new Map(folder.files.map((file) => [file.path, file]));
	return [
		[
			folder.folder,
			"snapshot" in folder
				? { snapshot: folder.snapshot, from: folder.from, files }
				: { patches: folder.patches, files },
		],
	];
};

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
			readonly folders: ReadonlyMap<string, MemoFolder>;
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

	const blobSizes = (snapshot: FolderSnapshot, changes: readonly Change[]) => {
		const ids = [
			...new Set(
				changes.flatMap(({ before, after }) =>
					[before, after].filter((id) => id !== null),
				),
			),
		];
		return timeline
			.git(
				snapshot.store,
				["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
				{ input: `${ids.join("\n")}\n` },
			)
			.pipe(
				Effect.map(
					({ stdout }) =>
						new Map<string | null, number>(
							stdout.split("\n").flatMap((line) => {
								const [id, type, size] = line.split(" ");
								return id && type === "blob"
									? [[id, Number(size)] as const]
									: [];
							}),
						),
				),
			);
	};

	/** The worktree tree's attributes name LFS files, whichever side is a pointer. */
	const lfsPaths = (snapshot: FolderSnapshot, changes: readonly Change[]) => {
		const paths = changes.flatMap(({ kind, path }) =>
			kind === undefined ? [path] : [],
		);
		return timeline
			.git(
				snapshot.store,
				[
					"check-attr",
					`--source=${snapshot.worktree}`,
					"-z",
					"--stdin",
					"filter",
				],
				{
					input: paths.map((path) => `${snapshot.prefix}${path}\0`).join(""),
				},
			)
			.pipe(
				// Each path prints path, attribute and value, in input order.
				Effect.map(({ stdout }) => {
					const tokens = stdout.split("\0");
					return new Set(paths.filter((_, n) => tokens[n * 3 + 2] === "lfs"));
				}),
				// Only a label: git before 2.40 has no --source, and lists without it.
				Effect.orElseSucceed(() => new Set<string>()),
			);
	};

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
			if (changes.length === 0) return [];
			const [sizes, lfs] = yield* Effect.all(
				[blobSizes(snapshot, changes), lfsPaths(snapshot, changes)],
				{ concurrency: "unbounded" },
			);
			return changes.map(
				({ insertions, deletions, binary, before, after, ...change }) => {
					const bytes = Math.max(sizes.get(before) ?? 0, sizes.get(after) ?? 0);
					const base = {
						...change,
						...(lfs.has(change.path) ? { kind: "lfs" as const } : {}),
						before,
						after,
						bytes,
					};
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

	const unavailable = (folder: string) => (error: FolderTimelineError) =>
		Effect.succeed<Listed>({
			folder,
			error: error.reason === "timeout" ? "timeout" : "unavailable",
			message: error.message,
		});

	/**
	 * A turn lists its run's capture: each changed path before and after, from
	 * the session's store. A pruned capture lists its record's paths and counts.
	 */
	const listTurn = (session: SessionDiffSession, capture: RunChangesCaptured) =>
		Effect.forEach(
			capture.folders,
			(captured) => {
				const folder =
					session.folders.find(
						({ directory }) => directory === captured.directory,
					)?.root ?? captured.directory;
				if ("gap" in captured)
					return Effect.succeed<Listed>({
						folder,
						error: captured.gap === "timeout" ? "timeout" : "unavailable",
						message: captured.message,
					});
				if (session.pruned)
					return Effect.succeed<Listed>({
						folder,
						files: captured.changes.map(prunedFile),
						patches: new Map(),
					});
				const snapshot = {
					store: timeline.sessionStore(session.id),
					prefix: "",
					index: captured.before,
					worktree: captured.after,
				};
				return listFiles(snapshot, captured.before).pipe(
					Effect.map(
						(files): Listed => ({
							folder,
							snapshot,
							from: captured.before,
							files,
							...(captured.shared ? { shared: true as const } : {}),
						}),
					),
					Effect.catch(unavailable(folder)),
				);
			},
			{ concurrency: "unbounded" },
		);

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
		}).pipe(Effect.catch(unavailable(folder.root)));

	/** The listing a revision names, if this (session, scope) made it. */
	const recall = (sessionId: string, scopeKey: string, revision?: string) => {
		const remembered = revision === undefined ? undefined : memo.get(revision);
		return remembered?.sessionId === sessionId && remembered.scope === scopeKey
			? remembered.listing
			: undefined;
	};

	/** A tool call's own changes, a turn's capture, or each folder's git diff. */
	const listScope = (session: SessionDiffSession, scope: SessionDiffScope) =>
		Effect.gen(function* () {
			if (scope.kind === "toolCall")
				return listToolCall(
					session.folders,
					session.toolCall?.changes ?? [],
					session.capture,
				);
			if (scope.kind === "turn")
				return session.capture ? yield* listTurn(session, session.capture) : [];
			return yield* Effect.forEach(
				session.folders,
				(folder) => listFolder(folder, scope),
				{ concurrency: "unbounded" },
			);
		});

	const list: SessionDiff["Service"]["list"] = (session, scope, revision) =>
		Effect.gen(function* () {
			const scopeKey = JSON.stringify(scope);
			const recalled = recall(session.id, scopeKey, revision);
			if (recalled) return recalled;
			const uncaptured = scope.kind === "turn" && !session.capture;
			const pending = uncaptured && session.pending !== undefined;
			const notCaptured = uncaptured && !pending;
			const pruned = scope.kind === "turn" && session.capture && session.pruned;
			const folders: readonly Listed[] = yield* listScope(session, scope);
			const listed = createHash("sha256")
				.update(
					JSON.stringify([
						session.id,
						scopeKey,
						session.toolCall?.source,
						// Neither lists folders, so only the flag tells them apart.
						notCaptured,
						pending,
						folders.map(revisionOf),
					]),
				)
				.digest("hex")
				.slice(0, 32);
			const listing = {
				revision: listed,
				folders: folders.map(listingOf),
				...(notCaptured ? { notCaptured: true as const } : {}),
				...(pending ? { pending: true as const } : {}),
				...(pruned ? { pruned: true as const } : {}),
				...(session.toolCall ? { source: session.toolCall.source } : {}),
			} satisfies SessionDiffListing;
			memo.delete(listed);
			memo.set(listed, {
				sessionId: session.id,
				scope: scopeKey,
				listing,
				folders: new Map(folders.flatMap(memoOf)),
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
				if ("patches" in folder) {
					const patch = folder.patches.get(request.path);
					if (patch) return patch;
					return yield* new SessionDiffError({
						reason: "not-listed",
						message: `${request.path} has no recorded patch`,
					});
				}
				const { snapshot, from } = folder;
				const chunks: Buffer[] = [];
				yield* timeline
					.git(
						snapshot.store,
						[
							"diff-tree",
							"-p",
							"-M",
							...relative(snapshot),
							from,
							snapshot.worktree,
							"--",
							...[file.oldPath, file.path].flatMap((path) =>
								// Literal, so a name like `[id].ts` cannot match other files.
								path === undefined
									? []
									: [`:(literal)${snapshot.prefix}${path}`],
							),
						],
						{ onStdout: (chunk) => chunks.push(chunk) },
					)
					.pipe(
						Effect.mapError(
							(error) =>
								new SessionDiffError({
									reason: error.reason === "timeout" ? "timeout" : "gone",
									message: error.message,
								}),
						),
					);
				// Latin-1 maps every byte to one character, so no change decodes away.
				const bytes = Buffer.concat(chunks);
				const latin1 = !isUtf8(bytes);
				const patch = latin1
					? bytes.toString("latin1")
					: bytes.toString("utf8");
				const notes = [
					...(patch.includes("\r\n") ? (["crlf"] as const) : []),
					...(latin1 ? (["latin1"] as const) : []),
				];
				return notes.length === 0 ? { patch } : { patch, notes };
			}),
	} satisfies SessionDiff["Service"];
});
