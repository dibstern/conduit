import { defineConfig } from "@playwright/test";

// CI has no codex binary. Missing it locally too keeps test daemons from
// cloning plugins off the network into the fixture root (conduit-test-lnm8.27).
process.env["CONDUIT_CODEX_BINARY"] ??= "/nonexistent/conduit-e2e/codex";

export default defineConfig({
	testDir: "./specs",
	testMatch: [
		"harness-*.spec.ts",
		"usage-footer-meter.spec.ts",
		"settings-server-status.spec.ts",
		"settings-server-logs.spec.ts",
		"settings-pin.spec.ts",
		"settings-opencode-instances.spec.ts",
		"settings-default-claude-account.spec.ts",
		"settings-power.spec.ts",
		"settings-access.spec.ts",
	],
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	// The retry only labels a failure flaky with a trace; CI still fails on it.
	retries: 1,
	failOnFlakyTests: !!process.env["CI"],
	workers: "100%",
	reporter: process.env["CI"]
		? [
				["github"],
				["html", { open: "never" }],
				["./helpers/require-tests-reporter.ts"],
			]
		: [["list"], ["./helpers/require-tests-reporter.ts"]],
	timeout: 60_000,
	expect: { timeout: 10_000 },
	use: {
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
		{
			name: "mobile",
			// These specs drive no viewport- or touch-dependent UI (RPC, store,
			// migration and render-count checks), so a mobile run only repeats
			// desktop. Ignoring them here also skips their harness fixtures.
			testIgnore: [
				"**/harness-create-latency.spec.ts",
				"**/harness-daemon-services.spec.ts",
				"**/harness-daemon-store-cutover.spec.ts",
				"**/harness-daemon-store-import.spec.ts",
				"**/harness-overflow-fanout-pin.spec.ts",
				"**/harness-session-cache.spec.ts",
				"**/harness-session-routing.spec.ts",
				"**/harness-store-contention.spec.ts",
				"**/harness-trace-artifact-pin.spec.ts",
				"**/harness-transcript-performance.spec.ts",
			],
			use: {
				viewport: { width: 393, height: 852 },
				isMobile: true,
				hasTouch: true,
			},
		},
	],
	// Each test's process harness serves the built frontend on its own port.
});
