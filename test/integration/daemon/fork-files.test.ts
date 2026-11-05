import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes (audit.md, lane 82tn.54). Through the built daemon, a fork with
// files: makes a worktree whose files are not the node's checkpoint (1), or
// cannot after a git gc in the source (2); writes or reads the source folder,
// dirty or not (3); lineage or folder other than ADR-0007 Fork in a new
// worktree (4); goes ahead from pruned history (5) or from a folder with no
// checkpoint, or leaves a worktree behind when it refuses (6); two at once
// share a worktree or one fails (7); a running source blocks it (8).
const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of GIT_KEYS) delete gitEnv[key];
const git = (
	directory: string,
	args: readonly string[],
	env: Record<string, string> = {},
) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: { ...gitEnv, ...env },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
/** The folder's paths and bytes, outside .git. */
const listing = (directory: string) =>
	readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter((path) => path !== ".git" && !path.startsWith(".git/"))
		.filter((path) => !lstatSync(join(directory, path)).isDirectory())
		.sort()
		.map((path) => `${path} ${readFileSync(join(directory, path), "base64")}`);
/** The checkout's whole tree, untracked files included, through a scratch index. */
const treeOf = (directory: string) => {
	const index = join(tmpdir(), `fork-files-${process.pid}-${Date.now()}`);
	try {
		git(directory, ["add", "-A"], { GIT_INDEX_FILE: index });
		return git(directory, ["write-tree"], { GIT_INDEX_FILE: index });
	} finally {
		rmSync(index, { force: true });
	}
};
/** The checkouts git lists for the repository, other than the repository's own. */
const worktrees = (repo: string) =>
	git(repo, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => path !== realpathSync(repo));

describe("Fork with files through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

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
			const name = `test-results/82tn-54-${String(evidence["name"])}.json`;
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				name,
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			evidence = {};
			vi.unstubAllEnvs();
		}
	});

	const start = async ({ repository = true } = {}) => {
		for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
		harness = ProcessHarness.create({
			claudeReplay: {
				turns: Array.from({ length: 8 }, () => "pong-thinking-text-turn"),
				delayMs: 0,
				holdBeforeResult: true,
			},
		});
		const fixture = harness;
		const repo = fixture.projectDir;
		const release = join(fixture.root, "claude-replay-release");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
		if (repository) {
			git(repo, ["init", "-q", "-b", "main"]);
			git(repo, ["add", "."]);
			git(repo, [
				"-c",
				"user.name=Fork files test",
				"-c",
				"user.email=fork-files@example.test",
				"commit",
				"-q",
				"-m",
				"Initial",
			]);
		}
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders: [repo],
		});
		const query = <Row>(statement: string, ...params: string[]) => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db.prepare(statement).all(...params) as Row[];
			} finally {
				db.close();
			}
		};
		const browser = await fixture.connect();
		const userMessage = async (sessionId: string, prompt: string) => {
			const message = (await browser.history(sessionId)).find(
				(candidate) =>
					candidate.role === "user" &&
					(candidate.text === prompt ||
						candidate.parts?.some((part) => part.text === prompt)),
			);
			if (!message) throw new Error(`No user message ${prompt}`);
			return message.id;
		};
		/** Opens a turn; the returned finish runs `edit` while its run is open, then waits for its capture. */
		const openTurn = async (sessionId: string, prompt: string) => {
			const cursor = browser.frames.length;
			const sending = browser.send(sessionId, prompt);
			void sending.catch(() => {});
			await browser.waitFor(
				(frame) =>
					frame["type"] === "transcript_message" &&
					frame["sessionId"] === sessionId &&
					frame["role"] === "assistant",
				cursor,
			);
			return async (edit: () => void) => {
				edit();
				writeFileSync(release, "release\n");
				await sending;
				rmSync(release, { force: true });
				const messageId = await userMessage(sessionId, prompt);
				// Listing a turn waits for its run's capture.
				await sendRpcRequest(socket, {
					_tag: "SessionDiffList",
					sessionId,
					scope: { kind: "turn", turnId: messageId },
				});
				return messageId;
			};
		};
		const turn = async (sessionId: string, prompt: string, edit: () => void) =>
			(await openTurn(sessionId, prompt))(edit);
		const fork = (sessionId: string, messageId: string) =>
			Effect.runPromise(
				browser.rpc.ForkSession({
					sessionId,
					originId: browser.originId,
					messageId,
					files: true,
				}),
			);
		const refusal = (sessionId: string, messageId: string) =>
			Effect.runPromise(
				Effect.flip(
					browser.rpc.ForkSession({
						sessionId,
						originId: browser.originId,
						messageId,
						files: true,
					}),
				),
			);
		/** The end tree of the session's `n`th captured run, from conduit's checkpoint refs. */
		const checkpointTree = (sessionId: string, n: number) => {
			const runId = query<{ runId: string }>(
				`SELECT json_extract(data, '$.runId') AS runId FROM events
				WHERE session_id = ? AND type = 'run.changes_captured' ORDER BY sequence`,
				sessionId,
			)[n]?.runId;
			const timeline = join(fixture.configDir, "folder-timeline");
			const store = readdirSync(timeline).find((name) => name.endsWith(".git"));
			if (!runId || !store) throw new Error("No checkpoint");
			const ref = git(join(timeline, store), [
				"for-each-ref",
				"--format=%(refname)",
				"refs/conduit/sessions/",
			])
				.split("\n")
				.find((name) => name.includes(`/checkpoints/${runId}/`));
			if (!ref) throw new Error(`No checkpoint ref for ${runId}`);
			return git(join(timeline, store), ["rev-parse", `${ref}^{tree}`]);
		};
		const lineage = (sessionId: string) =>
			query<{ forked_from: string | null; side_thread: number }>(
				"SELECT forked_from, side_thread FROM sessions WHERE id = ?",
				sessionId,
			)[0];
		return {
			fixture,
			repo,
			browser,
			query,
			turn,
			openTurn,
			fork,
			refusal,
			checkpointTree,
			lineage,
			socket,
		};
	};

	it("forks from a past turn into a new worktree whose tree is that turn's checkpoint, again after a git gc in the source, leaving the dirty source as it is", async () => {
		evidence["name"] = "fork-past-node-gc";
		const { repo, browser, query, turn, fork, checkpointTree, lineage } =
			await start();
		const session = await browser.createSession("Fork with files");
		const first = await turn(session, "first", () => {
			writeFileSync(join(repo, "first.txt"), "first\n");
			writeFileSync(join(repo, "tracked.txt"), "one\nTWO\nthree\n");
		});
		const afterFirst = listing(repo);
		await turn(session, "second", () => {
			writeFileSync(join(repo, "second.txt"), "second\n");
			rmSync(join(repo, "first.txt"));
		});
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");
		const source = {
			files: listing(repo),
			index: git(repo, ["ls-files", "-s"]),
			head: git(repo, ["rev-parse", "HEAD"]),
			branches: git(repo, ["branch", "--list", "main"]),
		};
		const snapshot = checkpointTree(session, 0);
		evidence["snapshot"] = snapshot;

		const forked = await fork(session, first);
		evidence["fork"] = forked;
		const [checkout] = worktrees(repo);
		if (!checkout) throw new Error("No worktree");
		evidence["tree"] = treeOf(checkout);
		expect(evidence["tree"]).toBe(snapshot);
		expect(listing(checkout)).toEqual(afterFirst);
		expect(lineage(forked.sessionId)).toEqual({
			forked_from: session,
			side_thread: 0,
		});
		expect(forked.forkedFrom).toBe(session);
		// The fork works in its new worktree, not the source's folder.
		evidence["workspace"] = JSON.parse(
			query<{ workspace: string }>(
				"SELECT workspace FROM sessions WHERE id = ?",
				forked.sessionId,
			)[0]?.workspace ?? "null",
		);
		expect(evidence["workspace"]).toEqual({
			cause: "launch",
			worktrees: { [repo]: checkout },
			origin: "conduit",
		});
		expect({
			files: listing(repo),
			index: git(repo, ["ls-files", "-s"]),
			head: git(repo, ["rev-parse", "HEAD"]),
			branches: git(repo, ["branch", "--list", "main"]),
		}).toEqual(source);

		git(repo, ["gc", "--prune=now", "--quiet"]);
		const again = await fork(session, first);
		evidence["afterGc"] = again;
		const second = worktrees(repo).find((path) => path !== checkout);
		if (!second) throw new Error("No second worktree");
		evidence["treeAfterGc"] = treeOf(second);
		expect(evidence["treeAfterGc"]).toBe(snapshot);
		expect(listing(second)).toEqual(afterFirst);
	});

	it("forks twice at once from a past turn while the source runs, each into its own matching worktree", async () => {
		evidence["name"] = "two-at-once-running";
		const { repo, browser, turn, openTurn, fork, checkpointTree } =
			await start();
		const session = await browser.createSession("Two at once");
		const first = await turn(session, "first", () =>
			writeFileSync(join(repo, "first.txt"), "first\n"),
		);
		const snapshot = checkpointTree(session, 0);
		const finish = await openTurn(session, "running");
		const forks = await Promise.all([
			fork(session, first),
			fork(session, first),
		]);
		evidence["forks"] = forks;
		await finish(() => writeFileSync(join(repo, "late.txt"), "late\n"));
		expect(new Set(forks.map(({ sessionId }) => sessionId)).size).toBe(2);
		const checkouts = worktrees(repo);
		evidence["trees"] = checkouts.map(treeOf);
		expect(evidence["trees"]).toEqual([snapshot, snapshot]);
	});

	it("refuses a fork with files from evicted history as pruned, making no worktree", async () => {
		evidence["name"] = "pruned";
		const { repo, browser, turn, refusal, query, socket } = await start();
		const session = await browser.createSession("Evicted");
		const first = await turn(session, "first", () =>
			writeFileSync(join(repo, "first.txt"), "first\n".repeat(4_000)),
		);
		await browser.setSettled(session, true);
		const budget = (budgetBytes: number) =>
			sendRpcRequest(socket, {
				_tag: "SetSnapshotBudgetSetting",
				budgetBytes,
				alertBytes: budgetBytes,
			});
		await budget(1);
		await budget(1024 * 1024 * 1024);
		expect(
			query(
				"SELECT 1 FROM events WHERE session_id = ? AND type = 'folder_timeline.evicted'",
				session,
			),
		).toHaveLength(1);
		const refused = await refusal(session, first);
		evidence["refused"] = refused;
		expect(refused).toMatchObject({ _tag: "FilesRefused", reason: "pruned" });
		expect(worktrees(repo)).toEqual([]);
	});

	it("refuses a fork with files from a folder that is not a repository, naming the folder", async () => {
		evidence["name"] = "not-a-repository";
		const { repo, browser, turn, refusal, fixture } = await start({
			repository: false,
		});
		const session = await browser.createSession("Plain folder");
		const first = await turn(session, "first", () =>
			writeFileSync(join(repo, "first.txt"), "first\n"),
		);
		const refused = await refusal(session, first);
		evidence["refused"] = refused;
		expect(refused).toMatchObject({
			_tag: "FilesRefused",
			reason: "not_available",
			directory: repo,
		});
		expect(existsSync(join(fixture.configDir, "worktrees"))).toBe(false);
	});
});
