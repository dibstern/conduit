import { execFileSync } from "node:child_process";
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
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionDiffFile } from "../../../src/lib/contracts/session-diff.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import {
	SessionDiff,
	SessionDiffLive,
} from "../../../src/lib/domain/daemon/Services/session-diff.js";
import { SessionGit } from "../../../src/lib/domain/daemon/Services/session-git.js";
import {
	Subprocess,
	type SubprocessService,
} from "../../../src/lib/domain/daemon/Services/subprocess.js";
import {
	type WorkingTreeEdit,
	WorkingTreeEdits,
	WorkingTreeEditsLive,
} from "../../../src/lib/domain/daemon/Services/working-tree-edits.js";
import { publishRun } from "../../helpers/ledger-tasks.js";

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
/** Runs once, right after the guard's blob read: a save or a turn start in that window. */
let afterGuardRead: Effect.Effect<unknown> | undefined;
/** Runs once, right after a write re-hashes the live file: a save during the write. */
let afterRehash: Effect.Effect<unknown> | undefined;
/** Makes a reverse `git apply` refuse, as for a patch that does not fit. */
let refuseReverseApply = false;

beforeEach(() => {
	afterGuardRead = undefined;
	afterRehash = undefined;
	refuseReverseApply = false;
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

const racedSubprocess = Layer.effect(
	Subprocess,
	Effect.gen(function* () {
		const base = yield* Subprocess;
		return {
			...base,
			run: (command, args, options) =>
				refuseReverseApply && args[0] === "apply" && args.includes("-R")
					? Effect.succeed({
							stdout: "",
							stderr: "error: patch failed",
							exitCode: 1,
						})
					: base.run(command, args, options).pipe(
							Effect.tap(() => {
								if (args.includes("--batch-check=%(objectname)")) {
									const race = afterGuardRead;
									afterGuardRead = undefined;
									return race ?? Effect.void;
								}
								// The write's re-hash of the live file names its path; the scratch blob's does not.
								if (
									args.includes("hash-object") &&
									args.some((arg) => arg.startsWith("--path="))
								) {
									const race = afterRehash;
									afterRehash = undefined;
									return race ?? Effect.void;
								}
								return Effect.void;
							}),
						),
		} satisfies SubprocessService;
	}),
);

const invalidated: string[] = [];
const run = <A, E>(
	program: Effect.Effect<
		A,
		E,
		WorkingTreeEdits | SessionDiff | SessionActivityTag
	>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(
			Effect.scoped,
			Effect.provide(
				WorkingTreeEditsLive.pipe(
					Layer.provideMerge(SessionDiffLive(join(root, "config"))),
					Layer.provideMerge(
						Layer.effect(SessionActivityTag, makeSessionActivity),
					),
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
					Layer.provide(racedSubprocess),
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
			const { background } = yield* SessionActivityTag;
			const { files } = yield* list(repo);
			const file = files["notes.txt"];
			if (!file) throw new Error("notes.txt is not listed");
			// The Run Ledger holds the session's active Run (8.1).
			publishRun(background, "s");
			return [
				yield* discard(fileEdit(repo, file)),
				yield* stage(fileEdit(repo, file)),
			];
		}),
	);

	expect(outcomes).toEqual(["busy", "busy"]);
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

it("refuses an edit whose file is saved, or whose session starts a turn, after the guard read it, writing nothing", async () => {
	const repo = repository({
		"tracked.txt": "t1\n",
		"staged.txt": "s1\n",
		"busy.txt": "b1\n",
		"gone.txt": "g1\n",
	});
	writeFileSync(join(repo, "tracked.txt"), "t2\n");
	writeFileSync(join(repo, "gone.txt"), "g2\n");
	writeFileSync(join(repo, "staged.txt"), "s2\n");
	writeFileSync(join(repo, "busy.txt"), "b2\n");
	writeFileSync(join(repo, "new.txt"), "new\n");
	const index = readFileSync(join(repo, ".git", "index"));
	const save = (path: string) =>
		Effect.sync(() => writeFileSync(join(repo, path), "saved\n"));

	const outcomes = await run(
		Effect.gen(function* () {
			const { background } = yield* SessionActivityTag;
			const { files } = yield* list(repo);
			const edit = (path: string) => {
				const file = files[path];
				if (!file) throw new Error(`${path} is not listed`);
				return fileEdit(repo, file);
			};
			const raced = <A, R>(
				race: Effect.Effect<unknown>,
				effect: Effect.Effect<A, never, R>,
			) =>
				Effect.suspend(() => {
					afterGuardRead = race;
					return effect;
				});
			return {
				discardTracked: yield* raced(
					save("tracked.txt"),
					discard(edit("tracked.txt")),
				),
				discardUntracked: yield* raced(
					save("new.txt"),
					discard(edit("new.txt")),
				),
				stage: yield* raced(save("staged.txt"), stage(edit("staged.txt"))),
				discardDeleted: yield* raced(
					Effect.sync(() => rmSync(join(repo, "gone.txt"))),
					discard(edit("gone.txt")),
				),
				turnStarts: yield* raced(
					Effect.sync(() => publishRun(background, "s")),
					discard(edit("busy.txt")),
				),
			};
		}),
	);

	expect(outcomes).toEqual({
		discardTracked: "stale",
		discardUntracked: "stale",
		stage: "stale",
		discardDeleted: "stale",
		turnStarts: "busy",
	});
	for (const path of ["tracked.txt", "new.txt", "staged.txt"])
		expect(read(join(repo, path))).toBe("saved\n");
	expect(read(join(repo, "busy.txt"))).toBe("b2\n");
	expect(existsSync(join(repo, "gone.txt"))).toBe(false);
	expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
	expect(git(repo, "status", "--porcelain", "--ignored")).not.toContain(
		"conduit",
	);
	expect(
		readdirSync(join(repo, ".git")).filter((name) => name.includes("conduit")),
	).toEqual([]);
	expect(invalidated).toEqual([]);
});

it("puts a discarded file back when git cannot write the index copy, leaving nothing aside", async () => {
	const repo = repository({ "notes.txt": "one\n" });
	writeFileSync(join(repo, ".gitattributes"), "notes.txt filter=broken\n");
	git(repo, "config", "filter.broken.clean", "cat");
	git(repo, "config", "filter.broken.smudge", "false");
	git(repo, "config", "filter.broken.required", "true");
	writeFileSync(join(repo, "notes.txt"), "two\n");

	const result = await run(
		Effect.gen(function* () {
			const { files } = yield* list(repo);
			const file = files["notes.txt"];
			if (!file) throw new Error("notes.txt is not listed");
			return yield* discard(fileEdit(repo, file));
		}),
	);

	expect(result).not.toBe("ok");
	expect(read(join(repo, "notes.txt"))).toBe("two\n");
	expect(
		readdirSync(join(repo, ".git")).filter((name) => name.includes("conduit")),
	).toEqual([]);
	expect(invalidated).toEqual([]);
});

it("discards a retargeted symlink to the link the index holds, and keeps one retargeted after the guard read it", async () => {
	const repo = repository({ "a.txt": "a\n", "b.txt": "b\n" });
	for (const name of ["link", "raced"]) {
		symlinkSync("a.txt", join(repo, name));
		git(repo, "add", name);
		rmSync(join(repo, name));
		symlinkSync("b.txt", join(repo, name));
	}

	const outcomes = await run(
		Effect.gen(function* () {
			const { files } = yield* list(repo);
			const edit = (path: string) => {
				const file = files[path];
				if (!file) throw new Error(`${path} is not listed`);
				return fileEdit(repo, file);
			};
			const discarded = yield* discard(edit("link"));
			afterGuardRead = Effect.sync(() => {
				rmSync(join(repo, "raced"));
				symlinkSync("saved.txt", join(repo, "raced"));
			});
			return { discarded, raced: yield* discard(edit("raced")) };
		}),
	);

	expect(outcomes).toEqual({ discarded: "ok", raced: "stale" });
	expect(readlinkSync(join(repo, "link"))).toBe("a.txt");
	expect(readlinkSync(join(repo, "raced"))).toBe("saved.txt");
	expect(
		readdirSync(join(repo, ".git")).filter((name) => name.includes("conduit")),
	).toEqual([]);
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

// A hunk discard builds the new file from the blob the user saw and renames it
// over the live file only while that file is still the one it hashed. Failure
// modes: a save after the guard or during the write is overwritten or has the
// hunk reversed onto it; two discards of one file both write; a file deleted,
// or replaced by a symlink, a directory or a symlinked parent, is recreated or
// written through; the mode or CRLF endings are lost; a refused or failed
// write leaves part of itself or a temp file behind.
const twoHunks = (text: string) =>
	text
		.replace("line 1\n", "line ONE\n")
		.replace("line 28\n", "line TWENTY-EIGHT\n");
const firstUndone = (text: string) =>
	text.replace("line 28\n", "line TWENTY-EIGHT\n");
const secondUndone = (text: string) => text.replace("line 1\n", "line ONE\n");
const crlf = (text: string) => text.replaceAll("\n", "\r\n");
const conduitLeftovers = (directory: string) =>
	readdirSync(directory).filter((name) => name.includes("conduit"));

it("refuses a hunk discard as Stale when the file is saved after the guard or during the write, keeping the saved bytes", async () => {
	const repo = repository({ "guard.txt": lines(30), "write.txt": lines(30) });
	for (const path of ["guard.txt", "write.txt"])
		writeFileSync(join(repo, path), twoHunks(lines(30)));
	// The save keeps the hunk, so reversing it onto the saved bytes would apply.
	const saved = twoHunks(lines(30)).replace("line 15\n", "saved 15\n");
	const save = (path: string) =>
		Effect.sync(() => writeFileSync(join(repo, path), saved));

	const outcomes = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(repo);
			const edit = (path: string) => {
				const file = files[path];
				if (!file) throw new Error(`${path} is not listed`);
				return hunkEdit(repo, revision, file, 0);
			};
			afterGuardRead = save("guard.txt");
			const afterGuard = yield* discard(edit("guard.txt"));
			afterRehash = save("write.txt");
			const duringWrite = yield* discard(edit("write.txt"));
			return { afterGuard, duringWrite };
		}),
	);

	const evidence = {
		outcomes,
		"guard.txt": read(join(repo, "guard.txt")),
		"write.txt": read(join(repo, "write.txt")),
		leftovers: [
			...conduitLeftovers(repo),
			...conduitLeftovers(join(repo, ".git")),
		],
		invalidated,
	};
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/f02e9-11-hunk-discard-race.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	expect(evidence).toEqual({
		outcomes: { afterGuard: "stale", duringWrite: "stale" },
		"guard.txt": saved,
		"write.txt": saved,
		leftovers: [],
		invalidated: [],
	});
});

it("lets one of two concurrent hunk discards of one file through, for different hunks and for the same hunk", async () => {
	const repo = repository({
		"different.txt": lines(30),
		"same.txt": lines(30),
	});
	for (const path of ["different.txt", "same.txt"])
		writeFileSync(join(repo, path), twoHunks(lines(30)));

	const { different, same } = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(repo);
			const edit = (path: string, index: number) => {
				const file = files[path];
				if (!file) throw new Error(`${path} is not listed`);
				return hunkEdit(repo, revision, file, index);
			};
			const both = (a: WorkingTreeEdit, b: WorkingTreeEdit) =>
				Effect.all([discard(a), discard(b)], { concurrency: "unbounded" });
			return {
				different: yield* both(
					edit("different.txt", 0),
					edit("different.txt", 1),
				),
				same: yield* both(edit("same.txt", 0), edit("same.txt", 0)),
			};
		}),
	);

	expect([...different].sort()).toEqual(["ok", "stale"]);
	expect([...same].sort()).toEqual(["ok", "stale"]);
	expect(read(join(repo, "different.txt"))).toBe(
		different[0] === "ok" ? firstUndone(lines(30)) : secondUndone(lines(30)),
	);
	expect(read(join(repo, "same.txt"))).toBe(firstUndone(lines(30)));
	expect(invalidated).toHaveLength(2);
});

it("refuses a hunk discard as Stale when the file is deleted, or replaced by a symlink, a directory or a symlinked parent after the guard", async () => {
	const repo = repository({
		"gone.txt": lines(30),
		"linked.txt": lines(30),
		"dir.txt": lines(30),
		"sub/inner.txt": lines(30),
	});
	for (const path of ["gone.txt", "linked.txt", "dir.txt", "sub/inner.txt"])
		writeFileSync(join(repo, path), twoHunks(lines(30)));
	// Outside the folder, the same bytes the user saw, so only the path can tell them apart.
	const outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "inner.txt"), twoHunks(lines(30)));

	const outcomes = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(repo);
			const raced = (path: string, race: () => void) => {
				const file = files[path];
				if (!file) throw new Error(`${path} is not listed`);
				afterGuardRead = Effect.sync(race);
				return discard(hunkEdit(repo, revision, file, 0));
			};
			return {
				deleted: yield* raced("gone.txt", () => rmSync(join(repo, "gone.txt"))),
				symlink: yield* raced("linked.txt", () => {
					rmSync(join(repo, "linked.txt"));
					symlinkSync(join(outside, "inner.txt"), join(repo, "linked.txt"));
				}),
				directory: yield* raced("dir.txt", () => {
					rmSync(join(repo, "dir.txt"));
					mkdirSync(join(repo, "dir.txt"));
				}),
				symlinkedParent: yield* raced("sub/inner.txt", () => {
					renameSync(join(repo, "sub"), join(root, "sub-moved"));
					symlinkSync(outside, join(repo, "sub"));
				}),
			};
		}),
	);

	expect(outcomes).toEqual({
		deleted: "stale",
		symlink: "stale",
		directory: "stale",
		symlinkedParent: "stale",
	});
	expect(existsSync(join(repo, "gone.txt"))).toBe(false);
	expect(lstatSync(join(repo, "linked.txt")).isSymbolicLink()).toBe(true);
	expect(lstatSync(join(repo, "dir.txt")).isDirectory()).toBe(true);
	expect(readdirSync(outside)).toEqual(["inner.txt"]);
	expect(read(join(outside, "inner.txt"))).toBe(twoHunks(lines(30)));
	expect(conduitLeftovers(repo)).toEqual([]);
	expect(invalidated).toEqual([]);
});

it("keeps the file's mode and its line endings through a hunk discard", async () => {
	const repo = repository({
		".gitattributes": "crlf.txt text eol=crlf\n",
		"crlf.txt": lines(30),
		"raw.txt": crlf(lines(30)),
		"tool.sh": lines(30),
	});
	chmodSync(join(repo, "tool.sh"), 0o700);
	git(repo, "add", "tool.sh");
	git(
		repo,
		"-c",
		"user.name=Edit test",
		"-c",
		"user.email=edit@example.test",
		"commit",
		"-qm",
		"Executable",
	);
	writeFileSync(join(repo, "crlf.txt"), crlf(twoHunks(lines(30))));
	writeFileSync(join(repo, "raw.txt"), crlf(twoHunks(lines(30))));
	writeFileSync(join(repo, "tool.sh"), twoHunks(lines(30)));

	const outcomes = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(repo);
			const outcomes: Record<string, string> = {};
			for (const path of ["crlf.txt", "raw.txt", "tool.sh"]) {
				const file = files[path];
				if (!file) throw new Error(`${path} is not listed`);
				outcomes[path] = yield* discard(hunkEdit(repo, revision, file, 0));
			}
			return outcomes;
		}),
	);

	expect(outcomes).toEqual({
		"crlf.txt": "ok",
		"raw.txt": "ok",
		"tool.sh": "ok",
	});
	expect(read(join(repo, "crlf.txt"))).toBe(crlf(firstUndone(lines(30))));
	expect(read(join(repo, "raw.txt"))).toBe(crlf(firstUndone(lines(30))));
	expect(read(join(repo, "tool.sh"))).toBe(firstUndone(lines(30)));
	expect(statSync(join(repo, "tool.sh")).mode & 0o777).toBe(0o700);
});

it("refuses a hunk discard whose reverse patch git refuses as Conflict, writing nothing", async () => {
	const repo = repository({ "long.txt": lines(30) });
	writeFileSync(join(repo, "long.txt"), twoHunks(lines(30)));

	const refused = await run(
		Effect.gen(function* () {
			const { revision, files } = yield* list(repo);
			const file = files["long.txt"];
			if (!file) throw new Error("long.txt is not listed");
			refuseReverseApply = true;
			return yield* Effect.flatMap(WorkingTreeEdits, (edits) =>
				edits.discard(hunkEdit(repo, revision, file, 0)),
			).pipe(
				Effect.flip,
				Effect.map(({ reason, message }) => ({ reason, message })),
			);
		}),
	);

	expect(refused).toEqual({
		reason: "conflict",
		message: "The hunk no longer applies, so nothing was written",
	});
	expect(read(join(repo, "long.txt"))).toBe(twoHunks(lines(30)));
	expect(conduitLeftovers(repo)).toEqual([]);
	expect(invalidated).toEqual([]);
});

it("leaves the file whole and no temp file behind when the discarded hunk cannot be written", async () => {
	const repo = repository({ "sub/long.txt": lines(30) });
	writeFileSync(join(repo, "sub", "long.txt"), twoHunks(lines(30)));
	chmodSync(join(repo, "sub"), 0o555);

	try {
		const result = await run(
			Effect.gen(function* () {
				const { revision, files } = yield* list(repo);
				const file = files["sub/long.txt"];
				if (!file) throw new Error("sub/long.txt is not listed");
				return yield* discard(hunkEdit(repo, revision, file, 0));
			}),
		);
		expect(result).toBe("unavailable");
	} finally {
		chmodSync(join(repo, "sub"), 0o755);
	}
	expect(read(join(repo, "sub", "long.txt"))).toBe(twoHunks(lines(30)));
	expect(conduitLeftovers(join(repo, "sub"))).toEqual([]);
	expect(invalidated).toEqual([]);
});
