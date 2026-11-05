import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunChangesCaptured } from "../../../src/lib/contracts/stored-event.js";
import { FolderTimeline } from "../../../src/lib/domain/daemon/Services/folder-timeline.js";
import {
	SessionDiff,
	SessionDiffLive,
} from "../../../src/lib/domain/daemon/Services/session-diff.js";
import { SessionGit } from "../../../src/lib/domain/daemon/Services/session-git.js";

// Failure modes of run capture at the store seam: a checkpoint misses a
// folder, or diffs repository-wide instead of the folder; a sparse tree keeps
// unchanged paths or drops a deleted one; a captured blob lives only in the
// user's repository, so their rebase and gc break the turn diff; a capture
// writes into the user's repository; a start snapshot's objects are pruned
// before the run ends; a failed or slow folder blocks the run instead of
// recording a gap; overlapping runs of two sessions in one folder are not
// flagged, or runs in different folders are; a joined run records its own
// capture; settled returns before the capture is recorded; forget leaves the
// session's objects or run pins behind; collect drops a live run's pin or
// keeps an orphan's. After a restart: a run whose end checkpoint was lost
// reads Not captured with no reason, or is captured from the folder as it is
// now; a capture waiting at a crash or shutdown is lost (a shutdown unpinned
// it), or takes in files the user or a later run wrote since; a capture packaged before the crash fails on its
// half-written chain or records twice over two restarts; a recorded or deleted
// session's run is captured again; a run still running is captured or loses
// its pins; a pin the old code wrote breaks recovery.
const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
let root = "";

beforeEach(() => {
	for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
	root = realpathSync(mkdtempSync(join(tmpdir(), "folder-capture-")));
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
const commit = (repo: string, ...args: string[]) =>
	git(
		repo,
		"-c",
		"user.name=Capture test",
		"-c",
		"user.email=capture@example.test",
		"commit",
		"-q",
		...args,
	);

function repository(name: string, files: Record<string, string>) {
	const repo = join(root, name);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	}
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", ".");
	commit(repo, "-m", "Initial");
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

/** Ends a run and returns what it recorded, if anything. */
const end = (runId: string) =>
	Effect.gen(function* () {
		const timeline = yield* FolderTimeline;
		const recorded: { sessionId: string; capture: RunChangesCaptured }[] = [];
		yield* timeline.runEnded(runId, (sessionId, capture) =>
			Effect.sync(() => recorded.push({ sessionId, capture })),
		);
		return recorded;
	});

const pins = (store: string) =>
	git(store, "for-each-ref", "--format=%(refname)", "refs/conduit/runs");

/** Resolves once `done` holds, checked on each change in `directory`; the test's timeout bounds it. */
const changed = (directory: string, done: () => boolean) =>
	new Promise<void>((resolve) => {
		const check = () => {
			if (!done()) return;
			watcher.close();
			resolve();
		};
		const watcher = watch(directory, check).on("error", () => watcher.close());
		check();
	});

const timelineDir = () => join(root, "config", "folder-timeline");
/** The timeline's stores as a crash at this instant leaves them. */
const image = (name: string) =>
	cpSync(timelineDir(), join(root, name), { recursive: true });
const restore = (name: string) => {
	rmSync(timelineDir(), { recursive: true, force: true });
	cpSync(join(root, name), timelineDir(), { recursive: true });
};

/** Startup recovery given each pinned run's fate; waits for the ended runs' captures. */
const recover = (
	fates: Record<string, "ended" | "running" | "done">,
	beforeRecord: Effect.Effect<void> = Effect.void,
) =>
	Effect.gen(function* () {
		const timeline = yield* FolderTimeline;
		const asked: string[] = [];
		const recorded: { sessionId: string; capture: RunChangesCaptured }[] = [];
		yield* timeline.recover(
			(sessionId, runId) =>
				Effect.sync(() => {
					asked.push(`${sessionId}/${runId}`);
					return fates[runId] ?? "done";
				}),
			(sessionId, capture) =>
				beforeRecord.pipe(
					Effect.andThen(
						Effect.sync(() => recorded.push({ sessionId, capture })),
					),
				),
		);
		yield* Effect.forEach(
			Object.keys(fates).filter((runId) => fates[runId] === "ended"),
			timeline.settled,
			{ discard: true },
		);
		return { asked: asked.sort(), recorded };
	});

const pathsOf = (recorded: readonly { capture: RunChangesCaptured }[]) =>
	recorded.map(({ capture }) =>
		capture.folders.map((folder) =>
			"changes" in folder ? folder.changes.map(({ path }) => path) : folder,
		),
	);

it("captures each folder's changed paths, survives a user rebase and gc, and forget prunes the session", async () => {
	const app = repository("app", {
		"src/keep.txt": "keep\n",
		"src/edit.txt": "one\ntwo\n",
		"src/sed.txt": "alpha\n",
		"src/gone.txt": "bye\n",
		"outside.txt": "outside\n",
	});
	const lib = repository("lib", { "readme.md": "lib\n" });
	const folder = join(app, "src");
	const userRefs = git(app, "for-each-ref");

	const result = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			const diff = yield* SessionDiff;
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [folder, lib],
			});
			const mainStore = (yield* timeline.snapshot(folder)).store;
			const pinned = pins(mainStore);
			// Old enough to prune: only the pin keeps the start tree alive.
			yield* timeline.collect(0);
			writeFileSync(join(folder, "edit.txt"), "one\nTWO\n");
			writeFileSync(join(folder, "new.txt"), "written\n");
			writeFileSync(join(folder, "sed.txt"), "beta\n");
			rmSync(join(folder, "gone.txt"));
			writeFileSync(join(app, "outside.txt"), "not this folder\n");
			writeFileSync(join(lib, "readme.md"), "lib changed\n");
			const recorded = yield* end("r1");
			const capture = recorded[0]?.capture;
			if (!capture) throw new Error("Nothing recorded");
			const store = timeline.sessionStore("s1");
			const appFolder = capture.folders[0];
			if (!appFolder || !("changes" in appFolder))
				throw new Error("App folder not captured");
			const listing = yield* diff.list(
				{ id: "s1", folders: [], capture },
				{ kind: "turn", turnId: "t1" },
			);
			return {
				recorded,
				pinned,
				pinsAfter: pins(mainStore),
				store,
				appFolder,
				listing,
				before: git(store, "ls-tree", "-r", "--name-only", appFolder.before),
				after: git(store, "ls-tree", "-r", "--name-only", appFolder.after),
			};
		}),
	);

	expect(result.pinned).toBe("refs/conduit/runs/r1/0");
	expect(result.pinsAfter).toBe("");
	expect(result.recorded).toHaveLength(1);
	expect(result.recorded[0]?.sessionId).toBe("s1");
	const { capture } = result.recorded[0] ?? {};
	expect(capture?.runId).toBe("r1");
	expect(capture?.folders.map(({ directory }) => directory)).toEqual([
		folder,
		lib,
	]);
	expect(
		result.appFolder.changes.map(({ path, before, after }) => [
			path,
			before === null ? null : before.mode,
			after === null ? null : after.mode,
		]),
	).toEqual([
		["edit.txt", "100644", "100644"],
		["gone.txt", "100644", null],
		["new.txt", null, "100644"],
		["sed.txt", "100644", "100644"],
	]);
	expect(result.appFolder.shared).toBe(false);
	expect(result.before.split("\n")).toEqual([
		"edit.txt",
		"gone.txt",
		"sed.txt",
	]);
	expect(result.after.split("\n")).toEqual(["edit.txt", "new.txt", "sed.txt"]);
	const [listedApp, listedLib] = result.listing.folders;
	expect(
		listedApp && "files" in listedApp
			? listedApp.files.map(({ path, status }) => [path, status])
			: listedApp,
	).toEqual([
		["edit.txt", "modified"],
		["gone.txt", "deleted"],
		["new.txt", "added"],
		["sed.txt", "modified"],
	]);
	expect(
		listedLib && "files" in listedLib
			? listedLib.files.map(({ path }) => path)
			: listedLib,
	).toEqual(["readme.md"]);
	// The capture never touched the user's repository.
	expect(git(app, "for-each-ref")).toBe(userRefs);
	expect(git(app, "status", "--porcelain")).toContain("src/new.txt");

	// The user rewrites history: the run's before blobs leave their repository.
	const editBefore = result.appFolder.changes[0]?.before?.blob ?? "";
	git(app, "add", "-A");
	commit(app, "--amend", "-m", "Rewritten");
	git(app, "reflog", "expire", "--expire=now", "--all");
	git(app, "gc", "-q", "--prune=now");
	expect(() => git(app, "cat-file", "-e", editBefore)).toThrow();
	rmSync(join(result.store, "objects", "info", "alternates"), { force: true });
	expect(git(result.store, "cat-file", "-p", editBefore)).toBe("one\ntwo");
	expect(
		git(
			result.store,
			"diff-tree",
			"-p",
			result.appFolder.before,
			result.appFolder.after,
			"--",
			"edit.txt",
		),
	).toContain("-two\n+TWO");

	await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* timeline.forget("s1");
		}),
	);
	expect(existsSync(result.store)).toBe(false);
});

it("records a gap and lets the run proceed when a folder cannot be captured", async () => {
	const app = repository("app", { "a.txt": "a\n" });
	const plain = join(root, "not-a-repo");
	mkdirSync(plain);
	const recorded = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [plain, app],
			});
			writeFileSync(join(app, "a.txt"), "b\n");
			return yield* end("r1");
		}),
	);
	const folders = recorded[0]?.capture.folders ?? [];
	expect(folders[0]).toMatchObject({ directory: plain, gap: "failed" });
	expect(folders[1]).toMatchObject({
		directory: app,
		changes: [{ path: "a.txt" }],
	});
});

it("flags runs of two sessions that overlap in one folder, and only those", async () => {
	const app = repository("app", { "a.txt": "a\n" });
	const other = repository("other", { "b.txt": "b\n" });
	const captures = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [app],
			});
			yield* timeline.runStarted({
				sessionId: "s2",
				runId: "r2",
				directories: [app],
			});
			yield* timeline.runStarted({
				sessionId: "s3",
				runId: "r3",
				directories: [other],
			});
			const second = yield* end("r2");
			// s1's next run starts after s2's ended: nothing overlaps it.
			const first = yield* end("r1");
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r4",
				directories: [app],
			});
			return [first, second, yield* end("r3"), yield* end("r4")].map(
				(recorded) => {
					const folder = recorded[0]?.capture.folders[0];
					return folder && "shared" in folder ? folder.shared : folder;
				},
			);
		}),
	);
	expect(captures).toEqual([true, true, false, false]);
});

it("drops a joined run, holds settled until the capture is recorded, and collects only orphan pins", async () => {
	const app = repository("app", { "a.txt": "a\n" });
	const outcome = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [app],
			});
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "joiner",
				directories: [app],
			});
			const store = (yield* timeline.snapshot(app)).store;
			const startedPins = pins(store);
			yield* timeline.runJoined("joiner");
			const joinedRecorded = yield* end("joiner");
			git(
				store,
				"update-ref",
				"refs/conduit/runs/orphan/0",
				git(store, "rev-parse", "refs/conduit/runs/r1/0"),
			);
			yield* timeline.collect(0);
			const collectedPins = pins(store);
			const order: string[] = [];
			const ending = yield* timeline
				.runEnded("r1", () =>
					Effect.sleep("200 millis").pipe(
						Effect.andThen(Effect.sync(() => order.push("recorded"))),
					),
				)
				.pipe(Effect.forkChild);
			yield* Effect.sleep("20 millis");
			yield* timeline.settled("r1");
			order.push("settled");
			yield* Fiber.join(ending);
			return {
				startedPins,
				joinedRecorded,
				collectedPins,
				order,
				endPins: pins(store),
			};
		}),
	);
	expect(outcome.startedPins).toBe(
		"refs/conduit/runs/joiner/0\nrefs/conduit/runs/r1/0",
	);
	expect(outcome.joinedRecorded).toEqual([]);
	expect(outcome.collectedPins).toBe("refs/conduit/runs/r1/0");
	expect(outcome.order).toEqual(["recorded", "settled"]);
	expect(outcome.endPins).toBe("");
});

it("pins each folder's start tree when two worktrees of one repository share a store", async () => {
	const app = repository("app", { "a.txt": "a\n" });
	const second = join(root, "second");
	git(app, "worktree", "add", "-q", "-b", "second", second);
	// Each worktree starts from a tree only the timeline's store holds.
	writeFileSync(join(app, "a.txt"), "app start\n");
	writeFileSync(join(second, "a.txt"), "second\n");
	const folders = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [app, second],
			});
			// Old enough to prune: only the pins keep the start trees alive.
			yield* timeline.collect(0);
			writeFileSync(join(app, "a.txt"), "app\n");
			writeFileSync(join(second, "a.txt"), "second again\n");
			return (yield* end("r1"))[0]?.capture.folders ?? [];
		}),
	);
	expect(
		folders.map((folder) =>
			"changes" in folder ? folder.changes.map(({ path }) => path) : folder,
		),
	).toEqual([["a.txt"], ["a.txt"]]);
});

it("ends a run at its end checkpoint even while an earlier capture is still recording", async () => {
	const app = repository("app", { "a.txt": "a\n" });
	const other = repository("other", { "b.txt": "b\n" });
	const outcome = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [app],
			});
			const first = yield* timeline
				.runEnded("r1", () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			// r1 has ended: a run starting now does not overlap it.
			yield* timeline.runStarted({
				sessionId: "s2",
				runId: "r2",
				directories: [app],
			});
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r3",
				directories: [other],
			});
			writeFileSync(join(other, "during.txt"), "during\n");
			const third = yield* end("r3").pipe(Effect.forkChild);
			yield* Effect.sleep("1 second");
			// Written after r3 ended, while r1 still holds the session's store.
			writeFileSync(join(other, "after.txt"), "after\n");
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(first);
			const ended = yield* Fiber.join(third);
			const second = yield* end("r2");
			const folderOf = (recorded: typeof ended) =>
				recorded[0]?.capture.folders[0];
			const thirdFolder = folderOf(ended);
			const secondFolder = folderOf(second);
			return {
				third:
					thirdFolder && "changes" in thirdFolder
						? thirdFolder.changes.map(({ path }) => path)
						: thirdFolder,
				secondShared:
					secondFolder && "shared" in secondFolder
						? secondFolder.shared
						: secondFolder,
			};
		}),
	);
	expect(outcome).toEqual({ third: ["during.txt"], secondShared: false });
});

it("after a restart records a gap for a run whose end checkpoint was lost, keeps a running run live, and skips an old pin", async () => {
	const app = repository("app", { "a.txt": "a\n" });
	const lib = repository("lib", { "b.txt": "b\n" });
	const stores = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [app],
			});
			yield* timeline.runStarted({
				sessionId: "s2",
				runId: "r2",
				directories: [lib],
			});
			return {
				app: (yield* timeline.snapshot(app)).store,
				lib: (yield* timeline.snapshot(lib)).store,
			};
		}),
	);
	// The daemon died before r1's end checkpoint; the old code pinned bare trees.
	writeFileSync(join(app, "a.txt"), "after the crash\n");
	git(
		stores.app,
		"update-ref",
		"refs/conduit/runs/old/0",
		git(app, "rev-parse", "HEAD^{tree}"),
	);
	const outcome = await run(
		Effect.gen(function* () {
			const recovered = yield* recover({ r1: "ended", r2: "running" });
			const pinned = { app: pins(stores.app), lib: pins(stores.lib) };
			writeFileSync(join(lib, "b.txt"), "r2 wrote this\n");
			return { ...recovered, pinned, r2: yield* end("r2") };
		}),
	);
	expect(outcome.asked).toEqual(["s1/r1", "s2/r2"]);
	expect(outcome.recorded).toEqual([
		{
			sessionId: "s1",
			capture: {
				runId: "r1",
				folders: [
					{
						directory: app,
						gap: "failed",
						message: expect.stringContaining("restarted"),
					},
				],
			},
		},
	]);
	expect(outcome.pinned).toEqual({
		app: "refs/conduit/runs/old/0",
		lib: "refs/conduit/runs/r2/0",
	});
	expect(pathsOf(outcome.r2)).toEqual([[["b.txt"]]]);
});

it("after a shutdown finishes the captures that were waiting, from the folder as each run left it", async () => {
	const app = repository("app", { "a.txt": "a\n" });
	const other = repository("other", { "o.txt": "o\n" });
	const stores = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			const entered = yield* Deferred.make<void>();
			// r0's capture holds s1's store until the crash.
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r0",
				directories: [other],
			});
			yield* timeline
				.runEnded("r0", () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [app],
			});
			yield* timeline.runStarted({
				sessionId: "s2",
				runId: "r2",
				directories: [app],
			});
			const store = (yield* timeline.snapshot(app)).store;
			writeFileSync(join(app, "r1.txt"), "r1\n");
			yield* end("r1").pipe(Effect.forkChild);
			yield* Effect.promise(() =>
				changed(join(store, "refs", "conduit", "runs", "r1"), () =>
					git(
						store,
						"for-each-ref",
						"--format=%(contents:subject)",
						"refs/conduit/runs/r1/",
					).includes('"end"'),
				),
			);
			// A later run in the folder writes before the daemon shuts down,
			// which interrupts r0's and r1's captures.
			writeFileSync(join(app, "r2.txt"), "r2\n");
			return { app: store, other: (yield* timeline.snapshot(other)).store };
		}),
	);
	// The user edits while the daemon is down.
	writeFileSync(join(app, "user.txt"), "user\n");
	const outcome = await run(
		recover({ r0: "done", r1: "ended", r2: "running" }),
	);
	expect(outcome.asked).toEqual(["s1/r0", "s1/r1", "s2/r2"]);
	expect(outcome.recorded.map(({ sessionId }) => sessionId)).toEqual(["s1"]);
	expect(pathsOf(outcome.recorded)).toEqual([[["r1.txt"]]]);
	expect(outcome.recorded[0]?.capture.folders[0]).toMatchObject({
		shared: true,
	});
	expect(pins(stores.app)).toBe("refs/conduit/runs/r2/0");
	expect(pins(stores.other)).toBe("");
});

it("after two restarts records a capture packaged before the crash once, after its session was evicted, and drops a deleted session's run", async () => {
	const app = repository("app", { "a.txt": "a\n" });
	const lib = repository("lib", { "b.txt": "b\n" });
	const stores = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			yield* timeline.runStarted({
				sessionId: "s1",
				runId: "r1",
				directories: [app],
			});
			yield* timeline.runStarted({
				sessionId: "s3",
				runId: "r3",
				directories: [lib],
			});
			writeFileSync(join(app, "r1.txt"), "r1\n");
			// Packed and chained, then the daemon dies before the event is written.
			yield* timeline.runEnded("r1", () =>
				Effect.sync(() => image("packaged")),
			);
			return {
				app: (yield* timeline.snapshot(app)).store,
				lib: (yield* timeline.snapshot(lib)).store,
			};
		}),
	);
	restore("packaged");
	const first = await run(
		Effect.gen(function* () {
			const timeline = yield* FolderTimeline;
			// Eviction's own startup recovery goes first and removes s1's store.
			yield* timeline.evict("s1", Effect.succeed(true));
			const recovered = yield* recover(
				{ r1: "ended", r3: "done" },
				// Crashes again before the event is written.
				Effect.sync(() => image("recorded")),
			);
			return { ...recovered, store: timeline.sessionStore("s1") };
		}),
	);
	expect(first.asked).toEqual(["s1/r1", "s3/r3"]);
	expect(pathsOf(first.recorded)).toEqual([[["r1.txt"]]]);
	const folder = first.recorded[0]?.capture.folders[0];
	if (!folder || !("after" in folder)) throw new Error("Not captured");
	rmSync(join(first.store, "objects", "info", "alternates"), { force: true });
	expect(git(first.store, "ls-tree", "-r", "--name-only", folder.after)).toBe(
		"r1.txt",
	);
	expect(pins(stores.lib)).toBe("");

	restore("recorded");
	const second = await run(recover({ r1: "ended" }));
	expect(second.recorded).toEqual(first.recorded);
	expect(pins(stores.app)).toBe("");

	// Recorded this time: the next restart only unpins it.
	restore("recorded");
	const third = await run(recover({ r1: "done" }));
	expect(third).toEqual({ asked: ["s1/r1"], recorded: [] });
	expect(pins(stores.app)).toBe("");
});
