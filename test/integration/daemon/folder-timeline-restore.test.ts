import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
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
// forgetting of its session, or eviction drops another session's (21).
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

/** Every checkpoint ref in the repository stores. */
const checkpointRefs = () => {
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
