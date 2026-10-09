/**
 * Capture the experimental usage control response without a model turn.
 * RUN_EXPENSIVE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-usage-trace-capture.test.ts
 * Requires an existing Claude login. Review usage-control-response.json before committing.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeClaudeSdkEnv } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ClaudeUsageResponseSchema } from "../../../src/lib/provider/claude/claude-usage-schema.js";
import {
	closeClaudeEmptyQuery,
	makeClaudeEmptyQuery,
} from "../../../src/lib/provider/claude/claude-warmed-query.js";

describe.skipIf(process.env["RUN_EXPENSIVE_E2E"] !== "1")(
	"Claude usage trace capture (real SDK)",
	() => {
		it("captures the exact usage control response for the logged-in account", async () => {
			const projectDir = realpathSync(
				mkdtempSync(join(tmpdir(), "conduit-usage-capture-")),
			);
			try {
				const response = await Effect.runPromise(
					Effect.acquireUseRelease(
						makeClaudeEmptyQuery(query, (abortController) => ({
							cwd: projectDir,
							abortController,
							env: makeClaudeSdkEnv({
								configDir: process.env["CLAUDE_CONFIG_DIR"],
							}),
							persistSession: false,
							settingSources: ["user"],
							settings: { disableAllHooks: true },
							tools: [],
						})),
						(resource) =>
							Effect.tryPromise(async () => {
								const init = await resource.query.initializationResult();
								expect(init.account).toBeDefined();
								return resource.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
									{ skipBehaviors: true },
								);
							}),
						closeClaudeEmptyQuery,
					).pipe(Effect.timeout("20 seconds")),
				);
				const decoded = Schema.decodeUnknownSync(ClaudeUsageResponseSchema)(
					response,
				);
				expect(decoded.rate_limits_available).toBe(true);
				writeFileSync(
					join(
						import.meta.dirname,
						"../../fixtures/claude-sdk-traces/usage-control-response.json",
					),
					`${JSON.stringify(response, null, "\t")}\n`,
				);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		}, 30_000);
	},
);
