import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { configDefaults, defineConfig } from "vitest/config";

const guardTests = ["test/unit/**/*.guard.test.ts"];

export default defineConfig({
	plugins: [svelte()],
	test: {
		// `related` cannot trace filesystem reads or spawned build artifacts.
		// It resolves inputs to absolute paths, so keep the **/ prefixes.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			"**/test/fixtures/**", // Includes captured SDK traces.
			"**/test/e2e/fixtures/**",
			"**/*-snapshots/**",
			"**/acceptance/visual/baselines/**",
			"**/test/e2e/baselines/**",
			"**/pnpm-lock.yaml",
			"**/tsconfig*.json",
			"**/test/setup.ts",
			"**/src/lib/frontend/style.css",
			"**/scripts/build.mjs",
		],
		// Suppress pino log noise in projects that use the runtime setup.
		setupFiles: ["test/setup.ts"],
		// Component tests need jsdom + browser resolve condition so
		// Svelte resolves to its client bundle (which provides mount()).
		// All other tests run in the default node environment.
		projects: [
			// Explicit lifecycle invocations run the process harness; the default
			// sweep remains limited to guards and the unit projects below.
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
								exclude: guardTests,
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
				// Static guards need no source imports or runtime setup.
				extends: false,
				test: {
					name: "guards",
					include: guardTests,
					environment: "node",
					testTimeout: 10_000,
					hookTimeout: 10_000,
				},
			},
			{
				extends: true,
				test: {
					name: "components",
					exclude: guardTests,
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
					exclude: guardTests,
					include: [
						"test/unit/persistence/**/*.test.ts",
						"test/unit/pipeline/thinking-lifecycle-pipeline.test.ts",
					],
					// forks isolates better-sqlite3 native module in separate
					// processes, preventing SIGSEGV from shared-memory corruption.
					pool: "forks",
					maxWorkers: 1,
					isolate: false,
					// Vitest requires a separate group for a different worker limit.
					sequence: { groupOrder: 1 },
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
						...guardTests,
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
