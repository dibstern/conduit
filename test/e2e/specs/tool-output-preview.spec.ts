// A reopened session shows long tool output as a preview and fetches the rest
// on demand. The snapshot used to carry every tool output whole, megabytes for
// a busy session, before the transcript could paint.

import { DatabaseSync } from "node:sqlite";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.describe("Long tool output in a reopened session", () => {
	test.use({ claudeReplay: { turns: ["extra-folder-read-turn"] } });

	test("opens as a preview and expands to the full output", async ({
		page,
		relayUrl,
		harness,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		await app.sendMessage("Read the notes");
		await chat.waitForStreamingComplete();
		const sessionUrl = page.url();

		// Recorded traces carry short outputs, so lengthen one in the store.
		const output = "a line of tool output\n".repeat(6_000);
		const openActivity = () =>
			page.getByRole("button", { name: /^Worked for/ }).click();
		await openActivity();
		const toolId =
			(await page
				.locator(".tool-item[data-tool-id]")
				.first()
				.getAttribute("data-tool-id")) ?? "";
		await harness.restart(() => {
			const db = new DatabaseSync(harness.eventsDbPath);
			try {
				const { changes } = db
					.prepare("UPDATE message_parts SET result = ? WHERE call_id = ?")
					.run(JSON.stringify(output), toolId);
				expect(changes).toBe(1);
			} finally {
				db.close();
			}
		});

		await page.goto(sessionUrl);
		await openActivity();
		const tool = page.locator(`.tool-item[data-tool-id="${toolId}"]`);
		await tool.getByRole("button").first().click();
		const result = tool.locator(".tool-result");
		await expect(tool.getByText("Showing 48.8 KB of 128.9 KB")).toBeVisible();
		expect((await result.textContent())?.length).toBeLessThanOrEqual(50_000);

		await tool.getByRole("button", { name: "Show full output" }).click();
		await expect.poll(() => result.textContent()).toBe(output);
		await expect(tool.getByText(/^Showing /)).toHaveCount(0);
	});
});
