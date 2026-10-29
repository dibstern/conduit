import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDiffListing } from "../../../src/lib/contracts/session-diff.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes: a tool's diff is read from disk or the turn's capture instead
// of the tool's own record; a provider patch with absolute or unprefixed
// headers renders under the wrong path or not at all; a Write the provider
// calls a new file is listed as added although the file was there when the
// run started; a real new file is flagged as replacing one; a shell tool
// lists the files its turn changed; an event recorded before Tool File
// Changes existed lists nothing instead of what its input declares, or is
// labelled as the provider's report; another session's tool id, or an unknown
// one, lists files; file() serves a path the tool's listing did not name.
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

const EDIT = "toolu_toolfilechangesEdit1";
const REPLACING_WRITE = "toolu_toolfilechangesWrite2";
const NEW_WRITE = "toolu_toolfilechangesWrite3";
const SHELL = "toolu_toolfilechangesBash4";

describe("Tool-call diffs through the built daemon", () => {
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
				"test-results/f02e9-9-tool-call-diff.json",
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("lists each tool's own reported change with a git-style patch, checks a claimed new file against the run start, and falls back to tool input for an old event", async () => {
		for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
		const replay = {
			turns: ["tool-file-changes-turn"] as const,
			tracesDir: "",
			delayMs: 0,
			holdBeforeResult: true,
		};
		harness = ProcessHarness.create({ claudeReplay: replay });
		const fixture = harness;
		const repo = fixture.projectDir;
		// The recording's tools name files in the capture's repo; replay them in this one.
		replay.tracesDir = join(fixture.root, "traces");
		mkdirSync(replay.tracesDir);
		writeFileSync(
			join(replay.tracesDir, "tool-file-changes-turn.jsonl"),
			readFileSync(
				"test/fixtures/claude-sdk-traces/tool-file-changes-turn.jsonl",
				"utf8",
			).replaceAll("/tmp/conduit-worktree-capture/repo", repo),
		);
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "notes.txt"), "old notes\n");
		git(repo, "add", ".");
		git(
			repo,
			"-c",
			"user.name=Tool diff test",
			"-c",
			"user.email=tool@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-q",
			"-m",
			"Initial commit",
		);
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders: [repo],
		});

		const browser = await fixture.connect();
		const session = await browser.createSession("Edits by tool");
		const cursor = browser.frames.length;
		const running = browser.send(session, "Edit the files.");
		void running.catch(() => {});
		await browser.waitFor(
			(frame) =>
				frame["type"] === "transcript_message" &&
				frame["sessionId"] === session &&
				frame["role"] === "assistant",
			cursor,
		);
		// The disk follows what the tools did while the run is open.
		writeFileSync(join(repo, "tracked.txt"), "one\nTWO\n");
		writeFileSync(join(repo, "notes.txt"), "new notes\n");
		writeFileSync(join(repo, "fresh.txt"), "hello\n");
		writeFileSync(join(repo, "shell.txt"), "shell\n");
		writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
		await running;

		const list = (toolId: string, sessionId = session) =>
			sendRpcRequest(socket, {
				_tag: "SessionDiffList",
				sessionId,
				scope: { kind: "toolCall", toolId },
			});
		const patchOf = (
			toolId: string,
			listing: SessionDiffListing,
			path: string,
		) => {
			const [folder] = listing.folders;
			const file =
				folder && "files" in folder
					? folder.files.find((entry) => entry.path === path)
					: undefined;
			return sendRpcRequest(socket, {
				_tag: "SessionDiffFile",
				sessionId: session,
				scope: { kind: "toolCall", toolId },
				revision: listing.revision,
				folder: folder?.folder ?? "",
				path,
				before: file?.before ?? null,
				after: file?.after ?? null,
			});
		};
		const summary = (listing: SessionDiffListing) => ({
			source: listing.source,
			folders: listing.folders.map((folder) =>
				"files" in folder
					? {
							folder: folder.folder,
							files: folder.files.map((file) => [
								file.path,
								file.status,
								"insertions" in file ? file.insertions : null,
								"deletions" in file ? file.deletions : null,
							]),
						}
					: folder,
			),
		});

		const edit = await list(EDIT);
		evidence["edit"] = { listing: edit };
		expect(summary(edit)).toEqual({
			source: "provider",
			folders: [{ folder: repo, files: [["tracked.txt", "modified", 1, 1]] }],
		});
		const editPatch = await patchOf(EDIT, edit, "tracked.txt");
		evidence["edit"] = { listing: edit, patch: editPatch };
		expect(editPatch).toEqual({
			patch: [
				"diff --git a/tracked.txt b/tracked.txt",
				"--- a/tracked.txt",
				"+++ b/tracked.txt",
				"@@ -1,2 +1,2 @@",
				" one",
				"-two",
				"+TWO",
				"",
			].join("\n"),
		});

		const replacing = await list(REPLACING_WRITE);
		const replacingPatch = await patchOf(
			REPLACING_WRITE,
			replacing,
			"notes.txt",
		);
		evidence["replacingWrite"] = { listing: replacing, patch: replacingPatch };
		expect(summary(replacing)).toEqual({
			source: "provider",
			folders: [{ folder: repo, files: [["notes.txt", "modified", 1, 0]] }],
		});
		expect(replacingPatch.notes).toEqual(["replaced"]);
		expect(replacingPatch.patch).toContain(
			"--- a/notes.txt\n+++ b/notes.txt\n",
		);
		expect(replacingPatch.patch).toContain("+new notes\n");

		const created = await list(NEW_WRITE);
		const createdPatch = await patchOf(NEW_WRITE, created, "fresh.txt");
		evidence["newWrite"] = { listing: created, patch: createdPatch };
		expect(summary(created)).toEqual({
			source: "provider",
			folders: [{ folder: repo, files: [["fresh.txt", "added", 1, 0]] }],
		});
		expect(createdPatch).toEqual({
			patch: [
				"diff --git a/fresh.txt b/fresh.txt",
				"--- /dev/null",
				"+++ b/fresh.txt",
				"@@ -0,0 +1,1 @@",
				"+hello",
				"",
			].join("\n"),
		});

		// A shell tool reports no file changes; its writes show in the turn diff.
		const shell = await list(SHELL);
		evidence["shell"] = shell;
		expect(summary(shell).folders).toEqual([]);

		await expect(patchOf(EDIT, edit, "notes.txt")).rejects.toMatchObject({
			reason: "not-listed",
		});
		const other = await browser.createSession("Another session");
		expect(summary(await list(EDIT, other))).toEqual({
			source: undefined,
			folders: [],
		});
		expect(summary(await list("toolu_unknown"))).toEqual({
			source: undefined,
			folders: [],
		});

		// An event recorded before Tool File Changes carries only its input.
		const db = new Database(fixture.daemonStorePath());
		try {
			const updated = db
				.prepare(
					"UPDATE message_parts SET metadata = json_remove(metadata, '$.fileChanges') WHERE call_id = ?",
				)
				.run(EDIT);
			expect(updated.changes).toBe(1);
		} finally {
			db.close();
		}
		const legacy = await list(EDIT);
		const legacyPatch = await patchOf(EDIT, legacy, "tracked.txt");
		evidence["legacyEdit"] = { listing: legacy, patch: legacyPatch };
		expect(summary(legacy)).toEqual({
			source: "toolInput",
			folders: [{ folder: repo, files: [["tracked.txt", "modified", 1, 1]] }],
		});
		expect(legacyPatch.patch).toContain("-two\n");
		expect(legacyPatch.patch).toContain("+TWO\n");
	});
});
