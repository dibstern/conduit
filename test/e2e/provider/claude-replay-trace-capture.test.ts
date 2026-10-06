/**
 * Re-capture the real Claude replay traces used by claude-replay.spec.ts with an
 * existing login.
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-replay-trace-capture.test.ts
 * Each capture is copied over its fixture only after every turn finished and the
 * trace shows the SDK echoing each sent input id, in send order: each one
 * started once and answered by exactly one result.
 * Review the traces before committing them.
 */
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, Schedule } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	type ClaudeSDKCommandLifecycleMessage,
	decodeClaudeSDKMessage,
} from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const TRACES = join(import.meta.dirname, "../../fixtures/claude-sdk-traces");

type Raw = Record<string, unknown>;

// Local SessionStart hooks print machine-specific context; keep their shape only.
const redact = (raw: Raw): Raw =>
	raw["subtype"] === "hook_response"
		? Object.fromEntries(
				Object.entries(raw).map(([key, value]) =>
					(key === "output" || key === "stdout") && value !== ""
						? [key, "[redacted: local SessionStart hook output]"]
						: [key, value],
				),
			)
		: raw;

async function capture(options: {
	fixture: string;
	modelId: string;
	/** Later prompts are sent once the first turn reports `sendLaterOn`. */
	prompts: readonly [string, ...string[]];
	/** The browser frame that sends later prompts (default: a tool running). */
	sendLaterOn?: "tool_executing" | "delta";
	/** How later prompts are sent: queued, steered, or queued then promoted to
	 *  a steer with sendNow (default: queue). */
	later?: "queue" | "steer" | "sendNow";
	/** Stop the session this long after the later prompts were sent. */
	stopAfterMs?: number;
	/** Provider results the capture ends with (default: one per prompt). */
	results?: number;
	expectReply: string;
	setup?: (projectDir: string) => void;
}): Promise<void> {
	const results = options.results ?? options.prompts.length;
	const captureDir = mkdtempSync(join(tmpdir(), "conduit-replay-capture-"));
	const harness = ProcessHarness.create({
		dist: "dist",
		realSdk: true,
		claudeCaptureDir: captureDir,
	});
	try {
		options.setup?.(harness.projectDir);
		await harness.restart();
		const browser = await harness.connect();
		const sessionId = await browser.createSession(options.fixture);
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				projectSlug: "process-test",
				sessionId,
				providerId: "claude",
				modelId: options.modelId,
			}),
		);
		const cursor = browser.frames.length;
		const [firstPrompt, ...laterPrompts] = options.prompts;
		const commandIds = options.prompts.map(() => randomUUID());
		const target = { projectSlug: "process-test", sessionId };
		const submit = (
			text: string,
			commandId: string,
			delivery: "queue" | "steer",
		) =>
			browser.rpc.input
				.submit({
					...target,
					originId: browser.originId,
					inputId: commandId,
					delivery,
					text,
				})
				.pipe(Effect.timeout(240_000));
		// A steer is refused while a tool approval is still open, so retry until
		// the approval has landed and the provider takes it.
		const steer = <A extends { readonly ok: boolean }, E>(
			attempt: Effect.Effect<A, E>,
		) =>
			attempt.pipe(
				Effect.filterOrFail(
					(result) => result.ok,
					(result) => new Error(`steer refused: ${JSON.stringify(result)}`),
				),
				Effect.retry({ times: 50, schedule: Schedule.spaced("200 millis") }),
			);
		const sendLater = (text: string, commandId: string) =>
			Effect.runPromise(
				options.later === "steer"
					? steer(submit(text, commandId, "steer"))
					: options.later === "sendNow"
						? submit(text, commandId, "queue").pipe(
								Effect.zipRight(
									steer(
										browser.rpc.input.sendNow({
											...target,
											originId: browser.originId,
											inputId: commandId,
										}),
									),
								),
							)
						: submit(text, commandId, "queue"),
			);
		await Effect.runPromise(submit(firstPrompt, commandIds[0] ?? "", "queue"));
		const laterSends: Promise<unknown>[] = [];
		const answered = new Set<unknown>();
		await vi.waitFor(
			async () => {
				const frames = browser.frames.slice(cursor);
				for (const { message } of frames) {
					if (
						message["type"] !== "permission_request" ||
						answered.has(message["requestId"])
					)
						continue;
					answered.add(message["requestId"]);
					await browser.answerApproval(message, "allow");
				}
				if (
					laterSends.length < laterPrompts.length &&
					frames.some(
						({ message }) =>
							message["type"] === (options.sendLaterOn ?? "tool_executing"),
					)
				) {
					// Mid-turn: the first turn is running its tool, or replying.
					for (const [index, text] of laterPrompts.entries())
						laterSends.push(sendLater(text, commandIds[index + 1] ?? ""));
					const { stopAfterMs } = options;
					if (stopAfterMs !== undefined)
						laterSends.push(
							Promise.all(laterSends)
								.then(() => sleep(stopAfterMs))
								.then(() =>
									Effect.runPromise(
										browser.rpc.CancelSession({
											...target,
											commandId: randomUUID(),
										}),
									),
								),
						);
				}
				// One done per provider result, and Stop sends one of its own.
				expect(
					frames.filter(
						({ message }) =>
							message["type"] === "done" && message["sessionId"] === sessionId,
					),
				).toHaveLength(results + (options.stopAfterMs === undefined ? 0 : 1));
			},
			{ timeout: 240_000, interval: 100 },
		);
		await Promise.all(laterSends);
		const reply = browser.frames
			.slice(cursor)
			.filter(
				({ message }) =>
					message["type"] === "delta" && message["sessionId"] === sessionId,
			)
			.map(({ message }) => String(message["text"]))
			.join("");
		expect(reply).toContain(options.expectReply);

		const rawLines = readFileSync(
			join(captureDir, `${sessionId}.jsonl`),
			"utf8",
		)
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => redact(JSON.parse(line) as Raw));
		const trace = rawLines.map(decodeClaudeSDKMessage);
		// Each input went out with uuid = its commandId; the SDK names them back,
		// in send order, whether it folds them into one result or not.
		const lifecycle = trace.filter(
			(message): message is ClaudeSDKCommandLifecycleMessage =>
				message.type === "command_lifecycle",
		);
		for (const commandId of commandIds) {
			expect(
				lifecycle.filter(
					(message) =>
						message.command_uuid === commandId && message.state === "started",
				),
			).toHaveLength(1);
		}
		expect([
			...new Set(lifecycle.map((message) => message.command_uuid)),
		]).toEqual(commandIds);
		const resultFrames = trace.filter((message) => message.type === "result");
		expect(resultFrames).toHaveLength(results);
		expect(
			resultFrames.flatMap((message) => message.user_message_uuids ?? []),
		).toEqual(commandIds);
		writeFileSync(
			join(TRACES, `${options.fixture}.jsonl`),
			rawLines.map((line) => `${JSON.stringify(line)}\n`).join(""),
		);
	} finally {
		try {
			await harness.dispose();
		} finally {
			rmSync(captureDir, { recursive: true, force: true });
			expect(harness.remainingRunnerPids()).toEqual([]);
		}
	}
}

describe.skipIf(!RUN_EXPENSIVE)(
	"Claude replay trace capture (real SDK)",
	() => {
		it(
			"captures pong-thinking-text-turn",
			() =>
				capture({
					fixture: "pong-thinking-text-turn",
					modelId: "claude-fable-5",
					prompts: ["Hello, reply with just the word pong"],
					expectReply: "pong",
				}),
			{ timeout: 300_000 },
		);

		// The inbox queues the mid-turn send until the first turn ends, so the
		// SDK sees the second input only then: two results.
		it(
			"captures second-input-held-to-turn-end",
			() =>
				capture({
					fixture: "second-input-held-to-turn-end",
					modelId: "claude-fable-5",
					prompts: [
						"Use the Bash tool to run exactly `sleep 8; echo A-DONE`. After it finishes, reply with one short sentence that includes A-DONE.",
						"Now reply with just the word pong",
					],
					expectReply: "pong",
				}),
			{ timeout: 300_000 },
		);

		const toolTurn = (seconds: number) =>
			`Use the Bash tool to run exactly \`sleep ${seconds}; echo A-DONE\`. After it finishes, reply with one short sentence that includes A-DONE.`;

		// The steer lands at the tool boundary: one result answers both inputs.
		it(
			"captures steer-during-tool-folds",
			() =>
				capture({
					fixture: "steer-during-tool-folds",
					modelId: "claude-fable-5",
					prompts: [toolTurn(8), "Also: end your reply with the word BANANA."],
					later: "steer",
					results: 1,
					expectReply: "BANANA",
				}),
			{ timeout: 300_000 },
		);

		// A reply with no tool has no boundary to read the steer at, so the SDK
		// runs it as its own turn after the first: two results.
		it(
			"captures steer-misses-boundary",
			() =>
				capture({
					fixture: "steer-misses-boundary",
					modelId: "claude-fable-5",
					prompts: [
						"Without using any tools, write a 200-word story about a lighthouse keeper.",
						"Also: end your next reply with the word BANANA.",
					],
					sendLaterOn: "delta",
					later: "steer",
					expectReply: "BANANA",
				}),
			{ timeout: 300_000 },
		);

		it(
			"captures two-steers-one-boundary",
			() =>
				capture({
					fixture: "two-steers-one-boundary",
					modelId: "claude-fable-5",
					prompts: [
						toolTurn(8),
						"Also: include the word BANANA in your reply.",
						"Also: include the word CHERRY in your reply.",
					],
					later: "steer",
					results: 1,
					expectReply: "CHERRY",
				}),
			{ timeout: 300_000 },
		);

		// Stop interrupts the running turn; the SDK reports the steer still
		// queued and runs it as its own turn.
		it(
			"captures stop-with-steer-pending",
			() =>
				capture({
					fixture: "stop-with-steer-pending",
					modelId: "claude-fable-5",
					prompts: [
						toolTurn(15),
						"Also: end your next reply with the word BANANA.",
					],
					later: "steer",
					stopAfterMs: 1_000,
					expectReply: "BANANA",
				}),
			{ timeout: 300_000 },
		);

		it(
			"captures queued-input-promoted-to-steer",
			() =>
				capture({
					fixture: "queued-input-promoted-to-steer",
					modelId: "claude-fable-5",
					prompts: [toolTurn(8), "Also: end your reply with the word BANANA."],
					later: "sendNow",
					results: 1,
					expectReply: "BANANA",
				}),
			{ timeout: 300_000 },
		);

		it(
			"captures subagent-task-turn",
			() =>
				capture({
					fixture: "subagent-task-turn",
					modelId: "claude-sonnet-5",
					prompts: [
						"Use the Agent tool in the foreground (run_in_background false) to ask a subagent to read package.json and report its name field. Wait for its result, then reply starting with exactly 'The subagent reports' followed by what it found.",
					],
					expectReply: "The subagent reports",
					setup: (projectDir) => {
						mkdirSync(projectDir, { recursive: true });
						writeFileSync(
							join(projectDir, "package.json"),
							`${JSON.stringify({ name: "conduit-replay-fixture", private: true }, null, 2)}\n`,
						);
					},
				}),
			{ timeout: 300_000 },
		);
	},
);
