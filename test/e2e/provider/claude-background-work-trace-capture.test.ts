/**
 * Capture real concurrent Claude background work for conduit-test-i7fy:
 * - through Conduit: two background agents (one starts a background shell), a
 *   top-level background shell, wake-up turns after the result, then a Claude
 *   process restart and one more turn (concurrent-background-work-turn.jsonl);
 * - straight through the SDK, because Conduit has no control for it: a
 *   foreground agent moved to the background mid-run
 *   (foreground-agent-backgrounded-turn.jsonl).
 * Each trace gets a .subagent-reads.json sidecar: every change seen in an
 * agent's transcript, stamped with how many SDK messages had been captured by
 * then, so a replay can serve transcript reads in their real order.
 *
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-background-work-trace-capture.test.ts
 * Review both traces and sidecars, then format the sidecars with biome, before
 * committing them.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	getSubagentMessages,
	listSubagents,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import { isRecord } from "../../../src/lib/utils.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const FIXTURES = join(import.meta.dirname, "../../fixtures/claude-sdk-traces");

const LAUNCH_PROMPT = [
	"Do exactly these three things in one message, then end your turn without waiting for any of them:",
	"1. Run this Bash command in the background (run_in_background: true): sleep 40; echo top-shell-done",
	"2. Launch a general-purpose agent in the background (run_in_background: true) described as 'agent A'. Its task: \"Start this Bash command in the background (run_in_background: true): sleep 15; echo nested-shell-done. Then run `echo a-working` in the foreground. Then wait for the background command to finish and reply with only: A done.\"",
	"3. Launch a general-purpose agent in the background (run_in_background: true) described as 'agent B'. Its task: \"Run `sleep 20; echo b-done` in the foreground, then reply with only: B done.\"",
	"After launching all three, reply with only: launched.",
].join("\n");
const WAKE_ACK =
	"When a background task finishes, reply with one short sentence naming it.";
const AFTER_RESTART_PROMPT = "Reply with only: ok, still here.";
const FOREGROUND_PROMPT =
	"Launch a general-purpose agent in the foreground (do NOT set run_in_background) described as 'agent F'. Its task: \"Run `sleep 25; echo f-done` in Bash, then reply with only: F done.\" When it is done, reply with only: done.";

type TranscriptRead = {
	readonly afterMessage: number;
	readonly agentId: string;
	readonly messages: readonly unknown[];
};

const redact = (text: string): string =>
	text
		.replaceAll(homedir(), "/home/test")
		.replace(
			/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
			"redacted@example.test",
		);

const redactLine = (line: string): string => {
	const message: unknown = JSON.parse(line);
	if (isRecord(message) && message["subtype"] === "hook_response") {
		for (const key of ["output", "stdout", "stderr"]) {
			if (message[key] !== "") message[key] = "[redacted: local hook output]";
		}
	}
	return redact(JSON.stringify(message));
};

const readLines = (path: string): string[] =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.trim() !== "")
		: [];

const parse = (lines: readonly string[]): SDKMessage[] =>
	lines.map((line) => JSON.parse(line) as SDKMessage);

/** Record every change in any agent transcript, stamped with the trace length. */
function watchTranscripts(input: {
	readonly claudeSessionId: () => string | undefined;
	readonly dir: string;
	readonly messageCount: () => number;
}) {
	const reads: TranscriptRead[] = [];
	const last = new Map<string, string>();
	let stopped = false;
	const poll = async () => {
		const sessionId = input.claudeSessionId();
		if (!sessionId) return;
		const agents = await listSubagents(sessionId, { dir: input.dir }).catch(
			() => [] as string[],
		);
		for (const agentId of agents) {
			const messages = await getSubagentMessages(sessionId, agentId, {
				dir: input.dir,
			}).catch(() => undefined);
			if (!messages) continue;
			const key = JSON.stringify(messages);
			if (last.get(agentId) === key) continue;
			last.set(agentId, key);
			reads.push({ afterMessage: input.messageCount(), agentId, messages });
		}
	};
	const loop = (async () => {
		while (!stopped) {
			await poll();
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		await poll();
	})();
	return {
		reads,
		stop: async () => {
			stopped = true;
			await loop;
		},
	};
}

/** Every started background task has finished and a later result arrived. */
function backgroundWorkSettled(messages: readonly SDKMessage[]): boolean {
	const started = new Set<string>();
	const finished = new Set<string>();
	let lastNotification = -1;
	let lastResult = -1;
	let live = 0;
	messages.forEach((message, index) => {
		if (message.type === "result") lastResult = index;
		if (message.type !== "system") return;
		if (message.subtype === "task_started" && message.ambient !== true)
			started.add(message.task_id);
		if (message.subtype === "task_notification") {
			finished.add(message.task_id);
			lastNotification = index;
		}
		if (message.subtype === "background_tasks_changed")
			live = message.tasks.length;
	});
	return (
		started.size >= 4 &&
		[...started].every((id) => finished.has(id)) &&
		live === 0 &&
		lastResult > lastNotification
	);
}

const writeFixture = (
	name: string,
	lines: readonly string[],
	reads: readonly TranscriptRead[],
) => {
	writeFileSync(
		join(FIXTURES, `${name}.jsonl`),
		`${lines.map(redactLine).join("\n")}\n`,
	);
	if (reads.length > 0)
		writeFileSync(
			join(FIXTURES, `${name}.subagent-reads.json`),
			`${redact(JSON.stringify(reads, null, "\t"))}\n`,
		);
};

const writeEvidence = (name: string, evidence: Record<string, unknown>) => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		`test-results/i7fy-1-${name}.json`,
		JSON.stringify(evidence, null, 2),
	);
};

const waitUntil = async (
	condition: () => boolean,
	timeoutMs: number,
	label: string,
) => {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
};

describe.skipIf(!RUN_EXPENSIVE)(
	"Claude background work trace capture (real SDK)",
	() => {
		it(
			"captures concurrent background agents and shells, wake-ups and a Claude process restart",
			async () => {
				const captureDir = mkdtempSync(
					join(tmpdir(), "conduit-background-capture-"),
				);
				const harness = ProcessHarness.create({
					dist: "dist",
					realSdk: true,
					claudeCaptureDir: captureDir,
				});
				const evidence: Record<string, unknown> = {
					ticket: "conduit-test-i7fy.1",
					at: new Date().toISOString(),
					captured: false,
				};
				let watcher: ReturnType<typeof watchTranscripts> | undefined;
				try {
					await harness.restart();
					let browser = await harness.connect();
					const sessionId = await browser.createSession(
						"Background work capture",
					);
					evidence["sessionId"] = sessionId;
					await Effect.runPromise(
						browser.rpc.SwitchPermissionMode({
							projectSlug: "process-test",
							sessionId,
							mode: "full",
						}),
					);
					const tracePath = join(captureDir, `${sessionId}.jsonl`);
					const trace = () => parse(readLines(tracePath));
					watcher = watchTranscripts({
						claudeSessionId: () =>
							trace().find((message) => "session_id" in message)?.session_id,
						dir: harness.projectDir,
						messageCount: () => readLines(tracePath).length,
					});

					const launched = await browser.send(
						sessionId,
						`${LAUNCH_PROMPT}\n${WAKE_ACK}`,
						180_000,
					);
					evidence["launchText"] = launched.chunks.join("");
					await waitUntil(
						() => backgroundWorkSettled(trace()),
						420_000,
						"background tasks to finish and the model to wake up",
					);
					// Let the last wake-up's transcript writes land.
					await new Promise((resolve) => setTimeout(resolve, 3_000));
					const beforeRestart = readLines(tracePath).length;
					evidence["messagesBeforeRestart"] = beforeRestart;

					// A Claude process restart: the daemon and every runner go away,
					// and the next turn resumes the session in a fresh process.
					await harness.kill();
					for (const pid of harness.remainingRunnerPids()) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// Already gone.
						}
					}
					await harness.restart();
					browser = await harness.connect();
					await browser.view(sessionId);
					const after = await browser.send(
						sessionId,
						AFTER_RESTART_PROMPT,
						180_000,
					);
					evidence["afterRestartText"] = after.chunks.join("");
					await watcher.stop();

					const lines = readLines(tracePath);
					const messages = lines.map((line) =>
						decodeClaudeSDKMessage(JSON.parse(line)),
					);
					const inits = messages.filter(
						(message) =>
							message.type === "system" && message.subtype === "init",
					);
					const results = messages.flatMap((message) =>
						message.type === "result" ? [message.total_cost_usd] : [],
					);
					const taskTypes = messages.flatMap((message) =>
						message.type === "system" && message.subtype === "task_started"
							? [message.task_type ?? "unknown"]
							: [],
					);
					const models = [
						...new Set(
							messages.flatMap((message) =>
								message.type === "assistant" ? [message.message.model] : [],
							),
						),
					];
					Object.assign(evidence, {
						messages: lines.length,
						inits: inits.length,
						resultCosts: results,
						taskTypes,
						models,
						transcriptReads: watcher.reads.length,
						agentsRead: [...new Set(watcher.reads.map((r) => r.agentId))],
					});
					expect(models.some((model) => /haiku/i.test(model))).toBe(false);
					expect(
						inits.length,
						"the restart started a new Claude process",
					).toBeGreaterThanOrEqual(2);
					expect(
						lines.slice(beforeRestart).some((line) => line.includes('"init"')),
					).toBe(true);
					expect(
						taskTypes.filter((type) => type === "local_agent").length,
					).toBe(2);
					expect(
						taskTypes.filter((type) => type === "local_bash").length,
					).toBeGreaterThanOrEqual(2);
					expect(results.length).toBeGreaterThanOrEqual(3);
					expect(watcher.reads.length).toBeGreaterThan(0);

					// One replay trace per sent turn: the launch turn with its wake-ups,
					// then the first turn of the restarted process.
					writeFixture(
						"concurrent-background-work-turn",
						lines.slice(0, beforeRestart),
						watcher.reads.filter((read) => read.afterMessage <= beforeRestart),
					);
					writeFixture(
						"concurrent-background-work-after-restart-turn",
						lines.slice(beforeRestart),
						[],
					);
					evidence["captured"] = true;
				} finally {
					await watcher?.stop();
					try {
						await harness.dispose();
					} finally {
						rmSync(captureDir, { recursive: true, force: true });
						evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
						writeEvidence("concurrent-background-work", evidence);
						expect(harness.remainingRunnerPids()).toEqual([]);
					}
				}
			},
			{ timeout: 900_000 },
		);

		it(
			"captures a foreground agent moved to the background mid-run",
			async () => {
				const workspace = mkdtempSync(join(tmpdir(), "conduit-fg-capture-"));
				const evidence: Record<string, unknown> = {
					ticket: "conduit-test-i7fy.1",
					at: new Date().toISOString(),
					captured: false,
				};
				const lines: string[] = [];
				let release: () => void = () => {};
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				// Open input, so the CLI keeps background tasks alive past the result.
				async function* prompt(): AsyncGenerator<SDKUserMessage> {
					yield {
						type: "user",
						message: { role: "user", content: FOREGROUND_PROMPT },
						parent_tool_use_id: null,
						session_id: "",
					};
					await held;
				}
				const run = query({
					prompt: prompt(),
					options: {
						cwd: workspace,
						includePartialMessages: true,
						permissionMode: "bypassPermissions",
						allowDangerouslySkipPermissions: true,
						settingSources: ["user", "project", "local"],
					},
				});
				let claudeSessionId: string | undefined;
				const watcher = watchTranscripts({
					claudeSessionId: () => claudeSessionId,
					dir: workspace,
					messageCount: () => lines.length,
				});
				let backgrounded: string | undefined;
				try {
					const deadline = Date.now() + 300_000;
					for await (const message of run) {
						lines.push(JSON.stringify(message));
						if ("session_id" in message) claudeSessionId = message.session_id;
						if (
							message.type === "system" &&
							message.subtype === "task_started" &&
							message.task_type === "local_agent" &&
							message.is_backgrounded !== true &&
							message.tool_use_id &&
							backgrounded === undefined
						) {
							backgrounded = message.tool_use_id;
							// Let the agent start its Bash call before backgrounding it.
							setTimeout(() => {
								void run.backgroundTasks(backgrounded);
							}, 4_000);
						}
						// A result after the agent's finish message is the wake-up.
						const settled =
							backgrounded !== undefined &&
							message.type === "result" &&
							lines
								.slice(0, -1)
								.some((line) => line.includes('"task_notification"'));
						if (settled || Date.now() > deadline) break;
					}
					release();
					await watcher.stop();
					const messages = lines.map((line) =>
						decodeClaudeSDKMessage(JSON.parse(line)),
					);
					const updates = messages.filter(
						(message) =>
							message.type === "system" && message.subtype === "task_updated",
					);
					Object.assign(evidence, {
						messages: lines.length,
						backgroundedToolUseId: backgrounded,
						taskUpdated: updates.length,
						transcriptReads: watcher.reads.length,
					});
					expect(backgrounded).toBeDefined();
					expect(
						lines.some((line) => line.includes('"task_notification"')),
					).toBe(true);
					writeFixture(
						"foreground-agent-backgrounded-turn",
						lines,
						watcher.reads,
					);
					evidence["captured"] = true;
				} finally {
					release();
					await watcher.stop();
					run.close();
					rmSync(workspace, { recursive: true, force: true });
					writeEvidence("foreground-agent-backgrounded", evidence);
				}
			},
			{ timeout: 400_000 },
		);
	},
);
