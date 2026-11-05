import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderTimeline } from "../../../src/lib/domain/daemon/Services/folder-timeline.js";
import {
	type SessionDiff,
	SessionDiffLive,
} from "../../../src/lib/domain/daemon/Services/session-diff.js";
import { SessionGit } from "../../../src/lib/domain/daemon/Services/session-git.js";

// Failure modes of head moves with files at the store seam (audit.md, lane 53):
// a run's whole-folder checkpoint is unpinned with its capture, or pruned by a
// collect, so no move can restore it; a checkpoint outlives the eviction or
// forgetting of its session, or eviction drops another session's (21); a
// restore writes the user's index, HEAD or refs (14), or turns links into
// files, drops exec bits or fails a file/folder swap (13); a planned file the
// user edited after the plan is overwritten (7), or a multi-folder restore
// writes one folder and refuses the other (20); a failed journal leaves the
// files restored (3); a gone folder is recreated (12); a crash at any apply
// step leaves the folder half restored (1, 2, 3); a run starts mid-apply (5);
// the bytes only a session's checkpoints hold are missing from its size or
// the disk use, so eviction never sees them, or stay counted once it is
// evicted (23).
const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
let root = "";

beforeEach(() => {
	for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
	root = realpathSync(mkdtempSync(join(tmpdir(), "folder-restore-")));
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

function repository(name: string, files: Record<string, string>) {
	const repo = join(root, name);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	}
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", ".");
	git(
		repo,
		"-c",
		"user.name=Restore test",
		"-c",
		"user.email=restore@example.test",
		"commit",
		"-q",
		"-m",
		"Initial",
	);
	return repo;
}

const run = <A, E>(
	program: Effect.Effect<A, E, SessionDiff | FolderTimeline>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(
			Effect.provide(
				SessionDiffLive(join(root, "config")).pipe(
					Layer.provide(
						Layer.succeed(SessionGit, {
							read: () => Effect.succeed(undefined),
							changes: Stream.never,
							invalidate: () => Effect.void,
						}),
					),
				),
			),
		),
	);

/** One run of `sessionId` in `directories` that applies `edit` while open. */
const turn = (
	sessionId: string,
	runId: string,
	directories: readonly string[],
	edit: () => void,
) =>
	Effect.gen(function* () {
		const timeline = yield* FolderTimeline;
		yield* timeline.runStarted({ sessionId, runId, directories });
		edit();
		yield* timeline.runEnded(runId, () => Effect.void);
	});

/** A file of a checkpoint tree, read from its store. */
const show = (store: string, tree: string, path: string) =>
	git(store, "cat-file", "-p", `${tree}:${path}`);

/** Every kept ref (checkpoints and receipts) in the repository stores. */
const kept = () => {
	const timeline = join(root, "config", "folder-timeline");
	return readdirSync(timeline)
		.filter((name) => name.endsWith(".git"))
		.flatMap((name) =>
			git(
				join(timeline, name),
				"for-each-ref",
				"--format=%(refname)",
				"refs/conduit/sessions",
			)
				.split("\n")
				.filter((ref) => ref !== ""),
		);
};
const checkpointRefs = () =>
	kept().filter((ref) => ref.includes("/checkpoints/"));

it("keeps a run's whole-folder checkpoint past its capture and a collect", async () => {
	const repo = repository("repo", {
		"a.txt": "one\n",
		"sub/b.txt": "kept\n",
	});
	const folder = join(repo, "sub");
	const result = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* turn("s1", "r1", [repo, folder], () => {
				writeFileSync(join(repo, "a.txt"), "two\n");
				writeFileSync(join(folder, "new.txt"), "snapshot only\n");
			});
			yield* timeline.collect(0);
			return {
				whole: yield* timeline.checkpoint("s1", "r1", repo),
				sub: yield* timeline.checkpoint("s1", "r1", folder),
				otherRun: yield* timeline.checkpoint("s1", "r2", repo),
				otherSession: yield* timeline.checkpoint("s2", "r1", repo),
			};
		}),
	);
	expect(result.otherRun).toBeUndefined();
	expect(result.otherSession).toBeUndefined();
	const { whole, sub } = result;
	if (!whole || !sub) throw new Error("No checkpoint");
	expect(whole.prefix).toBe("");
	expect(sub.prefix).toBe("sub/");
	expect(show(whole.store, whole.start, "a.txt")).toBe("one");
	expect(show(whole.store, whole.end, "a.txt")).toBe("two");
	// The snapshot-only blob survives the collect.
	expect(show(sub.store, sub.end, "sub/new.txt")).toBe("snapshot only");
	expect(() => show(sub.store, sub.start, "sub/new.txt")).toThrow();
	expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
});

it("drops a session's checkpoints when it is evicted or forgotten, and only its own", async () => {
	const repo = repository("repo", { "a.txt": "one\n" });
	const result = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			for (const session of ["s1", "s2", "s3"])
				yield* turn(session, `${session}-r`, [repo], () =>
					writeFileSync(join(repo, "a.txt"), `${session}\n`),
				);
			const before = checkpointRefs().length;
			yield* timeline.evict("s1", Effect.succeed(true));
			yield* timeline.forget("s2");
			return {
				before,
				s1: yield* timeline.checkpoint("s1", "s1-r", repo),
				s2: yield* timeline.checkpoint("s2", "s2-r", repo),
				s3: yield* timeline.checkpoint("s3", "s3-r", repo),
			};
		}),
	);
	expect(result.before).toBe(3);
	expect(result.s1).toBeUndefined();
	expect(result.s2).toBeUndefined();
	expect(result.s3).toBeDefined();
	expect(checkpointRefs()).toHaveLength(1);
});

type Entry = string;
/** The folder as a restore must leave it: each path's type, exec bit and bytes or link target. */
const listing = (directory: string): Entry[] =>
	readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter((path) => path !== ".git" && !path.startsWith(".git/"))
		.sort()
		.map((path) => {
			const full = join(directory, path);
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) return `${path} -> ${readlinkSync(full)}`;
			if (stat.isDirectory()) return `${path}/`;
			return `${path} ${stat.mode & 0o111 ? "x" : "-"} ${readFileSync(full, "base64")}`;
		});
/** What a restore must never write: the user's index, HEAD and refs. */
const userState = (repo: string) => [
	git(repo, "ls-files", "-s"),
	git(repo, "rev-parse", "HEAD"),
	git(repo, "for-each-ref"),
];
const receiptRefs = () => kept().filter((ref) => ref.includes("/receipts/"));
/** Polls `done`; a folder caught mid-write (a path gone between listing and reading it) is not done. */
const until = (done: () => boolean): Effect.Effect<void> =>
	Effect.try(done).pipe(
		Effect.orElseSucceed(() => false),
		Effect.flatMap((ok) =>
			ok
				? Effect.void
				: Effect.sleep(10).pipe(Effect.andThen(() => until(done))),
		),
	);

/** A repository a run of s1 reshapes: content, exec bit, link to file, folder to file, delete, add. */
const reshaped = (name: string) => {
	const repo = repository(name, {
		"a.txt": "one\n",
		"run.sh": "#!/bin/sh\n",
		"dir/x.txt": "x\n",
		"gone.txt": "gone\n",
	});
	chmodSync(join(repo, "run.sh"), 0o755);
	symlinkSync("a.txt", join(repo, "link"));
	writeFileSync(join(repo, "staged.txt"), "staged\n");
	git(repo, "add", "staged.txt");
	return repo;
};
const reshape = (repo: string) => () => {
	writeFileSync(join(repo, "a.txt"), "two\n");
	chmodSync(join(repo, "run.sh"), 0o644);
	rmSync(join(repo, "link"));
	writeFileSync(join(repo, "link"), "not a link\n");
	rmSync(join(repo, "dir"), { recursive: true });
	writeFileSync(join(repo, "dir"), "now a file\n");
	rmSync(join(repo, "gone.txt"));
	mkdirSync(join(repo, "new", "deep"), { recursive: true });
	writeFileSync(join(repo, "new", "deep", "n.txt"), "new\n");
};

/** Restores each folder to the start of s1's run r1 as move `moveId`. */
const restoreToStart = (
	directories: readonly string[],
	moveId: string,
	{
		guard = Effect.void,
		journal = Effect.void,
		beforeApply = () => {},
	}: {
		readonly guard?: Effect.Effect<void, string>;
		readonly journal?: Effect.Effect<void, string>;
		readonly beforeApply?: () => void;
	} = {},
) =>
	Effect.gen(function* () {
		const timeline = yield* FolderTimeline;
		const folders = yield* Effect.forEach(directories, (directory) =>
			Effect.gen(function* () {
				const checkpoint = yield* timeline.checkpoint("s1", "r1", directory);
				if (!checkpoint) return yield* Effect.die("No checkpoint");
				const plan = yield* timeline.plan(directory, checkpoint.start);
				return { directory, from: plan.from, to: checkpoint.start, plan };
			}),
		);
		beforeApply();
		yield* timeline.restore({
			sessionId: "s1",
			moveId,
			folders,
			guard,
			journal,
		});
		return folders;
	});

it("counts the bytes only a session's checkpoints hold in its size and the disk use, until it is evicted", async () => {
	const repo = repository("repo", { "a.txt": "one\n" });
	const size = 300_000;
	const result = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			// Untracked and unchanged by the run: only s1's start checkpoint holds it.
			writeFileSync(join(repo, "only-s1.bin"), randomBytes(size));
			yield* turn("s1", "s1-r", [repo], () =>
				writeFileSync(join(repo, "a.txt"), "s1\n"),
			);
			rmSync(join(repo, "only-s1.bin"));
			yield* turn("s2", "s2-r", [repo], () =>
				writeFileSync(join(repo, "a.txt"), "s2\n"),
			);
			const before = {
				s1: yield* timeline.storeBytes("s1"),
				s2: yield* timeline.storeBytes("s2"),
				total: yield* timeline.diskUse,
			};
			yield* timeline.evict("s1", Effect.succeed(true));
			return {
				before,
				after: {
					s1: yield* timeline.storeBytes("s1"),
					total: yield* timeline.diskUse,
				},
			};
		}),
	);
	expect(result.before.s1).toBeGreaterThan(size);
	expect(result.before.s2).toBeLessThan(size);
	expect(result.before.total).toBeGreaterThan(size);
	expect(result.after.s1).toBe(0);
	expect(result.before.total - result.after.total).toBeGreaterThan(size);
});

it("restores a folder to a checkpoint and back byte for byte, never writing the user's index, HEAD or refs", async () => {
	const repo = reshaped("repo");
	const original = listing(repo);
	const user = userState(repo);
	const result = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* turn("s1", "r1", [repo], reshape(repo));
			const ended = listing(repo);
			const [folder] = yield* restoreToStart([repo], "m1");
			const restored = listing(repo);
			const receipt = yield* timeline.receipt("s1", "m1", repo);
			if (!receipt) return yield* Effect.die("No receipt");
			// Undo: back to the receipt's before, as the move found the folder.
			const back = yield* timeline.plan(repo, receipt.before);
			yield* timeline.restore({
				sessionId: "s1",
				moveId: "m2",
				folders: [{ directory: repo, from: back.from, to: receipt.before }],
				guard: Effect.void,
				journal: Effect.void,
			});
			return {
				ended,
				restored,
				changes: folder?.plan.changes,
				undone: listing(repo),
			};
		}),
	);
	expect(
		[...(result.changes ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1)),
	).toEqual([
		{ path: "a.txt", change: "modified" },
		{ path: "dir", change: "deleted" },
		{ path: "dir/x.txt", change: "added" },
		{ path: "gone.txt", change: "added" },
		{ path: "link", change: "modified" },
		{ path: "new/deep/n.txt", change: "deleted" },
		{ path: "run.sh", change: "modified" },
	]);
	expect(result.restored).toEqual(original);
	expect(result.undone).toEqual(result.ended);
	expect(userState(repo)).toEqual(user);
	expect(receiptRefs()).toHaveLength(2);
});

it("refuses a multi-folder restore as changed when a planned file moved on, writing no folder, then restores both", async () => {
	const first = repository("first", { "a.txt": "one\n" });
	const second = repository("second", { "b.txt": "one\n" });
	const result = await run(
		Effect.gen(function* () {
			yield* turn("s1", "r1", [first, second], () => {
				writeFileSync(join(first, "a.txt"), "two\n");
				writeFileSync(join(second, "b.txt"), "two\n");
			});
			const ended = [listing(first), listing(second)];
			const refused = yield* restoreToStart([first, second], "m1", {
				beforeApply: () => writeFileSync(join(second, "b.txt"), "edited\n"),
			}).pipe(Effect.flip);
			const afterRefusal = [listing(first), listing(second)];
			const receipts = receiptRefs();
			writeFileSync(join(second, "b.txt"), "two\n");
			yield* restoreToStart([first, second], "m2");
			return { ended, refused, afterRefusal, receipts };
		}),
	);
	expect(result.refused).toMatchObject({
		_tag: "FolderRestoreRefused",
		reason: "changed",
		directory: second,
		paths: ["b.txt"],
	});
	expect(result.afterRefusal).toEqual([
		result.ended[0],
		[`b.txt - ${Buffer.from("edited\n").toString("base64")}`],
	]);
	expect(result.receipts).toEqual([]);
	expect(readFileSync(join(first, "a.txt"), "utf8")).toBe("one\n");
	expect(readFileSync(join(second, "b.txt"), "utf8")).toBe("one\n");
});

it("rolls the files back when journalling the move fails, and refuses a folder that is gone", async () => {
	const repo = repository("repo", { "a.txt": "one\n" });
	const other = repository("other", { "b.txt": "one\n" });
	const result = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* turn("s1", "r1", [repo, other], () => {
				writeFileSync(join(repo, "a.txt"), "two\n");
				writeFileSync(join(repo, "added.txt"), "added\n");
				writeFileSync(join(other, "b.txt"), "two\n");
			});
			const ended = listing(repo);
			const failed = yield* restoreToStart([repo], "m1", {
				journal: Effect.fail("journal failed"),
			}).pipe(Effect.flip);
			const afterFailure = listing(repo);
			const receipts = receiptRefs();
			const gone = yield* restoreToStart([other, repo], "m2", {
				beforeApply: () => rmSync(repo, { recursive: true }),
			}).pipe(Effect.flip);
			const missingPlan = yield* timeline
				.plan(repo, "4b825dc642cb6eb9a060e54bf8d69288fbee4904")
				.pipe(Effect.flip);
			return { ended, failed, afterFailure, receipts, gone, missingPlan };
		}),
	);
	expect(result.failed).toBe("journal failed");
	expect(result.afterFailure).toEqual(result.ended);
	expect(result.receipts).toEqual([]);
	expect(result.gone).toMatchObject({
		_tag: "FolderRestoreRefused",
		reason: "folder_missing",
		directory: repo,
	});
	expect(result.missingPlan).toMatchObject({ reason: "folder_missing" });
	expect(readFileSync(join(other, "b.txt"), "utf8")).toBe("two\n");
});

const reached = {
	receipt: () => receiptRefs().length === 1,
	deleted: (repo: string) => !existsSync(join(repo, "new")),
	// Every path written, not only the first.
	written: (repo: string, original: readonly Entry[]) =>
		JSON.stringify(listing(repo)) === JSON.stringify(original),
};

it.each([
	["receipt", false],
	["deleted", false],
	["written", false],
	["written", true],
] as const)("after a crash at %s with the move journalled %s, startup leaves the folder as the move found it or restored", async (step, journalled) => {
	const repo = reshaped("repo");
	const original = listing(repo);
	const ended = await run(
		Effect.gen(function* () {
			yield* turn("s1", "r1", [repo], reshape(repo));
			const ended = listing(repo);
			vi.stubEnv("CONDUIT_TEST_RESTORE_PAUSE_AT", step);
			const fiber = yield* restoreToStart([repo], "m1").pipe(Effect.forkChild);
			yield* until(() => reached[step](repo, original));
			yield* Fiber.interrupt(fiber);
			return ended;
		}),
	);
	vi.stubEnv("CONDUIT_TEST_RESTORE_PAUSE_AT", undefined);
	const asked: string[] = [];
	await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* timeline.recoverRestores((sessionId, moveId) =>
				Effect.sync(() => {
					asked.push(`${sessionId}/${moveId}`);
					return journalled;
				}),
			);
		}),
	);
	expect(asked).toEqual(["s1/m1"]);
	expect(listing(repo)).toEqual(journalled ? original : ended);
	expect(receiptRefs()).toHaveLength(journalled ? 1 : 0);
});

it("makes a run's start wait for an apply in its folder", async () => {
	const repo = reshaped("repo");
	const original = listing(repo);
	const result = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* turn("s1", "r1", [repo], reshape(repo));
			vi.stubEnv("CONDUIT_TEST_RESTORE_PAUSE_AT", "deleted");
			const restoring = yield* restoreToStart([repo], "m1").pipe(
				Effect.forkChild,
			);
			yield* until(() => reached.deleted(repo));
			let started = false;
			const starting = yield* timeline
				.runStarted({ sessionId: "s2", runId: "r2", directories: [repo] })
				.pipe(
					Effect.tap(() => Effect.sync(() => (started = true))),
					Effect.forkChild,
				);
			yield* Effect.sleep(300);
			const startedMidApply = started;
			vi.stubEnv("CONDUIT_TEST_RESTORE_PAUSE_AT", undefined);
			yield* Fiber.interrupt(restoring);
			yield* Fiber.join(starting);
			return { startedMidApply, started };
		}),
	);
	expect(result).toEqual({ startedMidApply: false, started: true });
	expect(listing(repo)).not.toEqual(original);
});
