// A sent message appears in the transcript on the click, not when the server
// answers. The browser's input.submit frame is held, so only a local copy can
// show it; releasing the frame must leave exactly one copy.
import { writeFileSync } from "node:fs";
import { responseChunks } from "../../helpers/fake-claude-process-sdk.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.describe.configure({ retries: 0 });

test("a sent message shows before the server replies", async ({
	harness,
	page,
}, testInfo) => {
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Send shows message");
	const text = "send-shows-message-immediately";
	const app = new AppPage(page);
	const held: (() => void)[] = [];
	const report: Record<string, unknown> = { sessionId, text };

	await page.routeWebSocket(
		(url) => url.pathname === "/rpc",
		(client) => {
			const server = client.connectToServer();
			client.onMessage((message) => {
				const forward = () => server.send(message);
				if (message.toString().includes('"input.submit"')) held.push(forward);
				else forward();
			});
			server.onMessage((message) => client.send(message));
		},
	);

	try {
		await app.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
		await app.sendMessage(text);
		const userRow = app.messages.locator(".msg-user").filter({ hasText: text });
		const clicked = Date.now();
		await expect.poll(() => held.length).toBe(1);
		await expect(userRow).toHaveCount(1, { timeout: 1_000 });
		report["shownWhileHeldMs"] = Date.now() - clicked;

		for (const forward of held.splice(0)) forward();
		await expect(
			app.messages
				.locator(".msg-assistant")
				.filter({ hasText: responseChunks(text).join("").trim() }),
		).toHaveCount(1, { timeout: 30_000 });
		await expect(userRow).toHaveCount(1);
		report["passed"] = true;
	} finally {
		const output = testInfo.outputPath("send-shows-message.json");
		writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
		await testInfo.attach("send-shows-message", {
			path: output,
			contentType: "application/json",
		});
	}
});
