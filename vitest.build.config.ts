import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for build-output tests (test/build/).
 * These tests verify dist/ artifacts and must run AFTER `pnpm build`.
 * Used by the lint-and-build CI job; excluded from the default vitest config.
 */
export default defineConfig({
	test: {
		include: ["test/build/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
});
