/**
 * Re-capture one real Claude transcript read and whole-session fork.
 * RUN_EXPENSIVE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-fork-trace-capture.test.ts
 * Requires an existing Claude login. Review fork-session.json before committing.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { makeClaudeSdkEnv } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { defaultClaudeSessionForkSdk } from "../../../src/lib/provider/claude/claude-session-fork.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const PROMPT = "Reply with exactly CONDUIT-FORK-CAPTURE. Do not use tools.";

describe.skipIf(!RUN_EXPENSIVE)("Claude fork trace capture (real SDK)", () => {
	it("captures the production worker's transcript read and fork result", async () => {
		const projectDir = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-fork-capture-")),
		);
		const configDir = process.env["CLAUDE_CONFIG_DIR"];
		const session = query({
			prompt: PROMPT,
			options: {
				cwd: projectDir,
				model: "sonnet",
				tools: [],
				settingSources: [],
				maxTurns: 1,
				persistSession: true,
				env: makeClaudeSdkEnv({ configDir }),
			},
		});
		try {
			let parentSessionId: string | undefined;
			for await (const message of session) {
				if (message.type === "result") {
					expect(message.is_error).toBe(false);
					expect(message).toMatchObject({
						subtype: "success",
						result: "CONDUIT-FORK-CAPTURE",
					});
					parentSessionId = message.session_id;
				}
			}
			if (!parentSessionId) throw new Error("Claude returned no session id");
			const options = {
				dir: projectDir,
				...(configDir !== undefined && { configDir }),
			};
			const readTranscript = await defaultClaudeSessionForkSdk.readTranscript(
				parentSessionId,
				options,
			);
			expect(readTranscript.some((entry) => entry.type === "user")).toBe(true);
			expect(readTranscript.some((entry) => entry.type === "assistant")).toBe(
				true,
			);
			expect(JSON.stringify(readTranscript)).toContain("CONDUIT-FORK-CAPTURE");
			const forkSession = await defaultClaudeSessionForkSdk.forkSession(
				parentSessionId,
				{ ...options, title: "Claude fork capture" },
			);
			expect(forkSession.sessionId).not.toBe(parentSessionId);
			const forkTranscript = await defaultClaudeSessionForkSdk.readTranscript(
				forkSession.sessionId,
				options,
			);
			expect(forkTranscript.map((entry) => entry.message)).toEqual(
				readTranscript.map((entry) => entry.message),
			);

			let fixture = JSON.stringify(
				{
					model: "sonnet",
					prompt: PROMPT,
					parentSessionId,
					readTranscript,
					forkSession,
				},
				null,
				"\t",
			);
			for (const [from, to] of [
				[projectDir, "/tmp/conduit-fork-capture"],
				...(configDir ? [[configDir, "/home/test/.claude"]] : []),
				[homedir(), "/home/test"],
			]) {
				if (from && to) fixture = fixture.replaceAll(from, to);
			}
			fixture = fixture.replace(
				/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
				"redacted@example.test",
			);
			writeFileSync(
				join(
					import.meta.dirname,
					"../../fixtures/claude-sdk-traces/fork-session.json",
				),
				`${fixture}\n`,
			);
		} finally {
			session.close();
			rmSync(projectDir, { recursive: true, force: true });
		}
	}, 120_000);
});
