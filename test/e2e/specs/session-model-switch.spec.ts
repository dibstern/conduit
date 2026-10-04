// Opening an existing Claude session from the sidebar shows the model it ran
// on. The page must learn it from the session switch alone: a fresh load into
// a new-session draft has no model for the session yet.

import { dirname } from "node:path";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.describe("Claude session model on session switch", () => {
	test.use({ claudeReplay: { turns: ["pong-thinking-text-turn"] } });

	test("the model chip names the session's model", async ({
		page,
		relayUrl,
		harness,
	}) => {
		const app = new AppPage(page);
		const sidebar = new SidebarPage(page);
		const trigger = page.getByTestId("model-picker-trigger");
		await app.goto(relayUrl);
		await app.sendMessage("One");
		await new ChatPage(page).waitForStreamingComplete();
		const sessionId = new URL(page.url()).pathname.split("/").at(-1) ?? "";

		// A different global default, so the draft's chip cannot stand in for
		// the session's model.
		await harness.restart(() =>
			saveRelaySettings(
				{ defaultModel: "opencode/big-pickle" },
				dirname(harness.eventsDbPath),
			),
		);
		await sidebar.newSessionBtn.click();
		await page.reload();
		await expect(page.locator("#connect-overlay")).toBeHidden({
			timeout: 30_000,
		});
		// The title end: the row's hover actions cover its centre.
		await page
			.locator(`[data-session-id="${sessionId}"]`)
			.click({ position: { x: 48, y: 12 } });
		await expect(page).toHaveURL(new RegExp(`${sessionId}$`));
		await expect(trigger).toHaveAttribute("aria-label", /Fable 5/);
	});
});
