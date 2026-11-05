import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes: the start checkpoint is taken after the provider starts, so
// edits made during the run are missing; the end checkpoint is never taken or
// never recorded; a second folder is dropped; a turn maps to another turn's
// run; the listing changes once the user commits; a capture writes into the
// user's repository; two sessions running in one folder are not flagged; an
// uncaptured turn lists the worktree instead of saying so; deleting the
// session leaves its captures behind. Both sessions run in both project
// folders, so both folders are shared.
const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of GIT_KEYS) delete gitEnv[key];

const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const commit = (repo: string, message: string) =>
	git(
		repo,
		"-c",
		"user.name=Turn diff test",
		"-c",
		"user.email=turn@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-q",
		"-m",
		message,
	);

/** Content hash of every file that records the repository's state. */
function repositoryBytes(gitDir: string) {
	const hashes: Record<string, string> = {};
	const walk = (path: string) => {
		if (!existsSync(path)) return;
		if (statSync(path).isDirectory()) {
			for (const name of readdirSync(path)) walk(join(path, name));
			return;
		}
		hashes[relative(gitDir, path)] = createHash("sha256")
			.update(readFileSync(path))
			.digest("hex");
	};
	for (const name of ["index", "objects", "refs", "packed-refs", "HEAD"])
		walk(join(gitDir, name));
	return hashes;
}

describe("Turn diffs through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		const root = realpathSync(fixture.root);
		writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
		try {
			await fixture.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/f02e9-8-turn-diff.json",
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("diffs each turn from its run's checkpoints across folders, flags overlapping sessions, and survives a user commit", async () => {
		for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
		harness = ProcessHarness.create({
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				delayMs: 0,
				holdBeforeResult: true,
			},
		});
		const fixture = harness;
		const repo = fixture.projectDir;
		const lib = join(fixture.root, "lib");
		for (const [directory, files] of [
			[repo, { "tracked.txt": "one\ntwo\n", "doomed.txt": "bye\n" }],
			[lib, { "readme.md": "lib\n" }],
		] as const) {
			mkdirSync(directory, { recursive: true });
			git(directory, "init", "-q", "-b", "main");
			for (const [path, text] of Object.entries(files))
				writeFileSync(join(directory, path), text);
			git(directory, "add", ".");
			commit(directory, "Initial commit");
		}
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders: [repo, lib],
		});
		const repoBefore = repositoryBytes(join(repo, ".git"));
		const libBefore = repositoryBytes(join(lib, ".git"));

		const query = <Row>(statement: string, ...params: string[]) => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db.prepare(statement).all(...params) as Row[];
			} finally {
				db.close();
			}
		};
		const turnsOf = (sessionId: string) =>
			query<{ id: string }>(
				"SELECT id FROM turns WHERE session_id = ? ORDER BY requested_at",
				sessionId,
			).map(({ id }) => id);
		const list = (sessionId: string, turnId: string) =>
			sendRpcRequest(socket, {
				_tag: "SessionDiffList",
				sessionId,
				scope: { kind: "turn", turnId },
			});

		const browser = await fixture.connect();
		// Assistant output follows the start checkpoint, which runs before the provider.
		const started = (sessionId: string, cursor: number) =>
			browser.waitFor(
				(frame) =>
					frame["type"] === "transcript_message" &&
					frame["sessionId"] === sessionId &&
					frame["role"] === "assistant",
				cursor,
			);
		const editor = await browser.createSession("Edits both folders");
		const editorCursor = browser.frames.length;
		const editing = browser.send(editor, "Edit both folders.");
		void editing.catch(() => {});
		await started(editor, editorCursor);
		// The agent's edits land while its run is open.
		writeFileSync(join(repo, "tracked.txt"), "one\nTWO\n");
		rmSync(join(repo, "doomed.txt"));
		writeFileSync(join(repo, "fresh.txt"), "hello\n");
		writeFileSync(join(lib, "readme.md"), "lib changed\n");
		const watcher = await browser.createSession("Runs alongside");
		const watcherCursor = browser.frames.length;
		const watching = browser.send(watcher, "Reply with pong.");
		void watching.catch(() => {});
		await started(watcher, watcherCursor);
		writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
		await Promise.all([editing, watching]);
		const repoAfterRun = repositoryBytes(join(repo, ".git"));
		const libAfterRun = repositoryBytes(join(lib, ".git"));

		const [editorTurn = ""] = turnsOf(editor);
		const listing = await list(editor, editorTurn);
		evidence["listing"] = listing;
		const summary = (folders: typeof listing.folders) =>
			folders.map((folder) =>
				"files" in folder
					? {
							folder: folder.folder,
							shared: folder.shared ?? false,
							files: folder.files.map(({ path, status }) => [path, status]),
						}
					: folder,
			);
		expect(summary(listing.folders)).toEqual([
			{
				folder: repo,
				shared: true,
				files: [
					["doomed.txt", "deleted"],
					["fresh.txt", "added"],
					["tracked.txt", "modified"],
				],
			},
			{ folder: lib, shared: true, files: [["readme.md", "modified"]] },
		]);
		expect(listing.notCaptured).toBeUndefined();
		const [watcherTurn = ""] = turnsOf(watcher);
		const watcherListing = await list(watcher, watcherTurn);
		evidence["watcherListing"] = watcherListing;
		expect(summary(watcherListing.folders)).toEqual([
			{ folder: repo, shared: true, files: [] },
			{ folder: lib, shared: true, files: [] },
		]);

		// The user commits the agent's work: the turn still shows what it changed.
		git(repo, "add", "-A");
		commit(repo, "Agent work");
		const relisted = await list(editor, editorTurn);
		expect(summary(relisted.folders)).toEqual(summary(listing.folders));
		const [repoFolder] = relisted.folders;
		const tracked =
			repoFolder && "files" in repoFolder
				? repoFolder.files.find(({ path }) => path === "tracked.txt")
				: undefined;
		const { patch } = await sendRpcRequest(socket, {
			_tag: "SessionDiffFile",
			sessionId: editor,
			scope: { kind: "turn", turnId: editorTurn },
			revision: relisted.revision,
			folder: repo,
			path: "tracked.txt",
			before: tracked?.before ?? null,
			after: tracked?.after ?? null,
		});
		evidence["trackedPatch"] = patch;
		expect(patch).toContain("-two\n+TWO\n");

		const unknown = await list(editor, "no-such-turn");
		evidence["unknownTurn"] = unknown;
		expect(unknown).toMatchObject({ folders: [], notCaptured: true });

		evidence["capturedEvents"] = query<{ data: string }>(
			"SELECT data FROM events WHERE session_id = ? AND type = 'run.changes_captured'",
			editor,
		).length;
		expect(evidence["capturedEvents"]).toBe(1);
		evidence["repositoriesUnchanged"] =
			JSON.stringify([repoAfterRun, libAfterRun]) ===
			JSON.stringify([repoBefore, libBefore]);
		expect([repoAfterRun, libAfterRun]).toEqual([repoBefore, libBefore]);

		const store = join(
			fixture.configDir,
			"folder-timeline",
			"sessions",
			`${createHash("sha256").update(editor).digest("hex").slice(0, 16)}.git`,
		);
		expect(existsSync(store)).toBe(true);
		await browser.deleteSession(editor);
		// Forgetting runs beside the event stream. The editor's capture was
		// recorded long ago, so nothing holds its store and the removal lands
		// well within the watcher's next turn.
		await browser.send(watcher, "Reply with pong again.");
		const [, watcherNext = ""] = turnsOf(watcher);
		const next = await list(watcher, watcherNext);
		// The editor's run is long over, so nothing overlaps this one.
		expect(summary(next.folders)).toEqual([
			{ folder: repo, shared: false, files: [] },
			{ folder: lib, shared: false, files: [] },
		]);
		evidence["storeRemovedOnDelete"] = !existsSync(store);
		expect(evidence["storeRemovedOnDelete"]).toBe(true);
	});
});
