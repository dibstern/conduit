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

		// Since y7eo.6, opening a tool loads its full detail automatically.
		// Observe the real transcript stream to verify the initial preview.
		const received: unknown[] = [];
		page.on("websocket", (socket) => {
			socket.on("framereceived", ({ payload }) => {
				const frame = JSON.parse(payload.toString()) as {
					values?: readonly {
						_tag?: string;
						rows?: readonly unknown[];
						item?: unknown;
					}[];
				};
				for (const value of frame.values ?? []) {
					if (value._tag === "snapshot") received.push(...(value.rows ?? []));
					if (value._tag === "upsert") received.push(value.item);
				}
			});
		});
		await page.goto(sessionUrl);
		await expect
			.poll(() => received)
			.toContainEqual(
				expect.objectContaining({
					_tag: "part",
					part: expect.objectContaining({
						callID: toolId,
						state: expect.objectContaining({
							output: {
								_tag: "preview",
								text: output.slice(0, 2_000),
								fullBytes: Buffer.byteLength(output),
							},
						}),
					}),
				}),
			);
		await openActivity();
		const tool = page.locator(`.tool-item[data-tool-id="${toolId}"]`);
		await tool.getByRole("button").first().click();
		const result = tool.locator(".tool-result");
		await expect.poll(() => result.textContent()).toBe(output);
		await expect(tool.locator(".tool-full-detail")).toHaveCount(0);
	});
});
