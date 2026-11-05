import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDiffListing } from "../../../src/lib/contracts/session-diff.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure modes (lane-51/audit.md 32-35). Each turn names its user message and its latest
// assistant message; a move that takes them off the head path clears those links. Rows that
// come back by an undo (32) or a branch switch (33) must name them again, or the readers that
// join through them (surfacing feedback, recap, the session picker, the failure lookup) read
// nothing for the returned turn. A store from before the change keeps no links for rows already
// off the path; they come back unlinked, as before, and nothing fails (35). Another move cannot
// land between keeping and setting the links (34): both happen in one landing.
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

describe("Head moves keep each returned turn linked to its messages", () => {
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
				"test-results/82tn-51-turn-links.json",
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("links a turn to its messages again when an undo or a branch switch brings it back", async () => {
		for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
		harness = ProcessHarness.create({
			claudeReplay: {
				turns: Array.from({ length: 6 }, () => "pong-thinking-text-turn"),
				delayMs: 0,
				holdBeforeResult: true,
			},
		});
		const fixture = harness;
		const repo = fixture.projectDir;
		const release = join(fixture.root, "claude-replay-release");
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "tracked.txt"), "one\n");
		git(repo, "add", ".");
		git(
			repo,
			"-c",
			"user.name=Turn links test",
			"-c",
			"user.email=turn-links@example.test",
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
		/** Every turn of the session with the messages it names. */
		const links = (sessionId: string) =>
			query<{ turn: string; user: string | null; assistant: string | null }>(
				"SELECT id AS turn, user_message_id AS user, assistant_message_id AS assistant FROM turns WHERE session_id = ? ORDER BY requested_at, id",
				sessionId,
			);
		const linksOf = (sessionId: string, turn: string) =>
			links(sessionId).find((row) => row.turn === turn);

		let browser: ProcessBrowser = await fixture.connect();
		const run = <A, E>(effect: Effect.Effect<A, E>) =>
			Effect.runPromise(effect);
		const visible = async (sessionId: string) =>
			(await browser.history(sessionId)).map(({ id }) => id);
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
			writeFileSync(join(repo, name), `${name}\n`);
			writeFileSync(release, "release\n");
			await sending;
			rmSync(release, { force: true });
			return userMessage(sessionId, name);
		};
		const turnFiles = async (sessionId: string, turnId: string) =>
			(
				(await sendRpcRequest(socket, {
					_tag: "SessionDiffList",
					sessionId,
					scope: { kind: "turn", turnId },
				})) as SessionDiffListing
			).folders.flatMap((folder) =>
				"files" in folder ? folder.files.map(({ path }) => path) : [],
			);
		const switchTo = async (sessionId: string, nodeId: string) => {
			const intent = { _tag: "switch" as const, nodeId };
			const { moveId } = await run(
				browser.rpc.PreviewHeadMove({ sessionId, intent }),
			);
			await run(browser.rpc.CommitHeadMove({ sessionId, intent, moveId }));
		};
		/** Restarts the daemon, editing its store while it is down. */
		const whileDown = async (edit: (db: Database.Database) => void) => {
			await fixture.terminate();
			const db = new Database(fixture.daemonStorePath());
			try {
				edit(db);
			} finally {
				db.close();
			}
			await fixture.restart();
			browser = await fixture.connect();
		};

		const sessionId = await browser.createSession("Turn links");
		const first = await editingTurn(sessionId, "links-first.txt");
		const second = await editingTurn(sessionId, "links-second.txt");
		const before = links(sessionId);
		evidence["before"] = before;
		expect(linksOf(sessionId, second)).toEqual({
			turn: second,
			user: second,
			assistant: expect.any(String),
		});

		// 32: rewind then undo.
		evidence["step"] = "rewind then undo";
		await run(browser.rpc.RewindSession({ sessionId, messageId: second }));
		expect(linksOf(sessionId, second)).toMatchObject({
			user: null,
			assistant: null,
		});
		await run(browser.rpc.UndoRewind({ sessionId }));
		expect(await visible(sessionId)).toContain(second);
		evidence["afterUndo"] = links(sessionId);
		expect(evidence["afterUndo"]).toEqual(before);
		expect(await turnFiles(sessionId, second)).toContain("links-second.txt");

		// 33: a branch switch that brings the rows back.
		evidence["step"] = "switch back";
		await run(browser.rpc.RewindSession({ sessionId, messageId: second }));
		const other = await editingTurn(sessionId, "links-other.txt");
		const [fork] = (await run(browser.rpc.GetHeadBranches({ sessionId })))
			.forks;
		const tip = fork?.branches[0]?.tip;
		if (!tip) throw new Error("No branch to switch back to");
		await switchTo(sessionId, tip);
		expect(await visible(sessionId)).toContain(second);
		expect(await visible(sessionId)).not.toContain(other);
		evidence["afterSwitch"] = links(sessionId);
		expect(evidence["afterSwitch"]).toEqual([
			...before,
			{ turn: other, user: null, assistant: null },
		]);
		expect(await turnFiles(sessionId, second)).toContain("links-second.txt");

		// The surfacing feedback list reads the request a returned reply answered.
		evidence["step"] = "surfacing feedback";
		const [part] = query<{ id: string; message: string }>(
			"SELECT p.id, m.id AS message FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? AND m.turn_id = ? AND m.role = 'assistant' AND p.type = 'text' ORDER BY m.ordinal, p.sort_order LIMIT 1",
			sessionId,
			second,
		);
		if (!part) throw new Error("No reply text in the returned turn");
		await whileDown((db) => {
			db.prepare(
				"INSERT INTO surfacing_marks (part_id, session_id, message_id, level, direction, created_at) VALUES (?, ?, ?, 'balanced', 'raise', 1)",
			).run(part.id, sessionId, part.message);
		});
		const feedback = await sendRpcRequest(socket, {
			_tag: "GetSurfacingFeedback",
		});
		evidence["feedback"] = feedback;
		expect(feedback).toContainEqual(
			expect.objectContaining({
				partId: part.id,
				requestExcerpt: "links-second.txt",
			}),
		);

		// 35: a store from before the change kept no links for rows already off the path.
		evidence["step"] = "old store";
		await run(browser.rpc.RewindSession({ sessionId, messageId: second }));
		await whileDown((db) => {
			db.prepare(
				"DELETE FROM history_off_head WHERE session_id = ? AND source_table NOT IN ('messages', 'message_parts')",
			).run(sessionId);
		});
		await run(browser.rpc.UndoRewind({ sessionId }));
		expect(await visible(sessionId)).toContain(second);
		evidence["oldStore"] = links(sessionId);
		expect(evidence["oldStore"]).toEqual([
			...before.filter(({ turn }) => turn !== second),
			{ turn: second, user: null, assistant: null },
			{ turn: other, user: null, assistant: null },
		]);
		expect(linksOf(sessionId, first)).toEqual(
			before.find(({ turn }) => turn === first),
		);
		evidence["passed"] = true;
	});
});
