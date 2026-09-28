// ─── Session unread: upgrading a database from main's read state ─────────────
// Main kept read state as timestamps (read_at, marked_unread_at); this branch
// keeps turn-end positions (seen_version against last_turn_end_version). Each
// case builds a session, rewrites the stopped relay's event store into main's
// shape with the given read state, and restarts: the dot must be what main
// showed. Spec: conduit-test-hk9m.7.

import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

type MainReadState = "read" | "unread" | "marked unread";

// Main's shape: no turn-end columns or their migration, read_at and
// marked_unread_at present. Every other session is read, as main's sidebar
// showed it; the target gets `state`.
function rewindToMain(dbPath: string, sessionId: string, state: MainReadState) {
	const db = new DatabaseSync(dbPath);
	try {
		const columns = new Set(
			db
				.prepare("PRAGMA table_xinfo(sessions)")
				.all()
				.map((column) => String(column["name"])),
		);
		for (const column of ["unread", "seen_version", "last_turn_end_version"])
			if (columns.has(column))
				db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
		for (const column of ["read_at", "marked_unread_at"])
			if (!columns.has(column))
				db.exec(`ALTER TABLE sessions ADD COLUMN ${column} INTEGER`);
		// Main's ledger ends before session_attention, so every later
		// migration is unrecorded too.
		db.exec(
			"DELETE FROM effect_sql_migrations WHERE migration_id >= (SELECT migration_id FROM effect_sql_migrations WHERE name = 'session_attention')",
		);
		db.exec(
			"UPDATE sessions SET read_at = COALESCE(last_message_at, created_at), marked_unread_at = NULL",
		);
		const target = {
			read: "UPDATE sessions SET read_at = last_message_at WHERE id = ?",
			unread: "UPDATE sessions SET read_at = last_message_at - 1 WHERE id = ?",
			"marked unread":
				"UPDATE sessions SET read_at = NULL, marked_unread_at = 1 WHERE id = ?",
		}[state];
		db.prepare(target).run(sessionId);
	} finally {
		db.close();
	}
}

const turnEndCount = (harness: ReplayHarness, sessionId: string) => {
	if (!harness.eventsDbPath) throw new Error("harness has no event store");
	const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
	try {
		const row = db
			.prepare(
				"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.error')",
			)
			.get(sessionId);
		return Number(row?.["n"]);
	} finally {
		db.close();
	}
};

async function upgrade(
	page: Page,
	harness: ReplayHarness,
	sessionId: string,
	state: MainReadState,
) {
	await harness.restart(() => {
		if (!harness.eventsDbPath) throw new Error("harness has no event store");
		rewindToMain(harness.eventsDbPath, sessionId, state);
	});
	await expect(page.locator("#connect-overlay")).toBeHidden({
		timeout: 30_000,
	});
}

const cases: {
	state: MainReadState;
	turnEnded: boolean;
	dot: boolean;
}[] = [
	{ state: "read", turnEnded: true, dot: false },
	{ state: "unread", turnEnded: true, dot: true },
	{ state: "marked unread", turnEnded: true, dot: true },
	{ state: "marked unread", turnEnded: false, dot: true },
];

for (const { state, turnEnded, dot } of cases)
	test(`${state} on main ${turnEnded ? "after a turn end" : "with no turn end"} ${dot ? "keeps its dot" : "stays without a dot"}`, async ({
		page,
		relayUrl,
		harness,
	}) => {
		await gotoRelay(page, new URL("/", relayUrl).toString());
		const sessionId = await page
			.locator("#session-list .session-item")
			.first()
			.getAttribute("data-session-id");
		if (!sessionId) throw new Error("the recorded session has no row id");
		const row = page.locator(
			`#session-list .session-item[data-session-id="${sessionId}"]`,
		);
		if (turnEnded) {
			harness.mock.triggerPromptSse(sessionId);
			await expect
				.poll(() => turnEndCount(harness, sessionId), { timeout: 20_000 })
				.toBe(1);
		} else expect(turnEndCount(harness, sessionId)).toBe(0);

		await upgrade(page, harness, sessionId, state);
		await gotoRelay(page, new URL("/", relayUrl).toString());
		await expect(row).toBeVisible();
		await expect(row.getByTestId("session-unread-dot")).toHaveCount(
			dot ? 1 : 0,
		);
		if (!dot) return;
		await row.click();
		await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);
	});
