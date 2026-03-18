// ─── Live Smoke Test ──────────────────────────────────────────────────────────
// Validates the full relay pipeline end-to-end using a self-spawned
// ephemeral OpenCode instance.  Unlike replay-based specs this test hits
// the real OpenCode API, so it requires the `opencode` binary on $PATH
// and valid API credentials.

import { expect, test } from "@playwright/test";
import { createE2EHarness, type E2EHarness } from "../helpers/e2e-harness.js";
import {
	type SpawnedOpenCode,
	spawnOpenCode,
} from "../helpers/opencode-spawner.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

let spawned: SpawnedOpenCode;
let harness: E2EHarness;

test.beforeAll(async () => {
	spawned = await spawnOpenCode({ timeoutMs: 60_000 });
	// createE2EHarness handles model switching via E2E_MODEL / E2E_PROVIDER env vars
	harness = await createE2EHarness({ opencodeUrl: spawned.url });
});

test.afterAll(async () => {
	await harness?.stop();
	spawned?.stop();
});

test.describe("Live Smoke", () => {
	test("send prompt and receive pong", async ({ page }) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);

		// Navigate to the relay SPA and wait for WS connection
		await app.goto(`${harness.relayBaseUrl}/p/e2e-test/`);

		// Send a simple prompt
		await app.sendMessage("Reply with just the word pong");

		// Wait for the assistant response to render
		await chat.waitForAssistantMessage(90_000);
		await chat.waitForStreamingComplete(90_000);

		// Verify the response contains "pong"
		const text = await chat.getLastAssistantText();
		expect(text.toLowerCase()).toContain("pong");
	});
});
