// The parent's Side Threads list, against the real relay and event store with
// OpenCode replayed from the "side-thread" capture: a parent turn, one Side
// Thread question, then one follow-up.

import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const parentPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const question =
	"What word did I ask you to remember? Reply with only the word.";
const followUp = "Reply with only: ok, raised.";

function query(dbPath: string, sql: string, ...params: string[]) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(sql).all(...params);
	} finally {
		db.close();
	}
}

const sessionIdOf = (page: Page) =>
	new URL(page.url()).pathname.split("/").at(-1) ?? "";

/** A parent with one answered Side Thread; leaves the page on the Side Thread. */
async function parentWithSideThread(
	page: Page,
	relayUrl: string,
	dbPath: string,
) {
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	await app.goto(relayUrl);
	const parentId = sessionIdOf(page);
	await app.sendMessage(parentPrompt);
	await chat.waitForAssistantMessage();
	await expect
		.poll(
			() =>
				query(
					dbPath,
					"SELECT 1 FROM events WHERE session_id = ? AND type = 'turn.completed'",
					parentId,
				).length,
		)
		.toBeGreaterThan(0);
	await chat.waitForStreamingComplete();
	await app.sendMessage(`$btw ${question}`);
	await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
	const sideId = sessionIdOf(page);
	await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
	await chat.waitForStreamingComplete();
	return { app, chat, parentId, sideId };
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: true });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("Side Threads list", () => {
	test.use({ recording: "side-thread" });
	test.describe.configure({ timeout: 90_000 });

	test("a second client sees the Side Thread arrive, and a follow-up from the list lands in it across a reload", async ({
		page,
		browser,
		relayUrl,
		harness,
	}, testInfo) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);
		const context = await browser.newContext({ viewport: page.viewportSize() });
		const other = await context.newPage();
		try {
			// The second client parks on the parent before the Side Thread exists.
			await new AppPage(other).goto(page.url());
			const otherControl = other.getByTestId("side-threads-control");
			await expect(otherControl).toHaveCount(0);

			const { chat, parentId, sideId } = await parentWithSideThread(
				page,
				relayUrl,
				harness.eventsDbPath,
			);

			// Live, with no reload: the family push reaches the other viewer.
			await expect(otherControl).toHaveAccessibleName("1 Side Thread");
			await otherControl.click();
			await expect(
				other
					.getByTestId("side-threads-panel")
					.getByTestId("side-thread-title"),
			).toHaveText([question]);
			await attachScreenshot(other, testInfo, "second-client-list");

			await chat.subagentBackBtn.click();
			await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			const control = page.getByTestId("side-threads-control");
			await expect(control).toHaveAccessibleName("1 Side Thread");
			await control.click();
			await expect(control).toHaveAttribute("aria-expanded", "true");
			const rows = page.getByTestId("side-thread");
			await expect(rows).toHaveCount(1);
			await expect(rows.getByTestId("side-thread-title")).toHaveText(question);
			await expect(rows.getByTestId("side-thread-time")).toHaveText(/\S/);
			await attachScreenshot(page, testInfo, "parent-list");
			await rows.getByTestId("side-thread-open").click();
			await expect(page).toHaveURL(new RegExp(`/s/${sideId}(?:\\?|$)`));
			await expect(page.getByTestId("side-threads-panel")).toHaveCount(0);

			await app.sendMessage(followUp);
			await expect(chat.assistantMessages.last()).toContainText("ok, raised");
			await chat.waitForStreamingComplete();
			await expect(page).toHaveURL(new RegExp(`/s/${sideId}(?:\\?|$)`));
			const userTexts = () =>
				query(
					harness.eventsDbPath,
					"SELECT text FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at, id",
					sideId,
				).map((row) => String(row["text"]));
			// A fork carries its parent's transcript up to the fork point.
			await expect.poll(userTexts).toEqual([parentPrompt, question, followUp]);
			expect(
				query(
					harness.eventsDbPath,
					"SELECT 1 FROM messages WHERE session_id = ? AND text = ?",
					parentId,
					followUp,
				),
			).toHaveLength(0);

			await page.reload();
			await app.connectOverlay.waitFor({ state: "detached", timeout: 30_000 });
			await expect(
				chat.userMessages.filter({ hasText: question }),
			).toBeVisible();
			await expect(
				chat.userMessages.filter({ hasText: followUp }),
			).toBeVisible();
			await expect(
				chat.assistantMessages.filter({ hasText: /alpha/i }),
			).toHaveCount(1);
			await expect(chat.assistantMessages.last()).toContainText("ok, raised");
			await expect(chat.subagentBackBar).toContainText("Side Thread of");
			await attachScreenshot(page, testInfo, "follow-up-after-reload");
		} finally {
			await context.close();
		}
	});

	test("deleting from the list removes the Side Thread and leaves the parent", async ({
		page,
		relayUrl,
		harness,
		mockServer,
	}, testInfo) => {
		const { chat, parentId, sideId } = await parentWithSideThread(
			page,
			relayUrl,
			harness.eventsDbPath,
		);
		await chat.subagentBackBtn.click();
		await page.getByTestId("side-threads-control").click();
		await page.getByTestId("side-thread-delete").click();
		await expect(page.getByRole("dialog")).toContainText(
			`Delete "${question}"?`,
		);
		await page.getByTestId("confirm-modal-action").click();

		await expect(page.getByTestId("side-threads-empty")).toBeVisible();
		await expect(page.getByTestId("side-threads-control")).toHaveCount(0);
		await attachScreenshot(page, testInfo, "list-after-delete");
		await expect
			.poll(() =>
				query(
					harness.eventsDbPath,
					"SELECT id FROM sessions WHERE id IN (?, ?)",
					parentId,
					sideId,
				).map((row) => row["id"]),
			)
			.toEqual([parentId]);
		expect(
			mockServer.diagnostics.some(
				(entry) =>
					entry.event === "request" &&
					entry.detail?.startsWith(`DELETE /session/${sideId}`),
			),
		).toBe(true);
		await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
	});

	test("deleting the parent removes its Side Threads", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		const { chat, parentId, sideId } = await parentWithSideThread(
			page,
			relayUrl,
			harness.eventsDbPath,
		);
		await chat.subagentBackBtn.click();
		await page.getByTestId("session-bar-title-menu").click();
		await page.getByRole("menuitem", { name: /^Delete/ }).click();
		await page.getByTestId("confirm-modal-action").click();

		await expect
			.poll(() =>
				query(
					harness.eventsDbPath,
					"SELECT id FROM sessions WHERE id IN (?, ?)",
					parentId,
					sideId,
				),
			)
			.toEqual([]);
		const evidence = testInfo.outputPath("cascade-sessions.json");
		await writeFile(
			evidence,
			JSON.stringify(
				query(harness.eventsDbPath, "SELECT id, parent_id FROM sessions"),
				null,
				2,
			),
		);
		await testInfo.attach("cascade-sessions", {
			path: evidence,
			contentType: "application/json",
		});
	});
});
