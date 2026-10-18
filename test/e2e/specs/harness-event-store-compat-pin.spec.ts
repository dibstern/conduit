// Behaviour pin (conduit-test-16c8.3): an event store written by an earlier
// build opens and renders identically. The checked-in fixture comes from
// test/fixtures/event-store-compat/generate.ts, which documents how to
// regenerate it; doing so changes RENDERED_HISTORY_HASH and FIXTURE_ROWS.
//
// Failure modes and the assertion that catches each:
// - The fixture changed or was regenerated without updating this spec:
//   the fixture row counts equal FIXTURE_ROWS.
// - Startup rejects or recreates the store (a migration fails or drops the
//   file): the daemon start throws, or the history tables lose their rows.
// - A migration or projector rewrites history on open (lost, duplicated or
//   reordered messages and parts): the history tables must keep their fixture
//   counts after opening, and the rendered history hash changes.
// - A session no longer opens from its link, or renders differently (missing
//   tool parts, user or assistant text): each session's last reply and tool
//   steps must render, and the normalized rendered text must hash to
//   RENDERED_HISTORY_HASH. The artifact keeps each session's text to diff.
// - The opened store cannot take writes, or a new turn does not render:
//   the reply to the new prompt must render, and messages and turns must grow
//   by exactly one turn while sessions stay unchanged.
//
//   CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//     --config test/e2e/playwright-harness.config.ts --project=desktop \
//     --workers=1 harness-event-store-compat-pin

import { createHash } from "node:crypto";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Browser } from "@playwright/test";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	storeTableCounts,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const artifact = "test-results/16c8-3-event-store-compat.json";
const fixture = fileURLToPath(
	new URL("../../fixtures/event-store-compat/events.db", import.meta.url),
);
/** Each fixture session, oldest first, with what ends its history. */
const SESSIONS = [
	{
		title: "Imported history",
		lastReply: "done(compat-imported-history)",
		tools: 0,
	},
	{ title: "Compat chat", lastReply: "done(compat-chat-second).", tools: 0 },
	{
		title: "Compat tools",
		lastReply: "done(compat-tools-follow-up).",
		tools: 2,
	},
];
const RENDERED_HISTORY_HASH =
	"297147da1b2a22984147227ecb6441969b8537df6cf184efb9b0c864ae9d8182";
/** The fixture's history rows; its other tables are recorded, not pinned. */
const FIXTURE_ROWS = {
	sessions: 3,
	messages: 10,
	message_parts: 12,
	turns: 5,
	events: 79,
};
const NEW_PROMPT = "compat-new-turn";

// Times of day, dates and relative times vary with the clock and time zone.
// The avatar initial above "You" comes from the host's git or account name.
const normalize = (text: string) =>
	text
		.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi, "<time>")
		.replace(
			/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, \d{4})?\b/g,
			"<date>",
		)
		.replace(
			/\b(?:just now|\d+\s?(?:s|m|h|d|w|mo|y|sec|min|hr|second|minute|hour|day|week|month|year)s? ago)\b/gi,
			"<ago>",
		)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join("\n")
		.replace(/^.{1,2}\nYou$/gmu, "You");

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");

const renderedHistory = async (
	browser: Browser,
	baseUrl: string,
	session: (typeof SESSIONS)[number] & { id: string },
) => {
	// A fresh context has no client cache, so the history comes from the store.
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		await new AppPage(page).goto(`${baseUrl}/s/${session.id}`);
		const messages = page.locator("#messages");
		await expect(messages).toContainText(session.lastReply, {
			timeout: 30_000,
		});
		// Settled tool steps stay collapsed until their activity ledger opens.
		await new ChatPage(page).turnActivityToggles.evaluateAll((toggles) => {
			for (const toggle of toggles)
				if (toggle.getAttribute("aria-expanded") !== "true")
					(toggle as HTMLButtonElement).click();
		});
		await expect(messages.locator(".tool-item")).toHaveCount(session.tools);
		let last: string | undefined;
		await expect
			.poll(
				async () => {
					const next = normalize(await messages.innerText());
					const settled = next === last;
					last = next;
					return settled;
				},
				{ intervals: [250] },
			)
			.toBe(true);
		return last ?? "";
	} finally {
		await context.close();
	}
};

test.use({ startHarness: false });
test.beforeEach(({ isMobile }) => {
	test.skip(isMobile, "The store compatibility pin renders on desktop");
});

test("an event store from an earlier build opens, renders identically and takes a new turn", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(240_000);
	const evidence = {
		fixture: "test/fixtures/event-store-compat/events.db",
		rows: {
			fixture: {} as Record<string, number>,
			opened: {} as Record<string, number>,
			afterTurn: {} as Record<string, number>,
		},
		renderedHistory: {
			hash: null as string | null,
			expectedHash: RENDERED_HISTORY_HASH,
			sessions: [] as {
				id: string;
				title: string;
				hash: string;
				text: string;
			}[],
		},
		newTurn: { prompt: NEW_PROMPT, rendered: false },
		timingsMs: { start: 0, render: 0, turn: 0 },
		passed: false,
	};
	writeImportArtifact(artifact, evidence);
	try {
		evidence.rows.fixture = storeTableCounts(fixture);
		const db = new DatabaseSync(fixture, { readOnly: true });
		const ids = (() => {
			try {
				return db
					.prepare("SELECT id, title FROM sessions ORDER BY created_at, id")
					.all();
			} finally {
				db.close();
			}
		})();
		expect(ids.map((row) => row["title"])).toEqual(
			SESSIONS.map((session) => session.title),
		);
		const sessions = SESSIONS.map((session, index) => ({
			...session,
			id: String(ids[index]?.["id"]),
		}));
		expect(evidence.rows.fixture).toMatchObject(FIXTURE_ROWS);
		copyFileSync(fixture, harness.daemonStorePath());
		// The fixture's sessions are old; idle policies would settle and
		// archive them on startup and change what the pin observes. The
		// avatar answer keeps the first-run dialog off the composer.
		writeFileSync(
			join(harness.configDir, "daemon.json"),
			JSON.stringify({
				...defaultDaemonConfig(),
				avatar: { kind: "initial" },
				autoSettleAfterDays: null,
				autoArchiveAfterDays: null,
			}),
		);

		let started = performance.now();
		// Bounded generously: module loading is slow on a busy machine.
		await harness.restart({
			startupTimeoutMs: 60_000,
			runnerStartupTimeoutMs: 60_000,
		});
		evidence.timingsMs.start = Math.round(performance.now() - started);
		evidence.rows.opened = storeTableCounts(harness.daemonStorePath());
		// Opening may append bookkeeping events, never history rows.
		for (const table of ["sessions", "messages", "message_parts", "turns"])
			expect(evidence.rows.opened[table], table).toBe(
				evidence.rows.fixture[table],
			);

		started = performance.now();
		for (const session of sessions) {
			const text = await renderedHistory(browser, harness.baseUrl, session);
			evidence.renderedHistory.sessions.push({
				id: session.id,
				title: session.title,
				hash: sha256(text),
				text,
			});
		}
		evidence.timingsMs.render = Math.round(performance.now() - started);
		evidence.renderedHistory.hash = sha256(
			JSON.stringify(
				evidence.renderedHistory.sessions.map(({ title, text }) => ({
					title,
					text,
				})),
			),
		);
		expect(evidence.renderedHistory.hash).toBe(RENDERED_HISTORY_HASH);

		started = performance.now();
		const chat = sessions[1];
		if (!chat) throw new Error("The fixture has no chat session");
		const context = await browser.newContext();
		try {
			const page = await context.newPage();
			const app = new AppPage(page);
			await app.goto(`${harness.baseUrl}/s/${chat.id}`);
			await expect(app.messages).toContainText(chat.lastReply);
			await app.sendMessage(NEW_PROMPT);
			await expect(app.messages).toContainText(`done(${NEW_PROMPT}).`, {
				timeout: 90_000,
			});
			evidence.newTurn.rendered = true;
		} finally {
			await context.close();
		}
		const opened = evidence.rows.opened;
		await expect
			.poll(() => storeTableCounts(harness.daemonStorePath())["turns"])
			.toBe((opened["turns"] ?? 0) + 1);
		evidence.timingsMs.turn = Math.round(performance.now() - started);
		const afterTurn = storeTableCounts(harness.daemonStorePath());
		// Runner bookkeeping rows vary with runner attachments, so only the
		// history tables keep the artifact repeatable after the live turn.
		evidence.rows.afterTurn = Object.fromEntries(
			Object.keys(FIXTURE_ROWS).map((table) => [table, afterTurn[table] ?? 0]),
		);
		expect(afterTurn["sessions"]).toBe(opened["sessions"]);
		expect(afterTurn["messages"]).toBe((opened["messages"] ?? 0) + 2);
		expect(afterTurn["message_parts"]).toBeGreaterThanOrEqual(
			(opened["message_parts"] ?? 0) + 2,
		);
		expect(afterTurn["events"]).toBeGreaterThan(opened["events"] ?? 0);
		evidence.passed = true;
	} finally {
		writeImportArtifact(artifact, evidence);
		await testInfo.attach("16c8-3-event-store-compat", {
			path: artifact,
			contentType: "application/json",
		});
	}
});
