import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [svelte()],
	test: {
		// Suppress pino log noise across all test projects.
		setupFiles: ["test/setup.ts"],
		// Component tests need jsdom + browser resolve condition so
		// Svelte resolves to its client bundle (which provides mount()).
		// All other tests run in the default node environment.
		projects: [
			// Explicit lifecycle invocations run the process harness; the default
			// unit sweep remains limited to the unit projects below.
			...(process.argv.some((arg) =>
				arg.includes(
					"test/integration/daemon/claude-process-runner-lifecycle.test.ts",
				),
			)
				? [
						{
							extends: true as const,
							test: {
								name: "runner-lifecycle",
								include: [
									"test/integration/daemon/claude-process-runner-lifecycle.test.ts",
								],
								environment: "node" as const,
								pool: "forks" as const,
								testTimeout: 30_000,
								hookTimeout: 30_000,
							},
						},
					]
				: []),
			{
				extends: true,
				test: {
					name: "components",
					include: ["test/unit/components/**/*.test.ts"],
					environment: "jsdom",
					testTimeout: 10_000,
					hookTimeout: 10_000,
				},
				resolve: {
					conditions: ["browser"],
				},
			},
			{
				extends: true,
				test: {
					name: "unit-sqlite",
					include: [
						"test/unit/persistence/**/*.test.ts",
						"test/unit/pipeline/thinking-lifecycle-pipeline.test.ts",
					],
					// forks isolates better-sqlite3 native module in separate
					// processes, preventing SIGSEGV from shared-memory corruption.
					pool: "forks",
					poolOptions: { forks: { singleFork: true } },
					testTimeout: 10_000,
					hookTimeout: 10_000,
				},
			},
			{
				extends: true,
				test: {
					name: "unit",
					include: ["test/unit/**/*.test.ts", "test/fixture/**/*.test.ts"],
					exclude: [
						"test/unit/components/**/*.test.ts",
						"test/unit/persistence/**/*.test.ts",
						"test/unit/pipeline/thinking-lifecycle-pipeline.test.ts",
					],
					testTimeout: 10_000,
					hookTimeout: 10_000,
					// Some unit tests outside the explicit SQLite project still touch
					// native SQLite bindings. Threads can segfault during teardown.
					pool: "forks",
				},
			},
		],
		coverage: {
			provider: "v8",
			include: [
				"src/lib/instance-manager.ts",
				"src/lib/daemon.ts",
				"src/lib/daemon-ipc.ts",
				"src/lib/ipc-protocol.ts",
				"src/lib/client-init.ts",
				"src/lib/config-persistence.ts",
				"src/lib/frontend/stores/instance.svelte.ts",
				"src/bin/cli-utils.ts",
				"src/bin/cli-core.ts",
				"src/lib/shared-types.ts",
			],
			reporter: ["text", "json-summary"],
			thresholds: {
				lines: 70,
				branches: 60,
			},
		},
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
});
