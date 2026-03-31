import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"test/integration/**/*.integration.ts",
			"test/integration/**/*.test.ts",
		],
		setupFiles: ["test/setup.ts"],
		testTimeout: 10_000,
		hookTimeout: 10_000,
		// Each file gets its own MockOpenCodeServer + relay — safe to parallelize
		pool: "forks",
	},
});
