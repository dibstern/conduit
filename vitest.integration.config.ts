import { availableParallelism } from "node:os";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Files are independent, so wall time is summed time over workers: on 16
// cores, 8 workers took 775 s against 1377 s for 4 (conduit-test-lnm8.9).
const maxWorkers = Number(
	process.env.CONDUIT_INTEGRATION_WORKERS ??
		Math.max(4, Math.floor(availableParallelism() / 2)),
);
if (!Number.isSafeInteger(maxWorkers) || maxWorkers <= 0) {
	throw new Error("CONDUIT_INTEGRATION_WORKERS must be a positive integer");
}

export default defineConfig({
	plugins: [svelte()],
	test: {
		globalSetup: ["scripts/source-hash.mjs"],
		setupFiles: ["test/setup.ts"],
		env: {
			CONDUIT_TEST_DIST: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		},
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// Each file owns its servers and temp dirs, so files can run in parallel.
		fileParallelism: true,
		maxWorkers,
		include: [
			"test/integration/**/*.integration.ts",
			"test/integration/**/*.test.ts",
		],
		exclude: ["**/node_modules/**", "**/dist/**"],
		pool: "forks",
	},
});
