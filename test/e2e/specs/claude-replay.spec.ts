// Claude sessions whose SDK turns replay committed Claude SDK traces through
// the runtime's injected queryFactory (see helpers/claude-trace-replayer.ts).
// The replay fixture fails the test unless exactly the planned turns are sent.

import { DatabaseSync } from "node:sqlite";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

function countEvents(dbPath: string | undefined, type: string): number {
	if (!dbPath) throw new Error("Claude replay harness has no event store");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const row = db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?")
			.get(type);
		return Number(row?.["n"]);
	} finally {
		db.close();
	}
}

test.describe("Claude replay lane", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});

	test.describe("same trace three times", () => {
		test.use({
			claudeReplay: {
				turns: [
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
				],
			},
		});

		test("yields three turn ends", async ({ page, relayUrl, harness }) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);

			for (const [index, text] of ["One", "Two", "Three"].entries()) {
				await app.sendMessage(text);
				await expect(chat.assistantMessages).toHaveCount(index + 1);
				await chat.waitForStreamingComplete();
			}

			await expect(chat.assistantMessages).toHaveText([
				/pong/i,
				/pong/i,
				/pong/i,
			]);
			await expect
				.poll(() => countEvents(harness.eventsDbPath, "turn.completed"))
				.toBe(3);
		});
	});

	test.describe("sub-agent trace", () => {
		test.use({ claudeReplay: { turns: ["subagent-task-turn"] } });

		test("replays a Task sub-agent turn", async ({ page, relayUrl }) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);

			await app.sendMessage("Ask a subagent to summarise package.json");
			await chat.waitForAssistantMessage();
			await chat.waitForStreamingComplete();

			// The Task sub-agent lands in the (collapsed) turn activity summary.
			await expect(chat.turnActivityToggles.last()).toContainText("1 subagent");
			expect(await chat.getLastAssistantText()).toContain(
				"The subagent reports",
			);
		});
	});
});
