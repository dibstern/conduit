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
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderTimeline } from "../../../src/lib/domain/daemon/Services/folder-timeline.js";
import {
	SessionDiff,
	SessionDiffLive,
} from "../../../src/lib/domain/daemon/Services/session-diff.js";

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
// keeps one past it so Gone never comes.
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

const run = <A, E>(
	program: Effect.Effect<A, E, SessionDiff | FolderTimeline>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(Effect.provide(SessionDiffLive(join(root, "config")))),
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
			}).pipe(Effect.provide(SessionDiffLive(join(root, `config-${attempt}`)))),
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
