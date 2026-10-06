// Tests UI against recorded HTTP-level OpenCode snapshots (replay mode).
// No real OpenCode needed — each test starts a real relay backed by
// MockOpenCodeServer serving the built frontend from dist/frontend/.
// No separate webServer (vite preview) is needed.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	// New replay specs are included by default. Keep specs with a different harness
	// in this explicit list, alongside the config that owns them.
	testMatch: "**/*.spec.ts",
	testIgnore: [
		// playwright-daemon.config.ts: real daemon and OpenCode.
		"daemon-*.spec.ts",
		// playwright-harness.config.ts: isolated daemon processes with recorded providers.
		"harness-*.spec.ts",
		// playwright-live.config.ts: an ephemeral OpenCode instance.
		"live-smoke.spec.ts",
		// playwright-multi-instance.config.ts: Vite preview with a mocked WebSocket.
		"multi-instance.spec.ts",
		// playwright-notification-nav.config.ts: Vite preview with a mocked WebSocket.
		"notification-session-nav.spec.ts",
		// playwright-notification-reducer.config.ts: Vite preview with a mocked WebSocket.
		"notification-reducer-indicators.spec.ts",
		// playwright-project-scope.config.ts: Vite preview with a mocked WebSocket.
		"project-scope.spec.ts",
		// playwright-question-flow.config.ts: Vite preview with a mocked WebSocket.
		"question-flow.spec.ts",
		// playwright-subagent.config.ts: Vite preview with a mocked WebSocket.
		"subagent-sessions.spec.ts",
		// playwright-variant.config.ts: Vite preview with a mocked WebSocket.
		"variant-selector.spec.ts",
		"context-window-selector.spec.ts",
		"permission-mode-selector.spec.ts",
		"composer-drift-layout.spec.ts",
		"composer-large-paste.spec.ts",
		"todo-overlay-feed.spec.ts",
		// playwright-visual.config.ts: visual snapshot suite.
		"visual-mockup.spec.ts",
		"composer-layout.spec.ts",
	],
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	retries: 1,
	workers: "100%",
	// require-tests-reporter fails a run where every test skipped (conduit-test-g49a).
	reporter: process.env["CI"]
		? [
				["github"],
				["html", { open: "never" }],
				["./helpers/require-tests-reporter.ts"],
			]
		: [["list"], ["./helpers/require-tests-reporter.ts"]],

	timeout: 30_000,
	expect: { timeout: 10_000 },

	use: {
		// No baseURL — each test gets a dynamic relay URL via the replay fixture.
		// Tests use `relayUrl` fixture or `page.goto(harness.relayBaseUrl + path)`.
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "off",
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
