import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Effect,
	Fiber,
	Layer,
	PubSub,
	Schedule,
	Scheduler,
	Stream,
} from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeSessionDiff } from "../../../src/lib/domain/daemon/Layers/session-diff-layer.js";
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
// folder, a non-git folder or a worktree deleted, moved or orphaned after it
// listed fails the whole listing; an LFS file, submodule, symlink or mode
// change goes unlabelled, or a pure rename or mode change claims content;
// CRLF line endings lose their carriage returns or go unlabelled, and
// non-UTF-8 bytes decode to replacement characters; collect skips stores
// left by an earlier run, prunes a snapshot still inside its grace period, or
// keeps one past it so Gone never comes; a live scope snapshots once per
// subscriber instead of once per change, pushes an unchanged revision, reacts
// to another session's change, or keeps snapshotting after its last subscriber
// leaves, even one interrupted while it joined; a list pinned to a pushed
// revision snapshots again.
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

it("errors only a deleted, moved or orphaned worktree while its repository still lists", async () => {
	const repo = repository({ "tracked.txt": "one\n" });
	writeFileSync(join(repo, "tracked.txt"), "two\n");
	const [deleted, moved, orphaned] = ["deleted", "moved", "orphaned"].map(
		(name) => {
			const worktree = join(root, name);
			git(repo, "worktree", "add", "-q", "--detach", worktree);
			writeFileSync(join(worktree, "tracked.txt"), `${name}\n`);
			return worktree;
		},
	) as [string, string, string];
	const folders = [repo, deleted, moved, orphaned].map(present);

	const [before, after] = await run(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const before = yield* diff.list({ id: "s", folders }, scope);
			// Resolved folders are cached, so each loss happens after a listing.
			rmSync(deleted, { recursive: true, force: true });
			renameSync(moved, join(root, "moved-away"));
			rmSync(join(repo, ".git", "worktrees", "orphaned"), {
				recursive: true,
				force: true,
			});
			return [before, yield* diff.list({ id: "s", folders }, scope)];
		}),
	);

	const shape = (listing: typeof before) =>
		listing.folders.map((folder) =>
			"files" in folder
				? folder.files.map(({ path }) => path)
				: [folder.folder, folder.error],
		);
	expect(shape(before)).toEqual([
		["tracked.txt"],
		["tracked.txt"],
		["tracked.txt"],
		["tracked.txt"],
	]);
	expect(shape(after)).toEqual([
		["tracked.txt"],
		[deleted, "unavailable"],
		[moved, "unavailable"],
		[orphaned, "unavailable"],
	]);
});

it("labels LFS, submodule, symlink and mode-only rows, and serves CRLF and non-UTF-8 patches byte for byte", async () => {
	// The developer's global LFS filter must not run, nor be needed, to build the fixture.
	const lfsOff = [
		"-c",
		"filter.lfs.process=",
		"-c",
		"filter.lfs.clean=",
		"-c",
		"filter.lfs.smudge=",
		"-c",
		"filter.lfs.required=false",
	];
	const pointer = (digit: string, size: number) =>
		`version https://git-lfs.github.com/spec/v1\noid sha256:${digit.repeat(64)}\nsize ${size}\n`;
	const commit = (directory: string, message: string) =>
		git(
			directory,
			...lfsOff,
			"-c",
			"user.name=Diff test",
			"-c",
			"user.email=diff@example.test",
			"commit",
			"-qam",
			message,
		);
	const repo = join(root, "repo");
	const sub = join(repo, "sub");
	mkdirSync(sub, { recursive: true });
	git(sub, "init", "-q", "-b", "main");
	writeFileSync(join(sub, "s.txt"), "one\n");
	git(sub, "add", ".");
	commit(sub, "First");
	const first = git(sub, "rev-parse", "HEAD");
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(
		join(repo, ".gitattributes"),
		"*.psd filter=lfs diff=lfs merge=lfs -text\n",
	);
	writeFileSync(join(repo, "photo.psd"), pointer("a", 100));
	writeFileSync(join(repo, "crlf.txt"), "a\r\nb\r\n");
	writeFileSync(join(repo, "latin1.txt"), Buffer.from("caf\xe9\n", "latin1"));
	writeFileSync(join(repo, "same.txt"), "unchanged\n");
	writeFileSync(join(repo, "script.sh"), "echo\n");
	symlinkSync("target.txt", join(repo, "link"));
	git(repo, ...lfsOff, "-c", "advice.addEmbeddedRepo=false", "add", ".");
	commit(repo, "Initial");
	writeFileSync(join(repo, "photo.psd"), pointer("b", 200));
	writeFileSync(join(repo, "crlf.txt"), "a\r\nc\r\n");
	writeFileSync(join(repo, "latin1.txt"), Buffer.from("caf\xe8\n", "latin1"));
	renameSync(join(repo, "same.txt"), join(repo, "moved.txt"));
	chmodSync(join(repo, "script.sh"), 0o755);
	rmSync(join(repo, "link"));
	symlinkSync("other.txt", join(repo, "link"));
	writeFileSync(join(sub, "s.txt"), "two\n");
	commit(sub, "Second");
	const second = git(sub, "rev-parse", "HEAD");

	const { files, replies } = await run(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const listing = yield* diff.list(
				{ id: "s", folders: [present(repo)] },
				scope,
			);
			const [folder] = listing.folders;
			const files = folder && "files" in folder ? folder.files : [];
			const replies = yield* Effect.forEach(
				["crlf.txt", "latin1.txt", "link"],
				(path) => {
					const file = files.find((listed) => listed.path === path);
					return diff.file({
						sessionId: "s",
						scope,
						revision: listing.revision,
						folder: repo,
						path,
						before: file?.before ?? null,
						after: file?.after ?? null,
					});
				},
			);
			return { files, replies };
		}),
	);

	expect(
		files.map((file) => ({
			path: file.path,
			status: file.status,
			kind: file.kind,
			mode: file.mode,
			counts: "insertions" in file ? [file.insertions, file.deletions] : [],
			same: file.before === file.after,
		})),
	).toEqual([
		{ path: "crlf.txt", status: "modified", counts: [1, 1], same: false },
		{ path: "latin1.txt", status: "modified", counts: [1, 1], same: false },
		{
			path: "link",
			status: "modified",
			kind: "symlink",
			counts: [1, 1],
			same: false,
		},
		{ path: "moved.txt", status: "renamed", counts: [0, 0], same: true },
		{
			path: "photo.psd",
			status: "modified",
			kind: "lfs",
			counts: [2, 2],
			same: false,
		},
		{
			path: "script.sh",
			status: "modified",
			mode: { before: "100644", after: "100755" },
			counts: [0, 0],
			same: true,
		},
		{
			path: "sub",
			status: "modified",
			kind: "submodule",
			counts: [1, 1],
			same: false,
		},
	]);
	expect(files.find(({ path }) => path === "sub")).toMatchObject({
		before: first,
		after: second,
		// Its commits are not blobs in the store, so they have no size.
		bytes: 0,
	});
	expect(replies).toEqual([
		{
			patch: expect.stringContaining(" a\r\n-b\r\n+c\r\n"),
			notes: ["crlf"],
		},
		{
			patch: expect.stringContaining("-café\n+cafè\n"),
			notes: ["latin1"],
		},
		{
			patch: expect.stringContaining(
				"-target.txt\n\\ No newline at end of file\n+other.txt\n",
			),
		},
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

it("stops snapshotting when a subscriber is interrupted at any step of joining", async () => {
	const session = { id: "s", folders: [present("/repo")] };
	// Interrupts the joining fiber after its nth operation, for every n up to past joining.
	const leaks: number[] = [];
	for (let interruptAt = 1; interruptAt <= 80; interruptAt += 1) {
		let snapshots = 0;
		let operations = 0;
		let target: number | undefined;
		const base = new Scheduler.MixedScheduler("async");
		const scheduler: Scheduler.Scheduler = {
			executionMode: "async",
			makeDispatcher: () => base.makeDispatcher(),
			shouldYield: (fiber) => {
				if (fiber.id !== target || ++operations !== interruptAt) return false;
				queueMicrotask(() => fiber.interruptUnsafe(fiber.id));
				return true;
			},
		};
		const leaked = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const published = yield* PubSub.unbounded<SessionGitChange>();
					const diff = yield* makeSessionDiff.pipe(
						Effect.provideService(FolderTimeline, {
							snapshot: () =>
								Effect.sync(() => ({
									store: "store",
									prefix: "",
									index: "index",
									worktree: String(++snapshots),
								})),
							git: () =>
								Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
							folderGit: () =>
								Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
							collect: () => Effect.void,
							runStarted: () => Effect.void,
							runJoined: () => Effect.void,
							runEnded: () => Effect.void,
							settled: () => Effect.void,
							sessionStore: () => "store",
							forget: () => Effect.void,
						}),
						Effect.provideService(SessionGit, {
							read: () => Effect.succeed(undefined),
							changes: Stream.fromPubSub(published),
							invalidate: () => Effect.void,
						}),
					);
					const joining = yield* Effect.withFiber((fiber) => {
						target = fiber.id;
						return Stream.runDrain(diff.changes(session, scope));
					}).pipe(
						Effect.provideService(Scheduler.Scheduler, scheduler),
						Effect.forkChild,
					);
					yield* Effect.sleep("5 millis");
					yield* Fiber.interrupt(joining);
					yield* Effect.sleep("5 millis");
					const before = snapshots;
					yield* PubSub.publish(published, {
						directory: "/repo",
						sessionIds: ["s"],
						version: 1,
					});
					yield* Effect.sleep("5 millis");
					return snapshots > before;
				}),
			),
		);
		if (leaked) leaks.push(interruptAt);
	}
	expect(leaks).toEqual([]);
});

// Branch scope failure modes: the before side is HEAD or the base tip rather
// than their merge-base; uncommitted or untracked work drops out; the launch
// base, override or default branch is skipped or tried out of order; a missing
// commit or a shallow clone with no common history fails the folder instead of
// falling back, or falls back silently; file() diffs against the index; a base
// change keeps the old revision; an unborn HEAD fails instead of listing all.
const commit = (repo: string, message: string) => {
	git(repo, "add", "--all");
	git(
		repo,
		"-c",
		"user.name=Diff test",
		"-c",
		"user.email=diff@example.test",
		"commit",
		"-qm",
		message,
	);
	return git(repo, "rev-parse", "HEAD");
};

const listBranch = (
	folder: {
		root: string;
		directory: string;
		present: boolean;
		launchBase?: string;
	},
	base: string | null,
) =>
	run(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const branch = { kind: "branch", base } as const;
			const listing = yield* diff.list({ id: "s", folders: [folder] }, branch);
			const [listed] = listing.folders;
			if (!listed || !("files" in listed)) throw new Error("Folder not listed");
			const patches = yield* Effect.forEach(listed.files, (file) =>
				diff.file({
					sessionId: "s",
					scope: branch,
					revision: listing.revision,
					folder: folder.root,
					path: file.path,
					before: file.before,
					after: file.after,
				}),
			);
			return {
				revision: listing.revision,
				base: listed.base,
				files: listed.files.map(({ path, status }) => `${status} ${path}`),
				patches: patches.map(({ patch }) => patch),
			};
		}),
	);

it("branch scope diffs the merge-base of each base in order against the live tree, untracked files included", async () => {
	const repo = repository({ "shared.txt": "base\n" });
	git(repo, "checkout", "-q", "-b", "feature");
	writeFileSync(join(repo, "first.txt"), "first\n");
	const launch = commit(repo, "First");
	writeFileSync(join(repo, "second.txt"), "second\n");
	commit(repo, "Second");
	git(repo, "checkout", "-q", "main");
	writeFileSync(join(repo, "main-only.txt"), "ahead\n");
	commit(repo, "Main moves on");
	git(repo, "checkout", "-q", "feature");
	writeFileSync(join(repo, "shared.txt"), "edited\n");
	writeFileSync(join(repo, "untracked.txt"), "new\n");
	const folder = { ...present(repo), launchBase: launch };

	const byLaunch = await listBranch(folder, null);
	expect(byLaunch.base).toEqual({
		ref: launch,
		source: "launch",
		kind: "commit",
	});
	expect(byLaunch.files).toEqual([
		"added second.txt",
		"modified shared.txt",
		"added untracked.txt",
	]);
	expect(byLaunch.patches[1]).toContain("-base\n+edited\n");

	const byOverride = await listBranch(folder, "main");
	expect(byOverride.base).toEqual({
		ref: "main",
		source: "override",
		kind: "branch",
	});
	expect(byOverride.files).toEqual([
		"added first.txt",
		"added second.txt",
		"modified shared.txt",
		"added untracked.txt",
	]);
	expect(byOverride.revision).not.toBe(byLaunch.revision);

	const byDefault = await listBranch(present(repo), null);
	expect(byDefault.base).toEqual({
		ref: "main",
		source: "default",
		kind: "branch",
	});
	expect(byDefault.files).toEqual(byOverride.files);
});

it("falls back past a missing launch commit or override with a notice, and lists an unborn repository whole", async () => {
	const repo = repository({ "tracked.txt": "one\n" });
	writeFileSync(join(repo, "tracked.txt"), "two\n");
	const gone = "0123456789abcdef0123456789abcdef01234567";

	const missingLaunch = await listBranch(
		{ ...present(repo), launchBase: gone },
		null,
	);
	expect(missingLaunch.base).toEqual({
		ref: "main",
		source: "default",
		kind: "branch",
		fallback: { wanted: gone, reason: "missing" },
	});
	expect(missingLaunch.files).toEqual(["modified tracked.txt"]);

	const missingOverride = await listBranch(
		{ ...present(repo), launchBase: gone },
		"no-such-branch",
	);
	expect(missingOverride.base).toEqual({
		ref: "main",
		source: "default",
		kind: "branch",
		fallback: { wanted: "no-such-branch", reason: "missing" },
	});

	// A stale origin/HEAD, as after the remote renames its default branch.
	git(
		repo,
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/gone",
	);
	const staleRemote = await listBranch(present(repo), null);
	expect(staleRemote.base).toEqual({
		ref: "main",
		source: "default",
		kind: "branch",
		fallback: { wanted: "origin/gone", reason: "missing" },
	});

	const fresh = join(root, "fresh");
	mkdirSync(fresh);
	git(fresh, "init", "-q", "-b", "main");
	writeFileSync(join(fresh, "untracked.txt"), "new\n");
	const unborn = await listBranch(present(fresh), null);
	expect(unborn.base).toEqual({ ref: "HEAD", source: "head", kind: "commit" });
	expect(unborn.files).toEqual(["added untracked.txt"]);
});

it("falls back to HEAD with a shallow notice when a shallow clone has no common history", async () => {
	const origin = repository({ "tracked.txt": "one\n" });
	git(origin, "checkout", "-q", "-b", "feature");
	writeFileSync(join(origin, "feature.txt"), "feature\n");
	commit(origin, "Feature");
	git(origin, "checkout", "-q", "main");
	writeFileSync(join(origin, "main.txt"), "main\n");
	commit(origin, "Main");
	const clone = join(root, "clone");
	execFileSync("git", [
		"clone",
		"-q",
		"--depth",
		"1",
		"--no-single-branch",
		"--branch",
		"feature",
		`file://${origin}`,
		clone,
	]);
	writeFileSync(join(clone, "feature.txt"), "edited\n");

	const shallow = await listBranch(present(clone), null);
	expect(shallow.base).toEqual({
		ref: "HEAD",
		source: "head",
		kind: "commit",
		fallback: { wanted: "origin/main", reason: "shallow" },
	});
	expect(shallow.files).toEqual(["modified feature.txt"]);
});

// Base names: a tag shadows the branch it shares a name with; a branch named
// like a sha resolves as that commit; a branch with a slash resolves as the tag
// it spells; a remote branch resolves as a same-named tag or local branch; a
// deleted branch's same-named tag is used without saying so. A deleted branch
// with no namesake falls back as missing, as `no-such-branch` does above.
/** Branch v1 and tag v1 fork from main; HEAD works on the branch with an uncommitted edit. */
const sameNames = () => {
	const repo = repository({ "shared.txt": "base\n" });
	git(repo, "checkout", "-q", "-b", "v1");
	writeFileSync(join(repo, "branch.txt"), "branch\n");
	const branch = commit(repo, "Branch");
	git(repo, "checkout", "-q", "main");
	writeFileSync(join(repo, "tagged.txt"), "tagged\n");
	const tagged = commit(repo, "Tagged");
	git(repo, "tag", "v1");
	git(repo, "checkout", "-q", "-b", "work", branch);
	writeFileSync(join(repo, "work.txt"), "work\n");
	commit(repo, "Work");
	writeFileSync(join(repo, "shared.txt"), "edited\n");
	return { repo, branch, tagged };
};
const sinceBranch = ["modified shared.txt", "added work.txt"];
const sinceMain = ["added branch.txt", "modified shared.txt", "added work.txt"];

it("diffs against the branch when a branch and a tag share its name", async () => {
	const { repo } = sameNames();
	const listed = await listBranch(present(repo), "v1");
	expect(listed.base).toEqual({
		ref: "v1",
		source: "override",
		kind: "branch",
	});
	expect(listed.files).toEqual(sinceBranch);
});

it("names the tag it used once the same-named branch is deleted", async () => {
	const { repo } = sameNames();
	git(repo, "branch", "-D", "v1");
	const listed = await listBranch(present(repo), "v1");
	expect(listed.base).toEqual({ ref: "v1", source: "override", kind: "tag" });
	expect(listed.files).toEqual(sinceMain);
});

it("diffs against a branch named like a sha rather than that commit", async () => {
	const { repo, branch, tagged } = sameNames();
	git(repo, "branch", tagged, branch);
	const listed = await listBranch(present(repo), tagged);
	expect(listed.base).toEqual({
		ref: tagged,
		source: "override",
		kind: "branch",
	});
	expect(listed.files).toEqual(sinceBranch);
});

it("diffs against a branch with a slash rather than the tag it spells", async () => {
	const { repo, branch } = sameNames();
	git(repo, "branch", "tags/v1", branch);
	const listed = await listBranch(present(repo), "tags/v1");
	expect(listed.base).toEqual({
		ref: "tags/v1",
		source: "override",
		kind: "branch",
	});
	expect(listed.files).toEqual(sinceBranch);
});

it("diffs against a remote-only branch past a same-named tag, and origin/HEAD past a same-named local branch", async () => {
	const { repo, branch, tagged } = sameNames();
	git(repo, "update-ref", "refs/remotes/origin/feature", branch);
	git(repo, "tag", "origin/feature", tagged);
	const override = await listBranch(present(repo), "origin/feature");
	expect(override.base).toEqual({
		ref: "origin/feature",
		source: "override",
		kind: "remote",
	});
	expect(override.files).toEqual(sinceBranch);

	git(repo, "update-ref", "refs/remotes/origin/main", branch);
	git(
		repo,
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/main",
	);
	git(repo, "branch", "origin/main", tagged);
	const byDefault = await listBranch(present(repo), null);
	expect(byDefault.base).toEqual({
		ref: "origin/main",
		source: "default",
		kind: "remote",
	});
	expect(byDefault.files).toEqual(sinceBranch);
});

// A tool call lists from its recorded changes without git: the source is
// dropped, or left out of the revision so a provider and an input-derived
// listing collide in the memo; a note the capture settles (a Write add that
// was unchecked) leaves the revision unchanged; the listed patch is not
// served; an uncaptured turn lists folders instead of saying it was not captured.
it("lists a tool call's changes with their source and serves them, and marks an uncaptured turn", async () => {
	const folders = [present("/r")];
	const changes = [
		{ kind: "update", path: "/r/a.ts", patch: "@@\n-a\n+b" },
	] as const;
	const toolCall = { kind: "toolCall", toolId: "t" } as const;
	const listed = await run(
		Effect.gen(function* () {
			const diff = yield* SessionDiff;
			const provider = yield* diff.list(
				{ id: "s", folders, toolCall: { source: "provider", changes } },
				toolCall,
			);
			const input = yield* diff.list(
				{ id: "s", folders, toolCall: { source: "toolInput", changes } },
				toolCall,
			);
			const [folder] = provider.folders;
			const file = folder && "files" in folder ? folder.files[0] : undefined;
			const served = yield* diff.file({
				sessionId: "s",
				scope: toolCall,
				revision: provider.revision,
				folder: "/r",
				path: "a.ts",
				before: file?.before ?? null,
				after: file?.after ?? null,
			});
			const write = {
				source: "provider",
				changes: [{ kind: "add", path: "/r/new.ts", after: "x\n" }],
			} as const;
			const unchecked = yield* diff.list(
				{ id: "s", folders, toolCall: write },
				toolCall,
			);
			const side = { mode: "100644", blob: "b" };
			const checked = yield* diff.list(
				{
					id: "s",
					folders,
					toolCall: write,
					capture: {
						runId: "run",
						folders: [
							{
								directory: "/r",
								before: "t0",
								after: "t1",
								shared: false,
								changes: [{ path: "new.ts", before: null, after: side }],
							},
						],
					},
				},
				toolCall,
			);
			const turn = yield* diff.list(
				{ id: "s", folders },
				{ kind: "turn", turnId: "u" },
			);
			return { provider, input, served, unchecked, checked, turn };
		}),
	);

	expect(listed.provider.source).toBe("provider");
	expect(listed.input.source).toBe("toolInput");
	expect(listed.input.revision).not.toBe(listed.provider.revision);
	expect(listed.served.patch).toContain("\n@@ -1,1 +1,1 @@\n-a\n+b\n");
	expect(listed.checked.folders).toStrictEqual(listed.unchecked.folders);
	expect(listed.checked.revision).not.toBe(listed.unchecked.revision);
	expect(listed.turn).toStrictEqual({
		revision: expect.any(String),
		folders: [],
		notCaptured: true,
	});
});
