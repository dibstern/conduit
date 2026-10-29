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
		"usage-footer-meter.spec.ts",
		"settings-server-status.spec.ts",
		"settings-server-logs.spec.ts",
		"settings-pin.spec.ts",
		"settings-opencode-instances.spec.ts",
		"settings-default-claude-account.spec.ts",
		"settings-power.spec.ts",
		"settings-access.spec.ts",
		// playwright-live.config.ts: an ephemeral OpenCode instance.
		"live-smoke.spec.ts",
		"live-surfacing.spec.ts",
		// playwright-preview.config.ts: Vite preview with a mocked WebSocket.
		"multi-instance.spec.ts",
		"notification-session-nav.spec.ts",
		"notification-indicators.spec.ts",
		"project-scope.spec.ts",
		"question-flow.spec.ts",
		"subagent-sessions.spec.ts",
		"variant-selector.spec.ts",
		"context-window-selector.spec.ts",
		"permission-mode-selector.spec.ts",
		"composer-drift-layout.spec.ts",
		"composer-large-paste.spec.ts",
		"todo-overlay-feed.spec.ts",
		"composer-agent-list-race.spec.ts",
		"composer-layout.spec.ts",
	],
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	// The retry only labels a failure flaky with a trace; CI still fails on it.
	retries: 1,
	failOnFlakyTests: !!process.env["CI"],
	// Each worker runs Chromium, an in-process relay and real child processes
	// (PTY hosts, shells). One worker per core saturates the machine and pushes
	// every test toward its timeouts. Terminals no longer fail on a slow PTY
	// host start alone: the server waits while the host is alive, up to a 15 s
	// backstop (conduit-test-ni8.59).
	workers: "50%",
	// require-tests-reporter fails a run where every test skipped (conduit-test-g49a).
	reporter: process.env["CI"]
		? [
				["github"],
				["html", { open: "never" }],
				["./helpers/require-tests-reporter.ts"],
			]
		: [["list"], ["./helpers/require-tests-reporter.ts"]],

	timeout: 30_000,
	// Text snapshots are platform-neutral; pixel baselines stay per platform.
	snapshotPathTemplate:
		"{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{ext}",
	expect: {
		timeout: 10_000,
		toHaveScreenshot: {
			pathTemplate:
				"{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}",
		},
	},

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
