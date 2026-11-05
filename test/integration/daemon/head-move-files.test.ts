import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MoveIntent } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes (audit.md, lane 82tn.53). Through the built daemon, a head move
// with files: restores some paths but not others, or not byte for byte (1);
// undo leaves the folder other than the move found it (2); goes ahead over a
// session that ran in the folder after the target (3) or has a run open there
// (4), or names the wrong session; refusing it also refuses the
// conversation-only move (5); a daemon killed mid-apply leaves the folder half
// restored, or the move journalled without its files (6). Lane 53b: an edit
// between preview and commit is overwritten unseen (7); undo goes ahead over a
// session that ran in the folder since the move (8); a session in another
// folder blocks the move (9); two devices confirming one move apply it twice or
// refuse one (10); a daemon killed after the move is journalled loses its files
// or its undo (11); an eviction between preview and commit restores from
// pruned history, or sends the resend anyway (12).
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
/** The folder's paths and bytes, outside .git. */
const listing = (directory: string) =>
	readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter((path) => path !== ".git" && !path.startsWith(".git/"))
		.filter((path) => !lstatSync(join(directory, path)).isDirectory())
		.sort()
		.map((path) => `${path} ${readFileSync(join(directory, path), "base64")}`);

describe("Head moves with files through the built daemon", () => {
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
			const name = `test-results/82tn-53-${String(evidence["name"])}.json`;
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

	const start = async (
		serviceEnvironment: {
			CONDUIT_TEST_RESTORE_PAUSE_AT?: string;
			CONDUIT_TEST_HEAD_MOVE_DELAY_MS?: string;
		} = {},
	) => {
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
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
		git(repo, "add", ".");
		git(
			repo,
			"-c",
			"user.name=Head move test",
			"-c",
			"user.email=head-move@example.test",
			"commit",
			"-q",
			"-m",
			"Initial",
		);
		await fixture.restart({ serviceEnvironment });
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
		/** Opens a turn and runs `edit` while its run is open; `finish` ends it and waits for its capture. */
		const openTurn = async (sessionId: string, prompt: string) => {
			evidence["step"] = `turn ${prompt}`;
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
		const preview = (sessionId: string, intent: MoveIntent) =>
			Effect.runPromise(browser.rpc.PreviewHeadMove({ sessionId, intent }));
		const move = async (sessionId: string, intent: MoveIntent) => {
			const { moveId } = await preview(sessionId, intent);
			return Effect.runPromise(
				browser.rpc.CommitHeadMove({ sessionId, intent, moveId }),
			);
		};
		const refusal = (sessionId: string, intent: MoveIntent) =>
			Effect.runPromise(
				Effect.flip(browser.rpc.PreviewHeadMove({ sessionId, intent })),
			);
		const visible = async (sessionId: string) =>
			(await browser.history(sessionId)).map(({ id }) => id);
		/** The session's journalled moves, oldest first. */
		const moves = (sessionId: string) =>
			query<{ type: string }>(
				`SELECT type FROM events WHERE session_id = ?
				AND type IN ('head.move_started', 'head.moved') ORDER BY sequence`,
				sessionId,
			).map(({ type }) => type);
		const setBudget = (budgetBytes: number) =>
			sendRpcRequest(socket, {
				_tag: "SetSnapshotBudgetSetting",
				budgetBytes,
				alertBytes: budgetBytes,
			});
		return {
			fixture,
			moves,
			setBudget,
			repo,
			browser,
			query,
			turn,
			openTurn,
			preview,
			move,
			refusal,
			visible,
		};
	};

	it("restores the folder byte for byte to before a turn, and undo puts it back as the move found it", async () => {
		evidence["name"] = "one-session";
		const { repo, browser, query, turn, preview, move, visible } =
			await start();
		const session = await browser.createSession("Rewind with files");
		await turn(session, "first", () => {
			writeFileSync(join(repo, "first.txt"), "first\n");
			writeFileSync(join(repo, "tracked.txt"), "one\nTWO\nthree\n");
		});
		const beforeSecond = listing(repo);
		const second = await turn(session, "second", () => {
			writeFileSync(join(repo, "second.txt"), Buffer.from([0, 255, 10, 13]));
			writeFileSync(join(repo, "tracked.txt"), "changed again\n");
			rmSync(join(repo, "first.txt"));
			mkdirSync(join(repo, "deep", "er"), { recursive: true });
			writeFileSync(join(repo, "deep", "er", "n.txt"), "n\n");
		});
		const afterSecond = listing(repo);
		const index = git(repo, "ls-files", "-s");
		const head = git(repo, "rev-parse", "HEAD");

		const intent = {
			_tag: "rewind",
			messageId: second,
			withFiles: true,
		} as const;
		const plan = await preview(session, intent);
		evidence["plan"] = plan.restore;
		expect(plan.restore?.folders).toHaveLength(1);
		expect(
			[...(plan.restore?.folders[0]?.changes ?? [])].sort((a, b) =>
				a.path < b.path ? -1 : 1,
			),
		).toEqual([
			{ path: "deep/er/n.txt", change: "deleted" },
			{ path: "first.txt", change: "added" },
			{ path: "second.txt", change: "deleted" },
			{ path: "tracked.txt", change: "modified" },
		]);
		const { moveId } = await move(session, intent);
		evidence["restored"] = listing(repo);
		expect(listing(repo)).toEqual(beforeSecond);
		expect(await visible(session)).not.toContain(second);

		await move(session, { _tag: "undo", moveId, withFiles: true });
		evidence["undone"] = listing(repo);
		expect(listing(repo)).toEqual(afterSecond);
		expect(await visible(session)).toContain(second);
		// The user's index and HEAD are never written.
		expect(git(repo, "ls-files", "-s")).toBe(index);
		expect(git(repo, "rev-parse", "HEAD")).toBe(head);
		evidence["journal"] = query<{ files: string | null }>(
			`SELECT json_extract(data, '$.files') AS files FROM events
			WHERE session_id = ? AND type = 'head.move_started' ORDER BY sequence`,
			session,
		).map(({ files }) => files?.replaceAll(repo, "<repo>"));
		expect(evidence["journal"]).toEqual(['["<repo>"]', '["<repo>"]']);
	});

	it("refuses a rewind with files naming the other session in the folder, open or done, and the conversation-only rewind still goes", async () => {
		evidence["name"] = "two-sessions";
		const { repo, browser, query, turn, openTurn, refusal, move, visible } =
			await start();
		const mine = await browser.createSession("Mine");
		const theirs = await browser.createSession("Theirs");
		const first = await turn(mine, "mine first", () =>
			writeFileSync(join(repo, "mine.txt"), "mine\n"),
		);
		const title = (sessionId: string) =>
			query<{ title: string }>(
				"SELECT title FROM sessions WHERE id = ?",
				sessionId,
			)[0]?.title;
		const intent = {
			_tag: "rewind",
			messageId: first,
			withFiles: true,
		} as const;

		const finish = await openTurn(theirs, "theirs");
		const running = await refusal(mine, intent);
		evidence["running"] = running;
		expect(running).toMatchObject({
			_tag: "FilesRefused",
			reason: "other_session",
			directory: repo,
			other: { sessionId: theirs, title: title(theirs), running: true },
		});
		await finish(() => writeFileSync(join(repo, "theirs.txt"), "theirs\n"));

		const ran = await refusal(mine, intent);
		evidence["ran"] = ran;
		expect(ran).toMatchObject({
			_tag: "FilesRefused",
			reason: "other_session",
			other: { sessionId: theirs, title: title(theirs), running: false },
		});
		const before = listing(repo);
		await move(mine, { _tag: "rewind", messageId: first });
		expect(await visible(mine)).not.toContain(first);
		expect(listing(repo)).toEqual(before);
	});

	it("rolls a restore the daemon died in back at startup, journalling nothing", async () => {
		evidence["name"] = "crash";
		const { fixture, repo, browser, query, turn, preview } = await start({
			CONDUIT_TEST_RESTORE_PAUSE_AT: "deleted",
		});
		const session = await browser.createSession("Crash mid-apply");
		const second = await turn(session, "second", () =>
			writeFileSync(join(repo, "second.txt"), "second\n"),
		);
		const ended = listing(repo);
		const intent = {
			_tag: "rewind",
			messageId: second,
			withFiles: true,
		} as const;
		const { moveId } = await preview(session, intent);
		// The apply pauses once its deletes are done: the planned file going is the signal.
		const deleted = new Promise<void>((resolve) => {
			const watcher = watch(repo, () => {
				if (existsSync(join(repo, "second.txt"))) return;
				watcher.close();
				resolve();
			});
		});
		void Effect.runPromise(
			browser.rpc.CommitHeadMove({ sessionId: session, intent, moveId }),
		).catch(() => {});
		await deleted;
		evidence["midApply"] = listing(repo);
		await fixture.kill();
		await fixture.restart();
		evidence["recovered"] = listing(repo);
		expect(listing(repo)).toEqual(ended);
		expect(
			query(
				"SELECT 1 FROM events WHERE session_id = ? AND type = 'head.move_started'",
				session,
			),
		).toEqual([]);
	});

	it("reads a commit stale when a planned file was edited after the preview, and writes nothing", async () => {
		evidence["name"] = "stale";
		const { repo, browser, turn, preview, moves } = await start();
		const session = await browser.createSession("Stale plan");
		const second = await turn(session, "second", () =>
			writeFileSync(join(repo, "tracked.txt"), "changed\n"),
		);
		const intent = {
			_tag: "rewind",
			messageId: second,
			withFiles: true,
		} as const;
		const { moveId } = await preview(session, intent);
		writeFileSync(join(repo, "tracked.txt"), "edited by hand\n");
		const edited = listing(repo);
		const stale = await Effect.runPromise(
			Effect.flip(
				browser.rpc.CommitHeadMove({ sessionId: session, intent, moveId }),
			),
		);
		evidence["stale"] = stale;
		expect(stale).toMatchObject({
			_tag: "SessionBusy",
			reason: "head_move_stale",
		});
		expect(listing(repo)).toEqual(edited);
		expect(moves(session)).toEqual([]);
	});

	it("refuses an undo with files naming a session that ran in the folder since the move, and the conversation-only undo still goes", async () => {
		evidence["name"] = "undo-refused";
		const { repo, browser, query, turn, move, refusal, visible } =
			await start();
		const mine = await browser.createSession("Mine");
		const second = await turn(mine, "mine second", () =>
			writeFileSync(join(repo, "mine.txt"), "mine\n"),
		);
		const { moveId } = await move(mine, {
			_tag: "rewind",
			messageId: second,
			withFiles: true,
		});
		const theirs = await browser.createSession("Theirs");
		await turn(theirs, "theirs", () =>
			writeFileSync(join(repo, "theirs.txt"), "theirs\n"),
		);
		const intent = { _tag: "undo", moveId, withFiles: true } as const;
		const refused = await refusal(mine, intent);
		evidence["refused"] = refused;
		expect(refused).toMatchObject({
			_tag: "FilesRefused",
			reason: "other_session",
			directory: repo,
			other: {
				sessionId: theirs,
				title: query<{ title: string }>(
					"SELECT title FROM sessions WHERE id = ?",
					theirs,
				)[0]?.title,
				running: false,
			},
		});
		const before = listing(repo);
		await move(mine, { _tag: "undo", moveId });
		expect(await visible(mine)).toContain(second);
		expect(listing(repo)).toEqual(before);
	});

	it("lets a session in another folder run, open or done, without refusing the move", async () => {
		evidence["name"] = "other-folder";
		const { fixture, repo, browser, query, turn, openTurn, preview, move } =
			await start();
		const elsewhere = join(fixture.root, "elsewhere");
		git(repo, "worktree", "add", "-q", "-b", "elsewhere", elsewhere);
		const mine = await browser.createSession("Mine");
		const before = listing(repo);
		const second = await turn(mine, "mine second", () =>
			writeFileSync(join(repo, "mine.txt"), "mine\n"),
		);
		const theirs = await browser.createSession("Theirs", undefined, "claude", {
			worktreePath: elsewhere,
		});
		const intent = {
			_tag: "rewind",
			messageId: second,
			withFiles: true,
		} as const;
		const finish = await openTurn(theirs, "theirs");
		evidence["whileOpen"] = await preview(mine, intent);
		await finish(() =>
			writeFileSync(join(elsewhere, "theirs.txt"), "theirs\n"),
		);
		// Their run captured its own folder, so the exemption is the folder's, not an empty capture.
		evidence["theirFolders"] = query<{ directory: string }>(
			`SELECT json_extract(f.value, '$.directory') AS directory FROM events e, json_each(e.data, '$.folders') f
			WHERE e.session_id = ? AND e.type = 'run.changes_captured'`,
			theirs,
		).map(({ directory }) => directory);
		expect(evidence["theirFolders"]).toContain(elsewhere);
		await move(mine, intent);
		expect(listing(repo)).toEqual(before);
		expect(readFileSync(join(elsewhere, "theirs.txt"), "utf8")).toBe(
			"theirs\n",
		);
	});

	it("applies one move once when two devices confirm it at the same time", async () => {
		evidence["name"] = "two-devices";
		const { fixture, repo, browser, turn, preview, moves } = await start();
		const session = await browser.createSession("Two devices");
		const before = listing(repo);
		const second = await turn(session, "second", () =>
			writeFileSync(join(repo, "second.txt"), "second\n"),
		);
		const intent = {
			_tag: "rewind",
			messageId: second,
			withFiles: true,
		} as const;
		const { moveId } = await preview(session, intent);
		const other = await fixture.connect();
		const receipts = await Promise.all(
			[browser, other].map((device) =>
				Effect.runPromise(
					device.rpc.CommitHeadMove({ sessionId: session, intent, moveId }),
				),
			),
		);
		evidence["receipts"] = receipts;
		expect(receipts).toEqual([{ moveId }, { moveId }]);
		expect(listing(repo)).toEqual(before);
		expect(moves(session)).toEqual(["head.move_started", "head.moved"]);
	});

	it("lands a move with files the daemon died in after journalling it, and its undo still puts the files back", async () => {
		evidence["name"] = "roll-forward";
		const { fixture, repo, browser, turn, preview, moves } = await start({
			CONDUIT_TEST_HEAD_MOVE_DELAY_MS: "60000",
		});
		const session = await browser.createSession("Crash after journal");
		const before = listing(repo);
		const second = await turn(session, "second", () =>
			writeFileSync(join(repo, "second.txt"), "second\n"),
		);
		const ended = listing(repo);
		const intent = {
			_tag: "rewind",
			messageId: second,
			withFiles: true,
		} as const;
		const { moveId } = await preview(session, intent);
		void Effect.runPromise(
			browser.rpc.CommitHeadMove({ sessionId: session, intent, moveId }),
		).catch(() => {});
		// test-waits-allow polling: the move's start is a store event, not a frame this test follows.
		await vi.waitFor(() =>
			expect(moves(session)).toEqual(["head.move_started"]),
		);
		evidence["journalled"] = listing(repo);
		await fixture.kill();
		await fixture.restart();
		// test-waits-allow polling: startup lands the move in the background.
		await vi.waitFor(() =>
			expect(moves(session)).toEqual(["head.move_started", "head.moved"]),
		);
		evidence["landed"] = listing(repo);
		expect(listing(repo)).toEqual(before);
		const reader = await fixture.connect();
		expect((await reader.history(session)).map(({ id }) => id)).not.toContain(
			second,
		);
		const undo = { _tag: "undo", moveId, withFiles: true } as const;
		const plan = await Effect.runPromise(
			reader.rpc.PreviewHeadMove({ sessionId: session, intent: undo }),
		);
		await Effect.runPromise(
			reader.rpc.CommitHeadMove({
				sessionId: session,
				intent: undo,
				moveId: plan.moveId,
			}),
		);
		expect(listing(repo)).toEqual(ended);
	});

	it("refuses a resend with files as pruned when an eviction lands between preview and commit, writing and sending nothing", async () => {
		evidence["name"] = "evicted-between";
		const { repo, browser, query, turn, preview, moves, setBudget, visible } =
			await start();
		const session = await browser.createSession("Evicted between");
		await turn(session, "first", () =>
			writeFileSync(join(repo, "first.txt"), "first\n".repeat(4_000)),
		);
		const second = await turn(session, "second", () =>
			writeFileSync(join(repo, "second.txt"), "second\n".repeat(4_000)),
		);
		const intent = {
			_tag: "rewind",
			messageId: second,
			resend: "again",
			withFiles: true,
		} as const;
		const { moveId, files } = await preview(session, intent);
		expect(files).toBe("available");
		const shown = await visible(session);
		const ended = listing(repo);
		await browser.setSettled(session, true);
		await setBudget(1);
		await setBudget(1024 * 1024 * 1024);
		expect(
			query(
				"SELECT 1 FROM events WHERE session_id = ? AND type = 'folder_timeline.evicted'",
				session,
			),
		).toHaveLength(1);
		const refused = await Effect.runPromise(
			Effect.flip(
				browser.rpc.CommitHeadMove({ sessionId: session, intent, moveId }),
			),
		);
		evidence["refused"] = refused;
		expect(refused).toMatchObject({ _tag: "FilesRefused", reason: "pruned" });
		expect(listing(repo)).toEqual(ended);
		expect(moves(session)).toEqual([]);
		expect(await visible(session)).toEqual(shown);
	});
});
