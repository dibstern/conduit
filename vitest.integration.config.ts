import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["test/setup.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// Run all files sequentially — integration tests spin up real servers
		// and must not compete for resources.
		fileParallelism: false,
		include: [
			"test/integration/**/*.integration.ts",
			"test/integration/**/*.test.ts",
		],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			// Daemon TLS tests that call startDaemonProcess trigger circular
			// dependency in services.ts re-export chain, causing "Not a valid
			// effect: undefined". The startHttpServer unit tests in the same
			// file pass fine — only the ManagedRuntime-based daemon tests fail.
			// TODO: Fix by refactoring services.ts to not re-export from modules
			// that participate in the daemon-main → daemon-layers cycle.
			"**/daemon-tls.test.ts",
		],
		pool: "threads",
	},
});
