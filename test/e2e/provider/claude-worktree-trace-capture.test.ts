/**
 * Pin the cwd/resume contract observed with Claude Agent SDK 0.3.289.
 * RUN_EXPENSIVE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-worktree-trace-capture.test.ts
 * Requires an existing Claude login; no build is needed. Successful runs write
 * EnterWorktree/ExitWorktree JSONL fixtures for the fake SDK. Review before committing.
 * Every run leaves its observations and raw turns in test-results/q5u6-1.1-worktree/.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import { makeClaudeSdkEnv } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { isRecord } from "../../../src/lib/utils.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const WORKTREE_NAME = "contract";

// Match a tool result to its call, so unrelated output cannot satisfy a contract.
function toolResult(
	messages: readonly SDKMessage[],
	name: string,
	input: Record<string, unknown>,
) {
	const call = messages
		.flatMap((message) =>
			message.type === "assistant" && message.parent_tool_use_id === null
				? message.message.content.filter((block) => block.type === "tool_use")
				: [],
		)
		.find((block) => {
			if (block.name !== name || !isRecord(block.input)) return false;
			const toolInput = block.input;
			return Object.entries(input).every(
				([key, value]) => toolInput[key] === value,
			);
		});
	if (!call)
		throw new Error(`Missing ${name} call with ${JSON.stringify(input)}`);
	for (const message of messages) {
		if (message.type !== "user" || !Array.isArray(message.message.content))
			continue;
		const result = message.message.content.find(
			(block) => block.type === "tool_result" && block.tool_use_id === call.id,
		);
		if (!result || result.type !== "tool_result") continue;
		expect(result.is_error, `${name} tool result`).not.toBe(true);
		const text =
			typeof result.content === "string"
				? result.content
				: (result.content ?? [])
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("\n");
		return { call, text, output: message.tool_use_result };
	}
	throw new Error(`Missing ${name} result for ${call.id}`);
}

describe.skipIf(!RUN_EXPENSIVE)("Claude worktree contract (real SDK)", () => {
	it(
		"pins cwd changes, sticky worktrees and ExitWorktree keep; captures move turns",
		async () => {
			const at = new Date().toISOString();
			const artifactDir = join(
				"test-results/q5u6-1.1-worktree",
				`${at.replaceAll(":", "-")}-${randomUUID()}`,
			);
			mkdirSync(artifactDir, { recursive: true });
			const temporaryRoot = mkdtempSync(
				join(tmpdir(), "conduit-worktree-capture-"),
			);
			const root = realpathSync(temporaryRoot);
			const repo = join(root, "repo");
			const linkedWorktree = join(root, "repo-wt");
			const enteredWorktree = join(repo, ".claude/worktrees", WORKTREE_NAME);
			const configDir = process.env["CLAUDE_CONFIG_DIR"];
			const hookObservations: {
				turn: string;
				oldCwd: string;
				newCwd: string;
			}[] = [];
			const turns: Record<string, unknown>[] = [];
			const behaviours: Record<string, boolean | null> = {
				resumeDifferentCwd: null,
				bashCdReset: null,
				enterWorktreeSticky: null,
				exitWorktreeKeepClears: null,
			};
			const evidence: Record<string, unknown> = {
				ticket: "conduit-test-q5u6.1.1",
				at,
				repo,
				linkedWorktree,
				enteredWorktree,
				behaviours,
				hookObservations,
				turns,
				captured: false,
			};

			const run = async (
				label: string,
				prompt: string,
				cwd: string,
				resume?: string,
			) => {
				const tracePath = join(artifactDir, `${label}.jsonl`);
				const observation: Record<string, unknown> = {
					label,
					prompt,
					cwd,
					resume,
					tracePath,
				};
				turns.push(observation);
				const messages: SDKMessage[] = [];
				const abortController = new AbortController();
				const session = query({
					prompt,
					options: {
						cwd,
						...(resume ? { resume } : {}),
						model: "sonnet",
						permissionMode: "bypassPermissions",
						allowDangerouslySkipPermissions: true,
						settingSources: [],
						persistSession: true,
						includePartialMessages: true,
						maxTurns: 6,
						abortController,
						env: makeClaudeSdkEnv({ configDir }),
						hooks: {
							CwdChanged: [
								{
									hooks: [
										async (input) => {
											if (input.hook_event_name === "CwdChanged") {
												hookObservations.push({
													turn: label,
													oldCwd: input.old_cwd,
													newCwd: input.new_cwd,
												});
												console.warn(
													"CwdChanged fired: revisit the hook as the move signal.",
												);
											}
											return {};
										},
									],
								},
							],
						},
					},
				});
				const timeout = setTimeout(() => abortController.abort(), 120_000);
				try {
					for await (const message of session) {
						// Preserve the raw envelope before decoding, as runtime capture does.
						appendFileSync(tracePath, `${JSON.stringify(message)}\n`);
						messages.push(message);
						if (message.type === "system" && message.subtype === "init") {
							observation["initCwd"] = message.cwd;
							observation["sessionId"] = message.session_id;
							observation["claudeCodeVersion"] = message.claude_code_version;
						}
						if (message.type === "result") observation["result"] = message;
					}
				} finally {
					clearTimeout(timeout);
					session.close();
				}
				for (const message of messages) decodeClaudeSDKMessage(message);
				const init = messages.find(
					(message) => message.type === "system" && message.subtype === "init",
				);
				if (!init || init.type !== "system" || init.subtype !== "init")
					throw new Error(`${label}: missing system init`);
				expect(messages.filter((message) => message.type === "result")).toEqual(
					[expect.objectContaining({ subtype: "success", is_error: false })],
				);
				if (resume) expect(init.session_id).toBe(resume);
				return { messages, init, tracePath };
			};

			try {
				mkdirSync(repo);
				// All git mutations are confined to this temporary repository.
				const git = (...args: string[]) =>
					execFileSync(
						"git",
						[
							"-c",
							"user.name=Conduit contract",
							"-c",
							"user.email=contract@example.test",
							"-c",
							"commit.gpgsign=false",
							"-c",
							"core.hooksPath=/dev/null",
							...args,
						],
						{ cwd: repo, encoding: "utf8" },
					).trim();
				git("init", "-q", "-b", "main");
				writeFileSync(join(repo, "README.md"), "Claude worktree contract\n");
				git("add", "README.md");
				git("commit", "-qm", "Initial contract repository");
				git("worktree", "add", "-q", "-b", "feature", linkedWorktree);

				behaviours["resumeDifferentCwd"] = false;
				const codeword = `CONDUIT-WORKSPACE-${randomUUID()}`;
				const seed = await run(
					"remember-codeword",
					`Remember this exact codeword for later turns: ${codeword}. Reply briefly. Do not use tools.`,
					repo,
				);
				expect(seed.init.cwd).toBe(repo);
				const resumed = await run(
					"resume-different-cwd",
					"Recall the codeword I asked you to remember. Without reading files, use Bash once to print that remembered codeword with printf, then stop. Put the remembered value in the command.",
					linkedWorktree,
					seed.init.session_id,
				);
				expect(resumed.init.cwd).toBe(linkedWorktree);
				const recall = toolResult(resumed.messages, "Bash", {});
				expect(recall.call.input).toEqual(
					expect.objectContaining({
						command: expect.stringContaining(codeword),
					}),
				);
				expect(recall.text).toContain(codeword);
				behaviours["resumeDifferentCwd"] = true;

				behaviours["bashCdReset"] = false;
				const cdCommand = `cd '${linkedWorktree.replaceAll("'", "'\\''")}' && pwd`;
				const bash = await run(
					"bash-cd-reset",
					`Use Bash to run exactly this command: ${cdCommand}. Then run exactly pwd in a separate Bash call. Do not use EnterWorktree or ExitWorktree.`,
					repo,
				);
				const cd = toolResult(bash.messages, "Bash", { command: cdCommand });
				expect(cd.text).toContain(linkedWorktree);
				expect(cd.text).toContain("Shell cwd was reset");
				const pwd = toolResult(bash.messages, "Bash", { command: "pwd" });
				expect(pwd.text.trim()).toBe(repo);
				behaviours["bashCdReset"] = true;

				behaviours["enterWorktreeSticky"] = false;
				const entered = await run(
					"enter-worktree",
					`Call EnterWorktree with name '${WORKTREE_NAME}', then stop. Do not use Bash to create or enter a worktree.`,
					repo,
				);
				const enter = toolResult(entered.messages, "EnterWorktree", {
					name: WORKTREE_NAME,
				});
				expect(enter.output).toMatchObject({ worktreePath: enteredWorktree });
				expect(realpathSync(enteredWorktree)).toBe(enteredWorktree);
				for (const [label, cwd] of [
					["sticky-resume-linked", linkedWorktree],
					["sticky-resume-main", repo],
				] as const) {
					const sticky = await run(
						label,
						"Run exactly pwd with Bash, then stop. Do not call EnterWorktree or ExitWorktree.",
						cwd,
						entered.init.session_id,
					);
					expect(sticky.init.cwd).toBe(enteredWorktree);
					expect(
						toolResult(sticky.messages, "Bash", { command: "pwd" }).text.trim(),
					).toBe(enteredWorktree);
				}
				behaviours["enterWorktreeSticky"] = true;

				behaviours["exitWorktreeKeepClears"] = false;
				const exited = await run(
					"exit-worktree-keep",
					"Call ExitWorktree with action 'keep', then stop. Do not delete the worktree or branch.",
					repo,
					entered.init.session_id,
				);
				const exit = toolResult(exited.messages, "ExitWorktree", {
					action: "keep",
				});
				expect(exit.output).toMatchObject({
					action: "keep",
					originalCwd: repo,
					worktreePath: enteredWorktree,
				});
				expect(existsSync(join(enteredWorktree, ".git"))).toBe(true);
				for (const [label, cwd] of [
					["after-exit-resume-linked", linkedWorktree],
					["after-exit-resume-main", repo],
				] as const) {
					const afterExit = await run(
						label,
						"Run exactly pwd with Bash, then stop. Do not call EnterWorktree or ExitWorktree.",
						cwd,
						entered.init.session_id,
					);
					expect(afterExit.init.cwd).toBe(cwd);
					expect(
						toolResult(afterExit.messages, "Bash", {
							command: "pwd",
						}).text.trim(),
					).toBe(cwd);
				}
				behaviours["exitWorktreeKeepClears"] = true;

				const fixtureDir = join(
					import.meta.dirname,
					"../../fixtures/claude-sdk-traces",
				);
				for (const [turn, name] of [
					[entered, "enter-worktree-turn"],
					[exited, "exit-worktree-keep-turn"],
				] as const) {
					let fixture = readFileSync(turn.tracePath, "utf8");
					for (const [from, to] of [
						[root, "/tmp/conduit-worktree-capture"],
						[temporaryRoot, "/tmp/conduit-worktree-capture"],
						...(configDir ? [[configDir, "/home/test/.claude"]] : []),
						[homedir(), "/home/test"],
					]) {
						if (from && to) fixture = fixture.replaceAll(from, to);
					}
					fixture = fixture.replace(
						/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
						"redacted@example.test",
					);
					writeFileSync(join(fixtureDir, `${name}.jsonl`), fixture);
				}
				evidence["captured"] = true;
			} catch (error) {
				evidence["error"] =
					error instanceof Error ? error.stack : String(error);
				throw error;
			} finally {
				evidence["cwdChangedFired"] = hookObservations.length > 0;
				if (hookObservations.length > 0)
					evidence["hookMoveSignal"] =
						"CwdChanged fired: revisit the hook as the move signal.";
				try {
					rmSync(root, { recursive: true, force: true });
				} finally {
					const artifactPath = join(artifactDir, "run.json");
					writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`);
					console.info(`Claude worktree contract artifact: ${artifactPath}`);
				}
			}
		},
		{ timeout: 1_200_000 },
	);
});
