import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
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

// Failure modes beyond the process E2E: a subfolder lists or serves paths
// relative to the repository instead of itself, or leaks changes outside it; a
// worktree rename loses its old path or its patch; a missing or non-git folder
// fails the whole listing; collect prunes a snapshot still inside its grace
// period, or keeps one past it so Gone never comes.
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
const present = (directory: string) => ({
	root: directory,
	directory,
	present: true,
});

it("lists a subfolder relative to itself, keeps a rename's old path, and serves both patches", async () => {
	const repo = repository({
		"sub/edited.txt": "before\n",
		"sub/moved.txt": "a long enough line to be detected as a rename\n",
		"outside.txt": "outside\n",
	});
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
		{ path: "edited.txt", status: "modified", oldPath: undefined },
		{ path: "renamed.txt", status: "renamed", oldPath: "moved.txt" },
	]);
	expect(patches[0]).toContain("-before\n+after\n");
	expect(patches[1]).toContain("rename from moved.txt\nrename to renamed.txt");
});

it("reports missing and non-git folders as unavailable beside a listed one", async () => {
	const repo = repository({ "tracked.txt": "one\n" });
	writeFileSync(join(repo, "tracked.txt"), "two\n");
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
				? folder.files.map(({ path }) => path)
				: [folder.folder, folder.error],
		),
	).toEqual([
		["tracked.txt"],
		[plain, "unavailable"],
		[missing, "unavailable"],
	]);
});

it("collect keeps a snapshot inside its grace period and drops it after", async () => {
	const repo = repository({ "tracked.txt": "one\n" });
	writeFileSync(join(repo, "tracked.txt"), "two\n");

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
					before: git(repo, "rev-parse", ":tracked.txt"),
					after: git(repo, "hash-object", "tracked.txt"),
				})
				.pipe(
					Effect.match({
						onSuccess: ({ patch }) => patch.includes("+two"),
						onFailure: ({ reason }) => reason,
					}),
				);
			yield* timeline.collect(60_000);
			const kept = yield* read;
			yield* timeline.collect(0);
			return { kept, collected: yield* read };
		}),
	);

	expect(outcomes).toEqual({ kept: true, collected: "gone" });
});
