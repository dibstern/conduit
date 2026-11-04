// A Claude send from the browser completes through the Run Ledger on a real daemon whose
// session runs in its own runner process (82tn.32.6 box 1): the replayed turn renders the
// same transcript live and after a reload from the store, its runner reports its start
// once, before the Run's first frame, and its Run ends once, completed.
//
// Failure modes:
// 98. the browser send's Run never ends on the ledger, or ends twice, or not completed;
// 99. the runner's start reaches the ledger after the Run's first frame, twice, or never,
//     so the ledger refuses the runner's labelled facts;
// 100. the transcript the browser shows live differs from the one the store renders on reload.

import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { openPickerRoot } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

// pong-thinking-text-turn's prompt and reply.
const prompt = "Hello, reply with just the word pong";
const reply = "pong";

test.use({
	harnessOptions: { claudeReplay: { turns: ["pong-thinking-text-turn"] } },
});

test("a browser Claude send completes through the ledger with its transcript unchanged", async ({
	page,
	harness,
}, testInfo) => {
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	await app.goto(`${harness.baseUrl}/?p=process-test`);
	await page.locator("#new-session-btn:visible").click();
	await expect(app.input).toBeVisible();
	const picker = page.locator(
		'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible',
	);
	await openPickerRoot(page, picker);
	if ((await picker.getAttribute("data-instance-id")) !== "claude")
		await page.getByTestId("picker-harness-claude").click();
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator("[data-model-id]")
		.first()
		.click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("model-picker")).toBeHidden();
	await expect(picker).toHaveAttribute("data-instance-id", "claude");
	await app.input.fill(prompt);
	await app.sendBtn.click();
	await expect(page).toHaveURL(/\/s\/[^/?]+(?:\?.*)?$/);
	await expect(chat.assistantMessages.last().locator(".md-content")).toHaveText(
		reply,
	);
	await chat.waitForStreamingComplete();
	const sessionId = decodeURIComponent(
		new URL(page.url()).pathname.match(/\/s\/([^/]+)/)?.[1] ?? "",
	);
	// Each message's whole text, its stored time included.
	const transcript = async () => ({
		user: await chat.userMessages.allTextContents(),
		assistant: await chat.assistantMessages.allTextContents(),
		replies: await chat.assistantMessages
			.locator(".md-content")
			.allTextContents(),
	});
	const live = await transcript();
	await page.reload();
	await expect(chat.assistantMessages).toHaveCount(1);
	const reloaded = await transcript();

	const db = new Database(harness.daemonStorePath(), { readonly: true });
	const ledger = (() => {
		try {
			return {
				events: db
					.prepare(
						"SELECT sequence, type FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId) as { sequence: number; type: string }[],
				ends: db
					.prepare(
						"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.forced') AS forced FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
					)
					.all(sessionId) as {
					runId: string;
					reason: string;
					forced: number | null;
				}[],
				runs: db
					.prepare(
						"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
					)
					.all(sessionId) as { id: string; status: string }[],
			};
		} finally {
			db.close();
		}
	})();
	const proof = { sessionId, live, reloaded, ...ledger };
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		`test-results/82tn-32-6-claude-ledger-browser-${testInfo.project.name}.json`,
		`${JSON.stringify(proof, null, 2)}\n`,
	);
	await testInfo.attach("claude-ledger-browser.json", {
		body: JSON.stringify(proof, null, 2),
		contentType: "application/json",
	});

	expect(reloaded).toEqual(live);
	expect(live.replies.map((text) => text.trim())).toEqual([reply]);
	expect(live.user).toEqual([expect.stringContaining(prompt)]);
	expect(ledger.runs).toEqual([
		{ id: expect.any(String), status: "completed" },
	]);
	expect(ledger.ends).toEqual([
		{ runId: ledger.runs[0]?.id, reason: "completed", forced: null },
	]);
	const started = ledger.events.filter(
		(event) => event.type === "evidence.process_started",
	);
	expect(started).toHaveLength(1);
	// 6.1: the runner's start precedes every frame of the send's Run.
	const firstFrame = ledger.events.find(
		(event) => event.type === "message.created" || event.type === "run.started",
	);
	expect(started[0]?.sequence).toBeLessThan(
		firstFrame?.sequence ?? Number.POSITIVE_INFINITY,
	);
});
