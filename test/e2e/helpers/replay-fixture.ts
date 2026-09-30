// ─── Replay Test Fixture ─────────────────────────────────────────────────────
// Extends Playwright's base test with a `replay` fixture that starts a real
// relay backed by MockOpenCodeServer for each test.
//
// Usage in specs:
//   import { test } from "../helpers/replay-fixture.js";
//
//   test.describe("My Tests", () => {
//     test.use({ recording: "chat-simple" });
//
//     test("does something", async ({ page, relayUrl }) => {
//       await page.goto(relayUrl);
//       // ...
//     });
//   });
//
// Each test gets a fresh MockOpenCodeServer + RelayStack. The relay serves the
// built frontend from dist/frontend/, so no separate vite preview is needed.

import { test as base, type Page } from "@playwright/test";
import type { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import type { ClaudeReplayPlan } from "./claude-trace-replayer.js";
import { createReplayHarness, type ReplayHarness } from "./e2e-harness.js";

/** Options that tests can set via test.use() */
interface ReplayOptions {
	/** Name of the .opencode.json.gz recording to use (default: "chat-simple") */
	recording: string;
	/** Claude lane: open a Claude session replaying these SDK traces, one per
	 *  sent turn. The test fails unless exactly the planned turns are sent. */
	claudeReplay: ClaudeReplayPlan | undefined;
}

/** Fixtures provided to tests */
interface ReplayFixtures {
	/** The full URL to navigate to (relay base URL + project path) */
	relayUrl: string;
	/** The mock OpenCode server (for assertions or mid-test inspection) */
	mockServer: MockOpenCodeServer;
	/** The full replay harness (for advanced use) */
	harness: ReplayHarness;
}

export const test = base.extend<ReplayFixtures & ReplayOptions>({
	// Default recording — override per-describe with test.use({ recording: "..." })
	recording: ["chat-simple", { option: true }],
	claudeReplay: [undefined, { option: true }],

	// Per-test harness lifecycle
	harness: async ({ recording, claudeReplay }, use) => {
		const harness = await createReplayHarness(recording, {
			...(claudeReplay ? { claudeReplay } : {}),
		});
		try {
			await use(harness);
			harness.claudeReplayer?.assertComplete();
		} finally {
			await harness.stop();
		}
	},

	relayUrl: async ({ harness }, use) => {
		await use(harness.relayBaseUrl + harness.projectUrl);
	},

	mockServer: async ({ harness }, use) => {
		await use(harness.mock);
	},

	// Override Playwright's baseURL to point at the relay
	baseURL: async ({ harness }, use) => {
		await use(harness.relayBaseUrl);
	},
});

export { expect } from "@playwright/test";

/**
 * Navigate to the relay project URL and wait for the WebSocket to connect.
 * Convenience wrapper matching the old `app.goto(PROJECT_URL)` pattern.
 */
export async function gotoRelay(page: Page, relayUrl: string): Promise<void> {
	await page.goto(relayUrl);
	// Wait for Svelte SPA to mount — layout appears on initial render.
	// Without this, the overlay waitFor({ state: 'hidden' }) can pass
	// immediately because Playwright treats "not attached" as "hidden",
	// and #connect-overlay doesn't exist until Svelte renders.
	// Use the full test timeout (30s) — under resource pressure during
	// pnpm test:all, the SPA bundle + Svelte mount can take >15s.
	await page.locator("#layout").waitFor({ state: "attached", timeout: 30_000 });
	// Wait for WebSocket to connect — overlay should disappear
	await page.locator("#connect-overlay").waitFor({
		state: "hidden",
		timeout: 30_000,
	});
}
