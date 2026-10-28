import { defineConfig } from "vitest/config";

// Performance budgets need an otherwise quiet machine and are deliberately
// separate from the unit, integration and release test groups.
export default defineConfig({
	test: {
		setupFiles: ["test/setup.ts"],
		include: ["test/budget/**/*.test.ts"],
		pool: "forks",
		maxWorkers: 1,
		fileParallelism: false,
		testTimeout: 120_000,
		hookTimeout: 30_000,
	},
});
