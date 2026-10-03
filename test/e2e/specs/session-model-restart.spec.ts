// A Claude session keeps showing its harness and model after a relay restart
// and a page reload. Overrides live in memory, so the persisted turn is the
// only record left once the relay restarts.

import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.describe("Claude session model across a relay restart", () => {
	test.use({
		claudeReplay: {
			turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
		},
	});

	test("the model chip still names the session's model", async ({
		page,
		relayUrl,
		harness,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const trigger = page.getByTestId("model-picker-trigger");
		await app.goto(relayUrl);
		await app.sendMessage("One");
		await chat.waitForStreamingComplete();
		await expect(trigger).toHaveAttribute("aria-label", /Fable 5/);

		// The global default moves on (another session picked an OpenCode model),
		// so only the persisted turn still knows this session ran on Fable 5.
		await harness.restart(() =>
			saveRelaySettings(
				{ defaultModel: "opencode/big-pickle" },
				dirname(harness.eventsDbPath),
			),
		);
		await gotoRelay(page, relayUrl);
		await expect(page.locator("#connect-overlay")).toBeHidden({
			timeout: 30_000,
		});
		await expect(trigger).toHaveAttribute("aria-label", /Fable 5/);
		await expect(trigger).toBeVisible();

		// The next turn must go to the same harness and model, not the new default.
		await app.sendMessage("Two");
		await chat.waitForStreamingComplete();
		const sessionId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
		const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
		try {
			expect(
				db
					.prepare(
						`SELECT s.provider, t.requested_model FROM sessions s
						 JOIN turns t ON t.session_id = s.id
						 WHERE s.id = ? ORDER BY t.requested_at DESC LIMIT 1`,
					)
					.get(sessionId),
			).toEqual({ provider: "claude", requested_model: "claude-fable-5" });
		} finally {
			db.close();
		}
	});
});
