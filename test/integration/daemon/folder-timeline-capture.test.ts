import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunChangesCaptured } from "../../../src/lib/contracts/stored-event.js";
import { FolderTimeline } from "../../../src/lib/domain/daemon/Services/folder-timeline.js";
import {
	SessionDiff,
	SessionDiffLive,
} from "../../../src/lib/domain/daemon/Services/session-diff.js";

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
// keeps an orphan's.
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
		program.pipe(Effect.provide(SessionDiffLive(join(root, "config")))),
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

	expect(result.pinned).toBe("refs/conduit/runs/r1");
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
				"refs/conduit/runs/orphan",
				git(store, "rev-parse", "refs/conduit/runs/r1"),
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
		"refs/conduit/runs/joiner\nrefs/conduit/runs/r1",
	);
	expect(outcome.joinedRecorded).toEqual([]);
	expect(outcome.collectedPins).toBe("refs/conduit/runs/r1");
	expect(outcome.order).toEqual(["recorded", "settled"]);
	expect(outcome.endPins).toBe("");
});
