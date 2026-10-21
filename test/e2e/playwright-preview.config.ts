// All WS-mocked suites share one built frontend and one worker pool.
import { defineConfig } from "@playwright/test";

const port = Number(process.env["ACCEPTANCE_PORT"] ?? 4173);
// Renamed desktop projects must keep reading their original snapshot files.
const desktopSnapshots =
	"{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-desktop{-snapshotSuffix}{ext}";

export default defineConfig({
	testDir: "./specs",
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	retries: 1,
	workers: "100%",
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
		baseURL: `http://localhost:${port}`,
		viewport: { width: 1440, height: 900 },
		isMobile: false,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "off",
	},
	projects: [
		{
			name: "desktop",
			testMatch: "multi-instance.spec.ts",
		},
		{
			name: "mobile",
			testMatch: "multi-instance.spec.ts",
			use: {
				viewport: { width: 393, height: 852 },
				isMobile: true,
				hasTouch: true,
			},
		},
		{
			name: "project-scope",
			testMatch: "project-scope.spec.ts",
			snapshotPathTemplate: desktopSnapshots,
		},
		{
			name: "notification-nav",
			testMatch: "notification-session-nav.spec.ts",
			snapshotPathTemplate: desktopSnapshots,
		},
		{
			name: "notification-indicators",
			testMatch: "notification-indicators.spec.ts",
			snapshotPathTemplate: desktopSnapshots,
		},
		{
			name: "question-flow",
			testMatch: "question-flow.spec.ts",
			snapshotPathTemplate: desktopSnapshots,
		},
		{
			name: "subagent",
			testMatch: "subagent-sessions.spec.ts",
			snapshotPathTemplate: desktopSnapshots,
		},
		{
			name: "variant",
			testMatch: [
				"variant-selector.spec.ts",
				"context-window-selector.spec.ts",
				"permission-mode-selector.spec.ts",
				"composer-drift-layout.spec.ts",
				"composer-large-paste.spec.ts",
				"todo-overlay-feed.spec.ts",
				"composer-agent-list-race.spec.ts",
			],
			snapshotPathTemplate: desktopSnapshots,
		},
		{
			// The project name is part of the existing visual baseline paths.
			name: "desktop-visual",
			testMatch: "composer-layout.spec.ts",
			expect: {
				timeout: 10_000,
				toHaveScreenshot: { maxDiffPixels: 50 },
			},
		},
	],
	webServer: {
		command: `pnpm exec vite preview --port ${port} --strictPort`,
		cwd: "../../",
		port,
		// A busy port may serve another worktree. Preserve the guarded suites'
		// refusal to silently test that build, including outside CI.
		reuseExistingServer: false,
		timeout: 15_000,
	},
});
