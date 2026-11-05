import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes (audit.md, lane f02e9-13). No head move needs files today, so
// every move into pruned history goes ahead and only reports its files
// unavailable: a rewind chosen before an eviction makes the next send fail
// (1); a move to a point after post-eviction turns fails, or reads its files
// pruned (2, 7); a new send in a pruned session fails (3); a fork from a
// pruned point fails (4); undoing a rewind made before the eviction fails (5);
// a session evicted while its rewind controls are shown refuses the move (6,
// 8); a point before the eviction reads its files available (7).
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

describe("Head moves into pruned history through the built daemon", () => {
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
				"test-results/f02e9-13-head-moves.json",
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("lets conversation-only moves into pruned history go ahead and reports their files pruned", async () => {
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
		const events = (sessionId: string, ...types: string[]) =>
			query<{ type: string }>(
				`SELECT type FROM events WHERE session_id = ? AND type IN (${types.map(() => "?").join(", ")}) ORDER BY sequence`,
				sessionId,
				...types,
			).map(({ type }) => type);
		const setBudget = (budgetBytes: number) =>
			sendRpcRequest(socket, {
				_tag: "SetSnapshotBudgetSetting",
				budgetBytes,
				alertBytes: budgetBytes,
			});

		const browser = await fixture.connect();
		const rpc = browser.rpc;
		const run = <A, E>(effect: Effect.Effect<A, E>) =>
			Effect.runPromise(effect);
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
		const visible = async (sessionId: string) =>
			(await browser.history(sessionId)).map(({ id }) => id);
		const prompts = async (sessionId: string) =>
			(await browser.history(sessionId))
				.filter(({ role }) => role === "user")
				.map(
					({ text, parts }) => text || parts?.map((part) => part.text).join(""),
				);
		const files = async (sessionId: string, messageId: string) =>
			(await run(rpc.GetHeadMoveFiles({ sessionId, messageId }))).files;
		/** One turn that writes `name` while its run is open, so it captures changes. */
		const editingTurn = async (sessionId: string, name: string) => {
			evidence["step"] = `turn ${name}`;
			const cursor = browser.frames.length;
			const sending = browser.send(sessionId, name);
			void sending.catch(() => {});
			await browser.waitFor(
				(frame) =>
					frame["type"] === "transcript_message" &&
					frame["sessionId"] === sessionId &&
					frame["role"] === "assistant",
				cursor,
			);
			writeFileSync(join(repo, name), randomBytes(20_000).toString("base64"));
			writeFileSync(join(release), "release\n");
			await sending;
			rmSync(release, { force: true });
			const messageId = await userMessage(sessionId, name);
			// Listing a turn waits for its run's capture, so eviction sees it.
			await sendRpcRequest(socket, {
				_tag: "SessionDiffList",
				sessionId,
				scope: { kind: "turn", turnId: messageId },
			});
			return messageId;
		};

		// Two sessions with captured turns, each with a rewind chosen before the eviction.
		const sent = await browser.createSession("Rewind then send");
		const sentFirst = await editingTurn(sent, "sent-first.txt");
		const sentSecond = await editingTurn(sent, "sent-second.txt");
		const undone = await browser.createSession("Rewind then undo");
		const undoneFirst = await editingTurn(undone, "undone-first.txt");
		const undoneSecond = await editingTurn(undone, "undone-second.txt");
		expect(await files(sent, sentFirst)).toBe("available");

		await run(rpc.RewindSession({ sessionId: sent, messageId: sentSecond }));
		await run(
			rpc.RewindSession({ sessionId: undone, messageId: undoneSecond }),
		);
		const undoneBefore = await visible(undone);
		await browser.setSettled(sent, true);
		await browser.setSettled(undone, true);

		evidence["step"] = "evict";
		await setBudget(1);
		await setBudget(1024 * 1024 * 1024);
		const evicted = query<{ session_id: string }>(
			"SELECT session_id FROM events WHERE type = 'folder_timeline.evicted' ORDER BY sequence",
		).map(({ session_id }) => session_id);
		evidence["evicted"] = evicted;
		expect(evicted).toEqual(expect.arrayContaining([sent, undone]));

		// Points before the eviction read their files pruned.
		evidence["filesBeforeEviction"] = {
			sentFirst: await files(sent, sentFirst),
			sentSecond: await files(sent, sentSecond),
			undoneFirst: await files(undone, undoneFirst),
		};
		expect(evidence["filesBeforeEviction"]).toEqual({
			sentFirst: "pruned",
			sentSecond: "pruned",
			undoneFirst: "pruned",
		});

		// Undo of a rewind made before the eviction brings the messages back (5).
		await run(rpc.UndoRewind({ sessionId: undone }));
		expect((await visible(undone)).length).toBeGreaterThan(undoneBefore.length);
		expect(await visible(undone)).toContain(undoneSecond);

		// A rewind chosen into pruned history after the eviction goes ahead (6, 8).
		await run(rpc.RewindSession({ sessionId: undone, messageId: undoneFirst }));
		expect(await visible(undone)).not.toContain(undoneFirst);

		// A fork from a pruned point carries the conversation up to it (4).
		const fork = await run(
			rpc.ForkSession({
				sessionId: sent,
				originId: browser.originId,
				messageId: sentFirst,
			}),
		);
		evidence["fork"] = fork;
		expect(fork.forkedFrom).toBe(sent);
		evidence["forkPrompts"] = await prompts(fork.sessionId);
		expect(evidence["forkPrompts"]).toEqual(["sent-first.txt"]);

		// The send after an eviction that landed between choosing the rewind and
		// sending commits the rewind (1) and runs as a new turn (3).
		const after = await editingTurn(sent, "sent-after.txt");
		expect(events(sent, "session.rewind_committed")).toEqual([
			"session.rewind_committed",
		]);
		expect(await visible(sent)).not.toContain(sentSecond);
		expect(await visible(sent)).toEqual(
			expect.arrayContaining([sentFirst, after]),
		);

		// Points after post-eviction turns keep their files, and moves to them work (2, 7).
		const later = await editingTurn(sent, "sent-later.txt");
		evidence["filesAfterEviction"] = {
			after: await files(sent, after),
			later: await files(sent, later),
		};
		expect(evidence["filesAfterEviction"]).toEqual({
			after: "available",
			later: "available",
		});
		expect(await files(sent, sentFirst)).toBe("pruned");
		await run(rpc.RewindSession({ sessionId: sent, messageId: later }));
		expect(await visible(sent)).not.toContain(later);
		await run(rpc.UndoRewind({ sessionId: sent }));
		expect(await visible(sent)).toContain(later);
		// 82tn.51: rewinds and undos are recorded as head moves.
		evidence["headMoves"] = {
			sent: events(
				sent,
				"head.move_started",
				"head.moved",
				"session.rewind_committed",
			),
			undone: events(
				undone,
				"head.move_started",
				"head.moved",
				"session.rewind_committed",
			),
		};
		evidence["passed"] = true;
	});
});
