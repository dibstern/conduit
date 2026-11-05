import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes through the built daemon: two clients discarding the same
// listed file both write, or both refuse; a discard lands while the session's
// agent runs; the browser's error reason is lost on the wire (a generic
// WsRpcError instead of Stale or Busy); a hunk stage stages the whole file;
// an edit leaves the listing stale.
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

const lines = (count: number, edit?: number) =>
	Array.from({ length: count }, (_, n) =>
		n === edit || n === count - 1 - (edit ?? -1) ? `EDIT ${n}` : `line ${n}`,
	).join("\n");

const outcome = (reply: Promise<unknown>) =>
	reply.then(
		() => "ok",
		(error: { _tag?: string; reason?: string }) =>
			`${error._tag}:${error.reason}`,
	);

describe("Working tree edits through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		const root = realpathSync(fixture.root);
		try {
			writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
			await fixture.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/f02e9-11-working-tree-edits.json",
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			evidence = {};
			vi.unstubAllEnvs();
		}
	});

	it("refuses while the agent runs, lets exactly one of two clients discard, and stages one hunk", async () => {
		for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
		harness = ProcessHarness.create({
			claudeReplay: {
				turns: ["pong-thinking-text-turn"],
				delayMs: 0,
				holdBeforeResult: true,
			},
		});
		const fixture = harness;
		const repo = fixture.projectDir;
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "b.txt"), `${lines(40)}\n`);
		git(repo, "add", ".");
		git(
			repo,
			"-c",
			"user.name=Edit test",
			"-c",
			"user.email=edit@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-q",
			"-m",
			"Initial commit",
		);
		writeFileSync(join(repo, "a.txt"), "one\nTWO\n");
		writeFileSync(join(repo, "b.txt"), `${lines(40, 1)}\n`);

		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Edits");
		const scope = { kind: "unstaged" } as const;
		const list = async () => {
			const listing = await sendRpcRequest(socket, {
				_tag: "SessionDiffList",
				sessionId,
				scope,
			});
			const [folder] = listing.folders;
			if (!folder || !("files" in folder)) throw new Error("Missing folder");
			return {
				revision: listing.revision,
				files: Object.fromEntries(
					folder.files.map((file) => [file.path, file]),
				),
			};
		};
		const edit = (
			tag: "SessionDiffDiscard" | "SessionDiffStage",
			path: string,
			expected: string | null | undefined,
			hunk?: { revision: string; before: string; index: number },
		) => {
			const request = {
				sessionId,
				folder: repo,
				path,
				expected: expected ?? null,
				...(hunk ? { hunk } : {}),
			};
			return tag === "SessionDiffDiscard"
				? sendRpcRequest(socket, { _tag: tag, ...request })
				: sendRpcRequest(socket, { _tag: tag, ...request });
		};

		const listed = await list();
		const a = listed.files["a.txt"];

		// A running turn refuses every edit and writes nothing.
		const cursor = browser.frames.length;
		const running = browser.send(sessionId, "Reply with pong.");
		void running.catch(() => {});
		await browser.waitFor(
			(frame) =>
				frame["type"] === "transcript_message" &&
				frame["sessionId"] === sessionId &&
				frame["role"] === "assistant",
			cursor,
		);
		evidence["whileRunning"] = {
			discard: await outcome(edit("SessionDiffDiscard", "a.txt", a?.after)),
			stage: await outcome(edit("SessionDiffStage", "a.txt", a?.after)),
		};
		expect(evidence["whileRunning"]).toEqual({
			discard: "SessionDiffEditError:busy",
			stage: "SessionDiffEditError:busy",
		});
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\nTWO\n");
		expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
		writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
		await running;

		// Two clients, each on its own connection, discard the file they both saw.
		const double = await Promise.all([
			outcome(edit("SessionDiffDiscard", "a.txt", a?.after)),
			outcome(edit("SessionDiffDiscard", "a.txt", a?.after)),
		]);
		evidence["doubleDiscard"] = [...double].sort();
		expect(evidence["doubleDiscard"]).toEqual([
			"SessionDiffEditError:stale",
			"ok",
		]);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\ntwo\n");

		// The first of b.txt's two hunks reaches the index; the second stays unstaged.
		const relisted = await list();
		evidence["afterDiscard"] = Object.keys(relisted.files);
		expect(evidence["afterDiscard"]).toEqual(["b.txt"]);
		const b = relisted.files["b.txt"];
		evidence["hunkStage"] = await outcome(
			edit("SessionDiffStage", "b.txt", b?.after, {
				revision: relisted.revision,
				before: b?.before ?? "",
				index: 0,
			}),
		);
		expect(evidence["hunkStage"]).toBe("ok");
		const staged = git(repo, "diff", "--cached", "-U0", "b.txt");
		const unstaged = git(repo, "diff", "-U0", "b.txt");
		evidence["staged"] = staged;
		evidence["unstaged"] = unstaged;
		expect(staged).toContain("+EDIT 1");
		expect(staged).not.toContain("EDIT 38");
		expect(unstaged).toContain("+EDIT 38");
		expect(unstaged).not.toContain("EDIT 1");
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe(`${lines(40, 1)}\n`);
	});
});
