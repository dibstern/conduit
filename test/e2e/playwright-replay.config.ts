// ─── Playwright Config: Recorded Replay Tests ────────────────────────────────
// Tests UI against recorded HTTP-level OpenCode snapshots (replay mode).
// No real OpenCode needed — each test starts a real relay backed by
// MockOpenCodeServer serving the built frontend from dist/frontend/.
// No separate webServer (vite preview) is needed.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: [
		"chat.spec.ts",
		"chat-lifecycle.spec.ts",
		"permissions.spec.ts",
		"advanced-ui.spec.ts",
		"smoke.spec.ts",
		"sessions.spec.ts",
		"sidebar-layout.spec.ts",
		"ui-features.spec.ts",
		"debug-panel.spec.ts",
		"dashboard.spec.ts",
		"pin-page.spec.ts",
		"unified-rendering.spec.ts",
		"scroll-stability.spec.ts",
		"terminal.spec.ts",
		"notification-session-nav-replay.spec.ts",
		"fork-session.spec.ts",
	],
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	retries: process.env["CI"] ? 1 : 0,
	workers: process.env["CI"] ? 4 : "50%",
	reporter: process.env["CI"]
		? [["github"], ["html", { open: "never" }]]
		: "list",

	timeout: 30_000,
	expect: { timeout: 10_000 },

	use: {
		// No baseURL — each test gets a dynamic relay URL via the replay fixture.
		// Tests use `relayUrl` fixture or `page.goto(harness.relayBaseUrl + path)`.
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},

	projects: [
		{
			name: "desktop",
			use: {
				viewport: { width: 1440, height: 900 },
				isMobile: false,
			},
		},
	],

	// No webServer — the relay serves the built frontend directly.
	// Ensure `pnpm build:frontend` has been run before executing these tests.
});
