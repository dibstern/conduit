import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, PubSub, Schedule, Stream } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderTimeline } from "../../../src/lib/domain/daemon/Services/folder-timeline.js";
import {
	SessionDiff,
	SessionDiffLive,
} from "../../../src/lib/domain/daemon/Services/session-diff.js";
import {
	SessionGit,
	type SessionGitChange,
} from "../../../src/lib/domain/daemon/Services/session-git.js";
import { Subprocess } from "../../../src/lib/domain/daemon/Services/subprocess.js";

// Failure modes beyond the process E2E: a file's blobs, counts, size or tier
// are wrong, swapped or misaligned after a rename's extra numstat paths; a
// tier boundary is off by one; file() serves a patch for a request that does
// not match its listing exactly, or forgets a listing too early or never; a
// subfolder lists or serves paths relative to the repository instead of
// itself, or leaks changes outside it; a path with glob characters serves
// other files' patches; worktrees sharing a repository race to create its
// store on first use; a folder without an index, a missing
// folder or a non-git folder fails the whole listing; collect skips stores
// left by an earlier run, prunes a snapshot still inside its grace period, or
// keeps one past it so Gone never comes; a live scope snapshots once per
// subscriber instead of once per change, pushes an unchanged revision, reacts
// to another session's change, or keeps snapshotting after its last subscriber
// leaves; a list pinned to a pushed revision snapshots again.
const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
let root = "";

beforeEach(() => {
	for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
	root = realpathSync(mkdtempSync(join(tmpdir(), "session-diff-")));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

function repository(files: Record<string, string>) {
	const repo = join(root, "repo");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	}
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", ".");
	git(
		repo,
		"-c",
		"user.name=Diff test",
		"-c",
		"user.email=diff@example.test",
		"commit",
		"-qm",
		"Initial",
	);
	return repo;
}

const sessionGit = (changes: Stream.Stream<SessionGitChange>) =>
	Layer.succeed(SessionGit, {
		read: () => Effect.succeed(undefined),
		changes,
		invalidate: () => Effect.void,
	});

const run = <A, E>(
	program: Effect.Effect<A, E, SessionDiff | FolderTimeline>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(
			Effect.provide(
				SessionDiffLive(join(root, "config")).pipe(
					Layer.provide(sessionGit(Stream.never)),
				),
			),
		),
	);

const scope = { kind: "unstaged" } as const;
const lines = (count: number) => "line\n".repeat(count);
const index = (repo: string, path: string) =>
	git(repo, "rev-parse", `:${path}`);
const worktree = (repo: string, path: string) => git(repo, "hash-object", path);
const backdate = (directory: string) => {
	const hourAgo = Date.now() / 1000 - 3600;
	for (const entry of readdirSync(directory, {
		recursive: true,
		withFileTypes: true,
	}))
		if (entry.isFile())
			utimesSync(join(entry.parentPath, entry.name), hourAgo, hourAgo);
};
const present = (directory: string) => ({
	root: directory,
	directory,
	present: true,
});

it("lists every kind of change with exact blobs, counts, sizes and tiers, and serves only what it listed", async () => {
	const tooLarge = 1024 * 1024;
	const repo = repository({
		"binary.bin": "\0\x01\x02",
		"deleted.txt": lines(3),
		"modified.txt": "a\nb\n",
		"rewritten.txt": lines(251),
		"z-moved.txt": `${lines(9)}last\n`,
	});
	writeFileSync(join(repo, "binary.bin"), "\0\x01\x02\x03");
	rmSync(join(repo, "deleted.txt"));
	writeFileSync(join(repo, "rewritten.txt"), "new\n".repeat(250));
	writeFileSync(join(repo, "modified.txt"), "a\nc\nd\n");
	renameSync(join(repo, "z-moved.txt"), join(repo, "a-renamed.txt"));
	writeFileSync(join(repo, "a-renamed.txt"), `${lines(9)}edited\n`);
	writeFileSync(join(repo, "added.txt"), "new\n");
	writeFileSync(join(repo, "empty.txt"), "");
	writeFileSync(join(repo, "lines-500.txt"), lines(500));
	writeFileSync(join(repo, "size-limit.txt"), `${"x".repeat(tooLarge - 1)}\n`);
	writeFileSync(join(repo, "size-over.txt"), `${"x".repeat(tooLarge)}\n`);

	const { files, outcomes } = await run(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const listing = yield* diff.list(
				{ id: "s", folders: [present(repo)] },
				scope,
			);
			const [folder] = listing.folders;
			const files = folder && "files" in folder ? folder.files : [];
			const valid = (path: string) => {
				const file = files.find((listed) => listed.path === path);
				return {
					sessionId: "s",
					scope,
					revision: listing.revision,
					folder: repo,
					path,
					before: file?.before ?? null,
					after: file?.after ?? null,
				};
			};
			const read = (request: ReturnType<typeof valid>) =>
				diff.file(request).pipe(
					Effect.match({
						onSuccess: ({ patch }) => patch,
						onFailure: ({ reason }) => reason,
					}),
				);
			return {
				files,
				outcomes: yield* Effect.all({
					modified: read(valid("modified.txt")),
					renamed: read(valid("a-renamed.txt")),
					tooLarge: read(valid("size-over.txt")),
					unlisted: read(valid("unlisted.txt")),
					otherAfter: read({ ...valid("modified.txt"), after: null }),
					otherBefore: read({ ...valid("modified.txt"), before: null }),
					otherSession: read({ ...valid("modified.txt"), sessionId: "t" }),
					otherFolder: read({ ...valid("modified.txt"), folder: root }),
					forgotten: read({ ...valid("modified.txt"), revision: "x" }),
				}),
			};
		}),
	);

	const counted = (
		path: string,
		fields: {
			readonly status: "added" | "deleted" | "modified" | "renamed";
			readonly bytes: number;
			readonly insertions: number;
			readonly deletions: number;
			readonly binary?: boolean;
			readonly tier?: "auto" | "onDemand";
			readonly oldPath?: string;
		},
	) => ({
		path,
		before:
			fields.status === "added" ? null : index(repo, fields.oldPath ?? path),
		after: fields.status === "deleted" ? null : worktree(repo, path),
		binary: false,
		tier: "auto",
		...fields,
	});
	expect(files).toEqual([
		counted("a-renamed.txt", {
			status: "renamed",
			oldPath: "z-moved.txt",
			bytes: 52,
			insertions: 1,
			deletions: 1,
		}),
		counted("added.txt", {
			status: "added",
			bytes: 4,
			insertions: 1,
			deletions: 0,
		}),
		counted("binary.bin", {
			status: "modified",
			bytes: 4,
			insertions: 0,
			deletions: 0,
			binary: true,
		}),
		counted("deleted.txt", {
			status: "deleted",
			bytes: 15,
			insertions: 0,
			deletions: 3,
		}),
		counted("empty.txt", {
			status: "added",
			bytes: 0,
			insertions: 0,
			deletions: 0,
		}),
		counted("lines-500.txt", {
			status: "added",
			bytes: 2500,
			insertions: 500,
			deletions: 0,
		}),
		counted("modified.txt", {
			status: "modified",
			bytes: 6,
			insertions: 2,
			deletions: 1,
		}),
		counted("rewritten.txt", {
			status: "modified",
			bytes: 1255,
			insertions: 250,
			deletions: 251,
			tier: "onDemand",
		}),
		counted("size-limit.txt", {
			status: "added",
			bytes: tooLarge,
			insertions: 1,
			deletions: 0,
		}),
		{
			path: "size-over.txt",
			status: "added",
			before: null,
			after: worktree(repo, "size-over.txt"),
			bytes: tooLarge + 1,
			tier: "tooLarge",
		},
	]);
	expect(outcomes).toEqual({
		modified: expect.stringContaining(" a\n-b\n+c\n+d\n"),
		renamed: expect.stringContaining(
			"rename from z-moved.txt\nrename to a-renamed.txt",
		),
		tooLarge: "too-large",
		unlisted: "not-listed",
		otherAfter: "not-listed",
		otherBefore: "not-listed",
		otherSession: "not-listed",
		otherFolder: "not-listed",
		forgotten: "gone",
	});
});

it("forgets the least recently listed revision once 64 newer ones exist", async () => {
	const repo = repository({ "tracked.txt": "one\n" });
	writeFileSync(join(repo, "tracked.txt"), "two\n");
	const missing = join(root, "missing");

	const outcomes = await run(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const list = () =>
				diff.list({ id: "s", folders: [present(repo)] }, scope);
			const others = (from: number, count: number) =>
				Effect.forEach(
					Array.from({ length: count }, (_, at) => `other-${from + at}`),
					(id) =>
						diff.list(
							{
								id,
								folders: [
									{ root: missing, directory: missing, present: false },
								],
							},
							scope,
						),
				);
			const { revision } = yield* list();
			const read = diff
				.file({
					sessionId: "s",
					scope,
					revision,
					folder: repo,
					path: "tracked.txt",
					before: index(repo, "tracked.txt"),
					after: worktree(repo, "tracked.txt"),
				})
				.pipe(
					Effect.match({
						onSuccess: () => "served",
						onFailure: ({ reason }) => reason,
					}),
				);
			yield* others(0, 62);
			const relisted = (yield* list()).revision === revision;
			yield* others(62, 63);
			const refreshed = yield* read;
			yield* others(125, 1);
			return { relisted, refreshed, evicted: yield* read };
		}),
	);

	expect(outcomes).toEqual({
		relisted: true,
		refreshed: "served",
		evicted: "gone",
	});
});

it("lists a subfolder relative to itself, keeps a rename's old path, and serves each patch alone", async () => {
	const repo = repository({
		"sub/[e]dited.txt": "glob before\n",
		"sub/edited.txt": "before\n",
		"sub/moved.txt": "a long enough line to be detected as a rename\n",
		"outside.txt": "outside\n",
	});
	writeFileSync(join(repo, "sub/[e]dited.txt"), "glob after\n");
	writeFileSync(join(repo, "sub/edited.txt"), "after\n");
	renameSync(join(repo, "sub/moved.txt"), join(repo, "sub/renamed.txt"));
	writeFileSync(join(repo, "outside.txt"), "changed outside\n");
	const sub = join(repo, "sub");

	const { files, patches } = await run(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const listing = yield* diff.list(
				{ id: "s", folders: [present(sub)] },
				scope,
			);
			const [folder] = listing.folders;
			const files = folder && "files" in folder ? folder.files : [];
			const patches = yield* Effect.forEach(files, (file) =>
				diff.file({
					sessionId: "s",
					scope,
					revision: listing.revision,
					folder: sub,
					path: file.path,
					before: file.before,
					after: file.after,
				}),
			);
			return { files, patches: patches.map(({ patch }) => patch) };
		}),
	);

	expect(
		files.map(({ path, status, oldPath }) => ({ path, status, oldPath })),
	).toEqual([
		{ path: "[e]dited.txt", status: "modified", oldPath: undefined },
		{ path: "edited.txt", status: "modified", oldPath: undefined },
		{ path: "renamed.txt", status: "renamed", oldPath: "moved.txt" },
	]);
	expect(patches.map((patch) => patch.split("diff --git").length - 1)).toEqual([
		1, 1, 1,
	]);
	expect(patches[0]).toContain("-glob before\n+glob after\n");
	expect(patches[1]).toContain("-before\n+after\n");
	expect(patches[2]).toContain("rename from moved.txt\nrename to renamed.txt");
});

it("lists worktrees that share one repository together on first use", async () => {
	const repo = repository({ "tracked.txt": "one\n" });
	const worktrees = Array.from({ length: 6 }, (_, n) => {
		const worktree = join(root, `worktree-${n}`);
		git(repo, "worktree", "add", "-q", "--detach", worktree);
		writeFileSync(join(worktree, "tracked.txt"), `${n}\n`);
		return worktree;
	});

	// Each attempt starts from an empty store, so every worktree initialises it.
	for (const attempt of [1, 2, 3]) {
		const listing = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* SessionDiff).list(
					{ id: "s", folders: worktrees.map(present) },
					scope,
				);
			}).pipe(
				Effect.provide(
					SessionDiffLive(join(root, `config-${attempt}`)).pipe(
						Layer.provide(sessionGit(Stream.never)),
					),
				),
			),
		);
		expect(listing.folders.map((folder) => "files" in folder)).toEqual(
			worktrees.map(() => true),
		);
	}
});

it("reports missing and non-git folders as unavailable beside a listed one", async () => {
	const repo = repository({ "empty.txt": "", "tracked.txt": "one\n" });
	rmSync(join(repo, "empty.txt"));
	writeFileSync(join(repo, "tracked.txt"), "two\n");
	const fresh = join(root, "fresh");
	mkdirSync(fresh);
	git(fresh, "init", "-q");
	writeFileSync(join(fresh, "untracked.txt"), "new\n");
	const plain = join(root, "plain");
	mkdirSync(plain);
	const missing = join(root, "missing");

	const listing = await run(
		Effect.gen(function* () {
			return yield* (yield* SessionDiff).list(
				{
					id: "s",
					folders: [
						present(repo),
						present(fresh),
						present(plain),
						{ root: missing, directory: missing, present: false },
					],
				},
				scope,
			);
		}),
	);

	expect(
		listing.folders.map((folder) =>
			"files" in folder
				? folder.files.map(
						({ path, status, bytes }) => `${status} ${path} ${bytes}`,
					)
				: [folder.folder, folder.error, folder.message],
		),
	).toEqual([
		["deleted empty.txt 0", "modified tracked.txt 4"],
		["added untracked.txt 4"],
		[plain, "unavailable", expect.stringContaining("not a git repository")],
		[missing, "unavailable", `Folder is missing: ${missing}`],
	]);
});

it("collect sweeps stores left by an earlier run, keeps a snapshot inside its grace period and drops it after", async () => {
	const repo = repository({ "tracked.txt": "one\n" });
	writeFileSync(join(repo, "tracked.txt"), "two\n");
	const stores = join(root, "config", "folder-timeline");
	const leftover = join(stores, "leftover.git");
	mkdirSync(stores, { recursive: true });
	git(stores, "init", "-q", "--bare", leftover);
	const orphan = execFileSync(
		"git",
		["--git-dir", leftover, "hash-object", "-w", "--stdin"],
		{ input: "orphan\n", encoding: "utf8" },
	).trim();
	const orphanPath = join(
		leftover,
		"objects",
		orphan.slice(0, 2),
		orphan.slice(2),
	);
	backdate(join(leftover, "objects"));

	const outcomes = await run(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const timeline = yield* FolderTimeline;
			const listing = yield* diff.list(
				{ id: "s", folders: [present(repo)] },
				scope,
			);
			const read = diff
				.file({
					sessionId: "s",
					scope,
					revision: listing.revision,
					folder: repo,
					path: "tracked.txt",
					before: index(repo, "tracked.txt"),
					after: worktree(repo, "tracked.txt"),
				})
				.pipe(
					Effect.match({
						onSuccess: ({ patch }) => patch.includes("+two"),
						onFailure: ({ reason }) => reason,
					}),
				);
			yield* timeline.collect(60_000);
			const kept = yield* read;
			const orphaned = existsSync(orphanPath);
			backdate(stores);
			yield* timeline.collect(60_000);
			return { orphaned, kept, expired: yield* read };
		}),
	);

	expect(outcomes).toEqual({ orphaned: false, kept: true, expired: "gone" });
});

it("opens a live scope with one snapshot, pushes each new revision to every subscriber, and stops when the last one leaves", async () => {
	const repo = repository({ "tracked.txt": "one\n" });
	writeFileSync(join(repo, "tracked.txt"), "two\n");
	const published = Effect.runSync(PubSub.unbounded<SessionGitChange>());
	// Each snapshot writes two trees: the index and the working tree.
	let trees = 0;
	const counted = Layer.effect(
		Subprocess,
		Effect.map(Subprocess, (real) => ({
			...real,
			run: (...call: Parameters<typeof real.run>) => {
				if (call[1].includes("write-tree")) trees += 1;
				return real.run(...call);
			},
		})),
	);
	const snapshots = () => trees / 2;
	const session = { id: "s", folders: [present(repo)] };
	const edit = (text: string) =>
		Effect.sync(() => writeFileSync(join(repo, "tracked.txt"), text));
	const change = (sessionId: string) =>
		PubSub.publish(published, {
			directory: repo,
			sessionIds: [sessionId],
			version: 1,
		});
	const until = (done: () => boolean) =>
		Effect.sync(done).pipe(
			Effect.repeat({
				until: (ok) => ok,
				schedule: Schedule.spaced("10 millis"),
			}),
			Effect.timeout("10 seconds"),
		);
	// Long enough for a stray list to snapshot or push.
	const quiet = Effect.sleep("300 millis");
	const blob = (text: string) =>
		execFileSync("git", ["hash-object", "--stdin"], {
			input: text,
			encoding: "utf8",
		}).trim();

	const outcome = await Effect.runPromise(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const seen: [string[], string[]] = [[], []];
			const subscribe = (into: string[]) =>
				diff.changes(session, scope).pipe(
					Stream.runForEach((revision) =>
						Effect.sync(() => into.push(revision)),
					),
					Effect.forkChild,
				);
			const first = yield* subscribe(seen[0]);
			yield* until(() => seen[0].length === 1);
			const second = yield* subscribe(seen[1]);
			yield* until(() => seen[1].length === 1);
			const opened = snapshots();

			yield* change("s");
			yield* until(() => snapshots() === 2);
			yield* quiet;
			const unchanged = seen.map((revisions) => revisions.length);

			yield* edit("three\n");
			yield* change("s");
			yield* until(() => seen[0].length === 2 && seen[1].length === 2);
			const pushed = seen[0][1] ?? "";
			const beforePinned = snapshots();
			const pinned = yield* diff.list(session, scope, pushed);
			const pinnedSnapshots = snapshots() - beforePinned;

			yield* change("t");
			yield* quiet;
			const otherSession = snapshots() - beforePinned;

			yield* Fiber.interrupt(first);
			yield* edit("four\n");
			yield* change("s");
			yield* until(() => seen[1].length === 3);
			yield* quiet;
			const oneLeft = seen.map((revisions) => revisions.length);

			yield* Fiber.interrupt(second);
			const beforeClosed = snapshots();
			yield* edit("five\n");
			yield* change("s");
			yield* quiet;
			const closed = snapshots() - beforeClosed;

			const again: string[] = [];
			const third = yield* subscribe(again);
			yield* until(() => again.length === 1);
			yield* Fiber.interrupt(third);
			const reopened = yield* diff.list(session, scope, again[0]);

			const after = (listing: typeof pinned) => {
				const [folder] = listing.folders;
				return folder && "files" in folder ? folder.files[0]?.after : undefined;
			};
			return {
				opened,
				joinedSame: seen[0][0] === seen[1][0],
				unchanged,
				pushedDiffers: pushed !== seen[0][0] && seen[1][1] === pushed,
				pinnedRevision: pinned.revision === pushed,
				pinnedAfter: after(pinned),
				pinnedSnapshots,
				otherSession,
				oneLeft,
				closed,
				reopenedAfter: after(reopened),
				reopenedSnapshots: snapshots() - beforeClosed,
			};
		}).pipe(
			Effect.provide(
				SessionDiffLive(join(root, "config")).pipe(
					Layer.provide(sessionGit(Stream.fromPubSub(published))),
					Layer.provide(counted),
				),
			),
		),
	);

	expect(outcome).toEqual({
		opened: 1,
		joinedSame: true,
		unchanged: [1, 1],
		pushedDiffers: true,
		pinnedRevision: true,
		pinnedAfter: blob("three\n"),
		pinnedSnapshots: 0,
		otherSession: 0,
		oneLeft: [2, 3],
		closed: 0,
		reopenedAfter: blob("five\n"),
		reopenedSnapshots: 1,
	});
});
