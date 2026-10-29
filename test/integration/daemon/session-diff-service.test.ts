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
// folder or a non-git folder fails the whole listing; collect skips stores
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
	expect(byLaunch.base).toEqual({ ref: launch, source: "launch" });
	expect(byLaunch.files).toEqual([
		"added second.txt",
		"modified shared.txt",
		"added untracked.txt",
	]);
	expect(byLaunch.patches[1]).toContain("-base\n+edited\n");

	const byOverride = await listBranch(folder, "main");
	expect(byOverride.base).toEqual({ ref: "main", source: "override" });
	expect(byOverride.files).toEqual([
		"added first.txt",
		"added second.txt",
		"modified shared.txt",
		"added untracked.txt",
	]);
	expect(byOverride.revision).not.toBe(byLaunch.revision);

	const byDefault = await listBranch(present(repo), null);
	expect(byDefault.base).toEqual({ ref: "main", source: "default" });
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
		fallback: { wanted: "no-such-branch", reason: "missing" },
	});

	const fresh = join(root, "fresh");
	mkdirSync(fresh);
	git(fresh, "init", "-q", "-b", "main");
	writeFileSync(join(fresh, "untracked.txt"), "new\n");
	const unborn = await listBranch(present(fresh), null);
	expect(unborn.base).toEqual({ ref: "HEAD", source: "head" });
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
		fallback: { wanted: "origin/main", reason: "shallow" },
	});
	expect(shallow.files).toEqual(["modified feature.txt"]);
});
