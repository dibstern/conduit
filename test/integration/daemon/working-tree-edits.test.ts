import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionDiffFile } from "../../../src/lib/contracts/session-diff.js";
import {
	SessionDiff,
	SessionDiffLive,
} from "../../../src/lib/domain/daemon/Services/session-diff.js";
import { SessionGit } from "../../../src/lib/domain/daemon/Services/session-git.js";
import {
	type WorkingTreeEdit,
	WorkingTreeEdits,
	WorkingTreeEditsLive,
} from "../../../src/lib/domain/daemon/Services/working-tree-edits.js";

// Failure modes: two edits of one file both pass a guard read before either
// wrote, or a guard joins a snapshot taken before the other edit wrote; an
// edit runs while the session's agent runs, or Busy is only a UI check; a hunk
// that no longer applies writes part of itself, or a refused edit touches the
// index or working tree; a hunk stage stages the whole file or edits the
// working tree, and a hunk discard reverts more than its hunk; stage writes the
// index in place, ignores a lock another git holds, deletes that lock, or
// leaves its own; a stage stores a blob other than the one the user saw;
// discard restores HEAD instead of the index, keeps an untracked file, misses
// a deleted one, or restores only one side of a rename; a path outside the
// folder, one never listed, or a glob-like name reaches another file; a
// subfolder's paths resolve from the repository root; Latin-1 bytes are
// re-encoded; a write forgets to invalidate SessionGit, or a refusal does.
const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
let root = "";

beforeEach(() => {
	for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
	root = realpathSync(mkdtempSync(join(tmpdir(), "working-tree-edits-")));
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

function repository(files: Record<string, string | Buffer>) {
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
		"user.name=Edit test",
		"-c",
		"user.email=edit@example.test",
		"commit",
		"-qm",
		"Initial",
	);
	return repo;
}

const read = (path: string) => readFileSync(path, "utf8");
const indexed = (repo: string, path: string) => git(repo, "show", `:${path}`);
const lines = (count: number, label = "line") =>
	Array.from({ length: count }, (_, n) => `${label} ${n}\n`).join("");

const invalidated: string[] = [];
const run = <A, E>(
	program: Effect.Effect<
		A,
		E,
		WorkingTreeEdits | SessionDiff | SqlClient.SqlClient
	>,
): Promise<A> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL)`;
			yield* sql`INSERT INTO sessions (id, status) VALUES ('s', 'idle')`;
			return yield* program;
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WorkingTreeEditsLive.pipe(
					Layer.provideMerge(SessionDiffLive(join(root, "config"))),
					Layer.provideMerge(
						Layer.succeed(SessionGit, {
							read: () => Effect.succeed(undefined),
							changes: Stream.never,
							invalidate: (target) =>
								Effect.sync(() => {
									invalidated.push(JSON.stringify(target));
								}),
						}),
					),
					Layer.provideMerge(
						SqliteNode.layer({ filename: ":memory:" }).pipe(
							Layer.provide(Reactivity.layer),
							Layer.orDie,
						),
					),
				),
			),
		),
	);

beforeEach(() => {
	invalidated.length = 0;
});

const scope = { kind: "unstaged" } as const;
const sessionOf = (folder: string, directory = folder) => ({
	id: "s",
	folders: [{ root: folder, directory, present: true }],
});

/** Lists the folder and returns its files by path, with the listing's revision. */
const list = (folder: string) =>
	Effect.gen(function* () {
		const listing = yield* (yield* SessionDiff).list(sessionOf(folder), scope);
		const [entry] = listing.folders;
		const files = entry && "files" in entry ? entry.files : [];
		return {
			revision: listing.revision,
			files: Object.fromEntries(files.map((file) => [file.path, file])),
		};
	});

const fileEdit = (folder: string, file: SessionDiffFile): WorkingTreeEdit => ({
	session: sessionOf(folder),
	folder,
	path: file.path,
	...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
	expected: file.after,
});

const hunkEdit = (
	folder: string,
	revision: string,
	file: SessionDiffFile,
	index: number,
): WorkingTreeEdit => ({
	...fileEdit(folder, file),
	hunk: { revision, before: file.before ?? "", index },
});

/** "ok", or the refusal's reason. */
const outcome = <R>(
	effect: Effect.Effect<void, { readonly reason: string }, R>,
) =>
	effect.pipe(
		Effect.as("ok"),
		Effect.catch((error) => Effect.succeed(error.reason)),
	);

const discard = (edit: WorkingTreeEdit) =>
	outcome(Effect.flatMap(WorkingTreeEdits, (edits) => edits.discard(edit)));
const stage = (edit: WorkingTreeEdit) =>
	outcome(Effect.flatMap(WorkingTreeEdits, (edits) => edits.stage(edit)));

it("discards each kind of whole-file change to the index, not HEAD, and refuses a second discard as Stale", async () => {
	const repo = repository({
		"modified.txt": "a\nb\n",
		"deleted.txt": "bye\n",
		"z-moved.txt": `${lines(9)}last\n`,
		"staged.txt": "s1\n",
	});
	writeFileSync(join(repo, "modified.txt"), "a\nB\n");
	rmSync(join(repo, "deleted.txt"));
	renameSync(join(repo, "z-moved.txt"), join(repo, "a-renamed.txt"));
	writeFileSync(join(repo, "a-renamed.txt"), `${lines(9)}edited\n`);
	writeFileSync(join(repo, "added.txt"), "new\n");
	writeFileSync(join(repo, "staged.txt"), "s2\n");
	git(repo, "add", "staged.txt");
	writeFileSync(join(repo, "staged.txt"), "s3\n");

	const { outcomes, again, after } = await run(
		Effect.gen(function* () {
			const { files } = yield* list(repo);
			expect(files["a-renamed.txt"]?.oldPath).toBe("z-moved.txt");
			const outcomes: Record<string, string> = {};
			for (const file of Object.values(files))
				outcomes[file.path] = yield* discard(fileEdit(repo, file));
			const modified = files["modified.txt"];
			const again = modified ? yield* discard(fileEdit(repo, modified)) : "";
			return { outcomes, again, after: (yield* list(repo)).files };
		}),
	);

	expect(outcomes).toEqual({
		"a-renamed.txt": "ok",
		"added.txt": "ok",
		"deleted.txt": "ok",
		"modified.txt": "ok",
		"staged.txt": "ok",
	});
	expect(again).toBe("stale");
	expect(after).toEqual({});
	expect(read(join(repo, "modified.txt"))).toBe("a\nb\n");
	expect(read(join(repo, "deleted.txt"))).toBe("bye\n");
	expect(read(join(repo, "z-moved.txt"))).toBe(`${lines(9)}last\n`);
	expect(existsSync(join(repo, "a-renamed.txt"))).toBe(false);
	expect(existsSync(join(repo, "added.txt"))).toBe(false);
	expect(read(join(repo, "staged.txt"))).toBe("s2\n");
	expect(indexed(repo, "staged.txt")).toBe("s2");
	expect(invalidated).toEqual(
		Array(5).fill(JSON.stringify({ sessionId: "s" })),
	);
});

it("lets exactly one of two concurrent discards of one file through; the other is Stale", async () => {
	const repo = repository({ "notes.txt": "one\n" });
	writeFileSync(join(repo, "notes.txt"), "two\n");

	const outcomes = await run(
		Effect.gen(function* () {
			const { files } = yield* list(repo);
			const file = files["notes.txt"];
			if (!file) throw new Error("notes.txt is not listed");
			return yield* Effect.all(
				[discard(fileEdit(repo, file)), discard(fileEdit(repo, file))],
				{ concurrency: "unbounded" },
			);
		}),
	);

	expect([...outcomes].sort()).toEqual(["ok", "stale"]);
	expect(read(join(repo, "notes.txt"))).toBe("one\n");
	expect(invalidated).toHaveLength(1);
});

it("refuses every edit as Busy while the session's agent runs, writing nothing", async () => {
	const repo = repository({ "notes.txt": "one\n" });
	writeFileSync(join(repo, "notes.txt"), "two\n");
	const index = readFileSync(join(repo, ".git", "index"));

	const outcomes = await run(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const { files } = yield* list(repo);
			const file = files["notes.txt"];
			if (!file) throw new Error("notes.txt is not listed");
			const outcomes: string[] = [];
			for (const status of ["busy", "retry"]) {
				yield* sql`UPDATE sessions SET status = ${status} WHERE id = 's'`;
				outcomes.push(yield* discard(fileEdit(repo, file)));
				outcomes.push(yield* stage(fileEdit(repo, file)));
			}
			return outcomes;
		}),
	);

	expect(outcomes).toEqual(["busy", "busy", "busy", "busy"]);
	expect(read(join(repo, "notes.txt"))).toBe("two\n");
	expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
	expect(invalidated).toEqual([]);
});

it("stages one hunk leaving the rest unstaged, then discards one hunk leaving the rest", async () => {
	const repo = repository({ "long.txt": lines(30) });
	const edited = lines(30)
		.replace("line 1\n", "line ONE\n")
		.replace("line 28\n", "line TWENTY-EIGHT\n");
	writeFileSync(join(repo, "long.txt"), edited);

	const { staged, discarded, remaining } = await run(
		Effect.gen(function* () {
			const first = yield* list(repo);
			const file = first.files["long.txt"];
			if (!file) throw new Error("long.txt is not listed");
			const staged = yield* stage(hunkEdit(repo, first.revision, file, 0));
			const second = yield* list(repo);
			const rest = second.files["long.txt"];
			if (!rest) throw new Error("long.txt is not listed again");
			const discarded = yield* discard(
				hunkEdit(repo, second.revision, rest, 0),
			);
			return { staged, discarded, remaining: (yield* list(repo)).files };
		}),
	);

	expect([staged, discarded]).toEqual(["ok", "ok"]);
	const onlyFirst = lines(30).replace("line 1\n", "line ONE\n");
	expect(`${indexed(repo, "long.txt")}\n`).toBe(onlyFirst);
	expect(read(join(repo, "long.txt"))).toBe(onlyFirst);
	expect(remaining).toEqual({});
	expect(invalidated).toHaveLength(2);
});

it("refuses a hunk that no longer applies to the index as Conflict, leaving the index and working tree unchanged", async () => {
	const repo = repository({ "long.txt": lines(30) });
	const edited = lines(30).replace("line 1\n", "line ONE\n");
	writeFileSync(join(repo, "long.txt"), edited);

	const outcomes = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(repo);
			const file = files["long.txt"];
			if (!file) throw new Error("long.txt is not listed");
			// Another client stages a different edit of the same lines; the working tree is as seen.
			writeFileSync(
				join(repo, "long.txt"),
				lines(30).replace("line 1\n", "other\n"),
			);
			git(repo, "add", "long.txt");
			writeFileSync(join(repo, "long.txt"), edited);
			return [
				readFileSync(join(repo, ".git", "index")),
				yield* Effect.flatMap(WorkingTreeEdits, (edits) =>
					edits.stage(hunkEdit(repo, revision, file, 0)),
				).pipe(Effect.flip),
			] as const;
		}),
	);

	const [index, refused] = outcomes;
	// Git's stderr is no sentence for a toast.
	expect(refused).toMatchObject({
		reason: "conflict",
		message: "The hunk no longer applies, so nothing was written",
	});
	expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
	expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
	expect(read(join(repo, "long.txt"))).toBe(edited);
	expect(invalidated).toEqual([]);
});

it("refuses a path that leaves the folder or that git would not list as Stale, and a hunk the patch lacks as Conflict, writing nothing", async () => {
	const repo = repository({ "x.txt": "x\n", "sub/a.txt": "a\n" });
	writeFileSync(join(repo, "x.txt"), "X\n");
	writeFileSync(join(repo, "sub", "a.txt"), "A\n");
	// The folder is inside its repository, so `..` still names a file git could write.
	const folder = join(repo, "sub");
	const edit = (path: string, blob: string): WorkingTreeEdit => ({
		session: sessionOf(folder),
		folder,
		path,
		expected: git(repo, "hash-object", blob),
	});

	const outcomes = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(folder);
			const file = files["a.txt"];
			if (!file) throw new Error("a.txt is not listed");
			return {
				escaped: yield* discard(edit("../x.txt", "x.txt")),
				dotted: yield* discard(edit("./a.txt", "sub/a.txt")),
				missingHunk: yield* Effect.flatMap(WorkingTreeEdits, (edits) =>
					edits.stage(hunkEdit(folder, revision, file, 1)),
				).pipe(
					Effect.flip,
					Effect.map(({ reason, message }) => ({ reason, message })),
				),
			};
		}),
	);

	expect(outcomes).toEqual({
		escaped: "stale",
		dotted: "stale",
		missingHunk: {
			reason: "conflict",
			message: "a.txt has no such hunk to apply alone",
		},
	});
	expect(read(join(repo, "x.txt"))).toBe("X\n");
	expect(read(join(repo, "sub", "a.txt"))).toBe("A\n");
	expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
	expect(invalidated).toEqual([]);
});

it("stages whole files as the blobs the user saw under git's index lock, and refuses while another git holds it", async () => {
	const repo = repository({ "a.txt": "a\n", "z-moved.txt": lines(10) });
	writeFileSync(join(repo, "a.txt"), "A\n");
	renameSync(join(repo, "z-moved.txt"), join(repo, "b-renamed.txt"));
	const lock = join(repo, ".git", "index.lock");

	const { locked, staged, stale, files } = await run(
		Effect.gen(function* () {
			const { files } = yield* list(repo);
			const a = files["a.txt"];
			const renamed = files["b-renamed.txt"];
			if (!a || !renamed) throw new Error("files are not listed");
			writeFileSync(lock, "held by another git");
			const locked = yield* stage(fileEdit(repo, a));
			expect(read(lock)).toBe("held by another git");
			rmSync(lock);
			const staged = [
				yield* stage(fileEdit(repo, a)),
				yield* stage(fileEdit(repo, renamed)),
			];
			writeFileSync(join(repo, "a.txt"), "changed after listing\n");
			const stale = yield* stage(fileEdit(repo, a));
			return { locked, staged, stale, files: { a, renamed } };
		}),
	);

	expect(locked).toBe("conflict");
	expect(staged).toEqual(["ok", "ok"]);
	expect(stale).toBe("stale");
	expect(git(repo, "rev-parse", ":a.txt")).toBe(files.a.after);
	expect(git(repo, "rev-parse", ":b-renamed.txt")).toBe(files.renamed.after);
	expect(git(repo, "ls-files", "z-moved.txt")).toBe("");
	expect(existsSync(lock)).toBe(false);
	expect(invalidated).toHaveLength(2);
});

it("reaches only listed paths inside its own folder, literally, from a subfolder", async () => {
	const repo = repository({
		"app/[id].ts": "glob\n",
		"app/i.ts": "plain\n",
		"sibling.txt": "sibling\n",
	});
	const app = join(repo, "app");
	writeFileSync(join(app, "[id].ts"), "glob edited\n");
	writeFileSync(join(app, "i.ts"), "plain edited\n");
	writeFileSync(join(repo, "sibling.txt"), "sibling edited\n");
	writeFileSync(join(root, "outside.txt"), "outside\n");
	const hash = (path: string) => git(repo, "hash-object", path);

	const outcomes = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(app);
			expect(Object.keys(files).sort()).toEqual(["[id].ts", "i.ts"]);
			const glob = files["[id].ts"];
			const plain = files["i.ts"];
			if (!glob || !plain) throw new Error("app files are not listed");
			const forged = (path: string, expected: string | null) =>
				discard({ ...fileEdit(app, glob), path, expected });
			return {
				outside: yield* forged(
					"../../outside.txt",
					hash(join(root, "outside.txt")),
				),
				sibling: yield* forged(
					"../sibling.txt",
					hash(join(repo, "sibling.txt")),
				),
				absolute: yield* forged(
					join(repo, "sibling.txt"),
					hash(join(repo, "sibling.txt")),
				),
				ghost: yield* forged("ghost.txt", null),
				foreignFolder: yield* discard({ ...fileEdit(app, glob), folder: repo }),
				glob: yield* discard(fileEdit(app, glob)),
				plainAfterGlob: read(join(app, "i.ts")),
				hunk: yield* discard(hunkEdit(app, revision, plain, 0)),
			};
		}),
	);

	expect(outcomes).toEqual({
		outside: "stale",
		sibling: "stale",
		absolute: "stale",
		ghost: "stale",
		foreignFolder: "unavailable",
		glob: "ok",
		plainAfterGlob: "plain edited\n",
		hunk: "ok",
	});
	expect(read(join(app, "[id].ts"))).toBe("glob\n");
	expect(read(join(app, "i.ts"))).toBe("plain\n");
	expect(read(join(repo, "sibling.txt"))).toBe("sibling edited\n");
	expect(read(join(root, "outside.txt"))).toBe("outside\n");
});

it("stages one hunk of a non-UTF-8 file byte for byte", async () => {
	const latin = (text: string) => Buffer.from(text, "latin1");
	const original = lines(30, "caf\xe9");
	const repo = repository({ "latin.txt": latin(original) });
	writeFileSync(
		join(repo, "latin.txt"),
		latin(
			original
				.replace("caf\xe9 1\n", "caf\xe9 \xfcn\n")
				.replace("caf\xe9 28\n", "caf\xe9 \xff\n"),
		),
	);

	const staged = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(repo);
			const file = files["latin.txt"];
			if (!file) throw new Error("latin.txt is not listed");
			return yield* stage(hunkEdit(repo, revision, file, 0));
		}),
	);

	expect(staged).toBe("ok");
	const index = execFileSync("git", ["-C", repo, "show", ":latin.txt"]);
	expect(index).toEqual(
		latin(original.replace("caf\xe9 1\n", "caf\xe9 \xfcn\n")),
	);
});
