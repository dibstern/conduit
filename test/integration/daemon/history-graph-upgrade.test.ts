// The History Graph (82tn.50) over stores the build before it wrote
// (test/fixtures/history-graph-upgrade/generate.ts), opened by the current build through the
// process harness. How it could fail (lane 50 audit):
// 1. an old rewind's removed rows vanish from history instead of becoming an unavailable branch;
// 2. a Run with a steer becomes two nodes; 11. a rewind to that steer cuts inside the Run, or
//    drops the Run's inputs instead of restoring them as the draft;
// 3. a Run still running at the upgrade gets a node before it ends;
// 4. a subagent session joins its parent's graph, or a parent rewind edits it;
// 5. a fork's rows name nodes its graph lacks;
// 8. the paged history window shows rows off the head path after a head move;
// 9. a session's messages or parts read differently after the upgrade (Claude, OpenCode, Codex,
//    Cursor);
// 10. a committed rewind loses its rows instead of keeping them off the head path.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

type Row = Record<string, unknown>;
type Store = "claude" | "codex" | "cursor" | "opencode";

const fixture = (store: Store) =>
	fileURLToPath(
		new URL(
			`../../fixtures/history-graph-upgrade/${store}.db`,
			import.meta.url,
		),
	);

const open = <T>(path: string, read: (db: Database.Database) => T): T => {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		return read(db);
	} finally {
		db.close();
	}
};

/** Every session's messages and parts, column by column, in transcript order. */
const transcripts = (path: string) =>
	open(path, (db) =>
		Object.fromEntries(
			(
				db.prepare("SELECT id FROM sessions ORDER BY created_at, id").all() as {
					id: string;
				}[]
			).map(({ id }) => {
				const messages = (
					db
						.prepare(
							"SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal, created_at, id",
						)
						.all(id) as Row[]
				).map(({ history_node_id: _node, ...row }) => row);
				const parts = db
					.prepare(
						"SELECT p.* FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? ORDER BY m.ordinal, m.created_at, m.id, p.sort_order, p.id",
					)
					.all(id) as Row[];
				return [id, { messages, parts }];
			}),
		),
	);

/** A session's graph: its nodes, Head, the path from the Head to the root, and kept rows. */
const graph = (path: string, sessionId: string) =>
	open(path, (db) => {
		const nodes = db
			.prepare(
				"SELECT id, parent_id AS parentId, run_id AS runId, available FROM history_nodes WHERE session_id = ? ORDER BY created_at, id",
			)
			.all(sessionId) as {
			id: string;
			parentId: string | null;
			runId: string | null;
			available: number;
		}[];
		const head =
			(
				db
					.prepare("SELECT node_id FROM history_heads WHERE session_id = ?")
					.get(sessionId) as { node_id: string | null } | undefined
			)?.node_id ?? null;
		const byId = new Map(nodes.map((node) => [node.id, node]));
		const headPath: string[] = [];
		for (let at = head; at !== null; at = byId.get(at)?.parentId ?? null)
			headPath.unshift(at);
		const tagged = db
			.prepare(
				"SELECT id, role, history_node_id AS node FROM messages WHERE session_id = ? ORDER BY ordinal, created_at, id",
			)
			.all(sessionId) as { id: string; role: string; node: string | null }[];
		const offHead = db
			.prepare(
				"SELECT node_id AS node, source_table AS source, row_key AS id, row_json IS NOT NULL AS kept FROM history_off_head WHERE session_id = ? ORDER BY source_table, row_key",
			)
			.all(sessionId) as {
			node: string | null;
			source: string;
			id: string;
			kept: number;
		}[];
		return { nodes, head, headPath, tagged, offHead };
	});

const sessionByTitle = (path: string, title: string) =>
	open(
		path,
		(db) =>
			(
				db.prepare("SELECT id FROM sessions WHERE title = ?").get(title) as
					| { id: string }
					| undefined
			)?.id ?? "",
	);

/** Every message the history window serves, paging back from the newest. */
const historyWindow = async (browser: ProcessBrowser, sessionId: string) => {
	const ids: string[] = [];
	let before: string | undefined;
	for (;;) {
		const page = await Effect.runPromise(
			browser.rpc.LoadMoreHistory({
				sessionId,
				...(before ? { before } : {}),
			}),
		);
		ids.unshift(
			...page.messages.map(({ id }) => id).filter((id) => !ids.includes(id)),
		);
		const oldest = page.messages[0]?.id;
		if (!page.hasMore || oldest === undefined || oldest === before) return ids;
		before = oldest;
	}
};

describe("the History Graph over a store written before it", () => {
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
		} finally {
			evidence[`${task.name} outcome`] =
				task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-50-history-graph-upgrade.json",
				`${JSON.stringify(evidence, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	/** Copies the fixture store in and opens it with the current build: the migration runs. */
	const upgrade = async (store: Store) => {
		const fixtureHarness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			logLevel: "warn",
			serverLogFile: join("test-results", `82tn-50-${store}-daemon.log`),
		});
		harness = fixtureHarness;
		copyFileSync(fixture(store), fixtureHarness.daemonStorePath());
		writeFileSync(
			join(fixtureHarness.configDir, "daemon.json"),
			JSON.stringify({
				...defaultDaemonConfig(),
				autoSettleAfterDays: null,
				autoArchiveAfterDays: null,
			}),
		);
		await fixtureHarness.restart();
		const browser = await fixtureHarness.connect();
		return {
			fixture: fixtureHarness,
			browser,
			store: fixtureHarness.daemonStorePath(),
		};
	};

	/** The head path's rows equal the session's messages, and the window serves exactly them. */
	const headPathIsRead = async (
		browser: ProcessBrowser,
		store: string,
		sessionId: string,
	) => {
		const { headPath, tagged } = graph(store, sessionId);
		const onPath = tagged.filter(
			({ node }) => node !== null && headPath.includes(node),
		);
		expect(onPath).toEqual(tagged);
		expect(await historyWindow(browser, sessionId)).toEqual(
			tagged.map(({ id }) => id),
		);
		return tagged.map(({ id }) => id);
	};

	it.each([
		"claude",
		"codex",
		"cursor",
		"opencode",
	] as const)("%s: every session's head path reads exactly as its messages did before the upgrade (9)", async (name) => {
		const before = transcripts(fixture(name));
		const { browser, store } = await upgrade(name);
		const after = transcripts(store);
		const running = sessionByTitle(store, "Upgrade running");
		const proof: Record<string, unknown> = {};
		for (const [sessionId, transcript] of Object.entries(before)) {
			const { nodes, head, headPath } = graph(store, sessionId);
			proof[sessionId] = { nodes, head, headPath };
			// The restart ends the running Run as lost: that settles its open rows and adds its
			// error after them, so its old rows read first, in order.
			if (sessionId === running)
				expect(
					after[sessionId]?.messages
						.map(({ id }) => id)
						.slice(0, transcript.messages.length),
				).toEqual(transcript.messages.map(({ id }) => id));
			else expect(after[sessionId]).toEqual(transcript);
			await headPathIsRead(browser, store, sessionId);
		}
		evidence[`${name} upgrade`] = proof;
	});

	it("claude: an old rewind's rows are an unavailable branch; a running Run becomes one node at its end (1, 3)", async () => {
		const { browser, store } = await upgrade("claude");
		const rewound = sessionByTitle(store, "Upgrade rewound");
		const removed = open(
			store,
			(db) =>
				db
					.prepare(
						"SELECT message_id FROM message_tombstones WHERE session_id = ? ORDER BY message_id",
					)
					.all(rewound) as { message_id: string }[],
		).map(({ message_id }) => message_id);
		const old = graph(store, rewound);
		const unavailable = old.nodes.filter(({ available }) => available === 0);
		expect(unavailable).toHaveLength(1);
		const [branch] = unavailable;
		// The branch hangs off the kept first Run, beside the Run sent after the rewind.
		expect(branch?.parentId).toBe(old.headPath[0]);
		expect(old.headPath).toHaveLength(2);
		expect(old.offHead).toEqual(
			removed.map((id) => ({
				node: branch?.id,
				source: "messages",
				id,
				kept: 0,
			})),
		);

		const running = sessionByTitle(store, "Upgrade running");
		// test-waits-allow polling: the lost Run's end reaches only the store.
		await vi.waitFor(
			() =>
				expect(
					graph(store, running).tagged.map(({ node }) => node),
				).not.toContain(null),
			{ timeout: 20_000 },
		);
		const ran = graph(store, running);
		expect(ran.headPath).toHaveLength(2);
		expect(new Set(ran.tagged.slice(2).map(({ node }) => node)).size).toBe(1);
		await headPathIsRead(browser, store, running);
		evidence["claude old rewind"] = { old, removed, running: ran };
	});

	it("claude: after each head move the history window reads exactly the head path, and a commit keeps the rows off it (5, 8, 10)", async () => {
		const { browser, store } = await upgrade("claude");
		const sessionId = sessionByTitle(store, "Upgrade plain");
		const start = graph(store, sessionId);
		const [first, second] = start.headPath;
		const target = start.tagged.find(
			({ role, node }) => role === "user" && node === second,
		);
		if (!first || !second || !target) throw new Error("Missing fixture Runs");
		await browser.followSession(sessionId);

		await Effect.runPromise(
			browser.rpc.RewindSession({ sessionId, messageId: target.id }),
		);
		const rewound = graph(store, sessionId);
		expect(rewound.head).toBe(first);
		expect(await historyWindow(browser, sessionId)).toEqual(
			start.tagged.filter(({ node }) => node === first).map(({ id }) => id),
		);

		await Effect.runPromise(browser.rpc.UndoRewind({ sessionId }));
		expect(graph(store, sessionId).head).toBe(second);
		await headPathIsRead(browser, store, sessionId);

		await Effect.runPromise(
			browser.rpc.RewindSession({ sessionId, messageId: target.id }),
		);
		await browser.send(sessionId, "upgrade-plain-third");
		const committed = graph(store, sessionId);
		const third = committed.head;
		expect(committed.headPath).toEqual([first, third]);
		expect(committed.nodes.find(({ id }) => id === second)?.parentId).toBe(
			first,
		);
		const offHead = start.tagged.filter(({ node }) => node === second);
		expect(
			committed.offHead
				.filter(({ source }) => source === "messages")
				.map(({ id, node, kept }) => ({ id, node, kept })),
		).toEqual(
			offHead
				.map(({ id }) => ({ id, node: second, kept: 1 }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		);
		await headPathIsRead(browser, store, sessionId);
		// A window cursor on a row now off the head path is refused, not served.
		const stale = await Effect.runPromise(
			Effect.flip(
				browser.rpc.LoadMoreHistory({
					sessionId,
					before: offHead[0]?.id ?? "",
				}),
			),
		);
		expect(stale.message).toMatch(/cursor|not found/i);

		const fork = await Effect.runPromise(
			browser.rpc.ForkSession({ sessionId, originId: browser.originId }),
		);
		const forked = graph(store, fork.sessionId);
		expect(forked.headPath).toEqual([first, third]);
		await headPathIsRead(browser, store, fork.sessionId);
		evidence["claude head moves"] = { start, rewound, committed, forked };
	});

	it("codex: a Run with a steer is one node; a rewind to the steer lands on the Run's parent and restores both inputs as the draft (2, 11)", async () => {
		const { browser, store } = await upgrade("codex");
		const sessionId = sessionByTitle(store, "Upgrade steer");
		const before = graph(store, sessionId);
		expect(before.headPath).toHaveLength(1);
		expect(new Set(before.tagged.map(({ node }) => node))).toEqual(
			new Set(before.headPath),
		);
		const steer = before.tagged.at(-1);
		if (!steer || steer.role !== "user") throw new Error("Missing the steer");
		await browser.followSession(sessionId);
		await Effect.runPromise(
			browser.rpc.RewindSession({ sessionId, messageId: steer.id }),
		);
		const after = graph(store, sessionId);
		expect(after.head).toBeNull();
		expect(await historyWindow(browser, sessionId)).toEqual([]);
		const draft = open(
			store,
			(db) =>
				(
					db
						.prepare(
							"SELECT text FROM input_drafts WHERE draft_key = ? AND kind = 'session'",
						)
						.get(sessionId) as { text: string } | undefined
				)?.text,
		);
		expect(draft).toBe("Say hello\n\nUse the steered instruction");
		evidence["codex steer"] = { before, after, draft };
	});

	it("cursor: a subagent session keeps its own graph, and a parent rewind leaves it as it was (4)", async () => {
		const { browser, store } = await upgrade("cursor");
		const parent = sessionByTitle(store, "Upgrade subagent");
		const child = open(
			store,
			(db) =>
				(
					db
						.prepare("SELECT id FROM sessions WHERE parent_id = ?")
						.get(parent) as { id: string }
				).id,
		);
		const childBefore = graph(store, child);
		const parentBefore = graph(store, parent);
		expect(childBefore.headPath).toHaveLength(1);
		expect(childBefore.tagged.every(({ node }) => node !== null)).toBe(true);
		const first = parentBefore.tagged[0];
		if (!first) throw new Error("Missing the parent's prompt");
		await browser.followSession(parent);
		await Effect.runPromise(
			browser.rpc.RewindSession({ sessionId: parent, messageId: first.id }),
		);
		expect(graph(store, parent).head).toBeNull();
		expect(graph(store, child)).toEqual(childBefore);
		await headPathIsRead(browser, store, child);
		evidence["cursor subagent"] = { parentBefore, childBefore };
	});
});
