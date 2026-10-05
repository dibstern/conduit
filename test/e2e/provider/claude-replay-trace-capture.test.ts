/**
 * Re-capture the real Claude replay traces used by claude-replay.spec.ts with an
 * existing login.
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-replay-trace-capture.test.ts
 * Each capture is copied over its fixture only after every turn finished and the
 * trace shows the SDK echoing each sent input id, in send order. Review the
 * traces before committing them.
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
import { Effect } from "effect";
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
	/** Later prompts are sent once the first turn reports a tool running. */
	prompts: readonly [string, ...string[]];
	expectReply: string;
	setup?: (projectDir: string) => void;
}): Promise<void> {
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
		const send = (text: string, commandId: string) =>
			Effect.runPromise(
				browser.rpc.input
					.submit({
						projectSlug: "process-test",
						sessionId,
						originId: browser.originId,
						inputId: commandId,
						delivery: "queue",
						text,
					})
					.pipe(Effect.timeout(240_000)),
			);
		await send(firstPrompt, commandIds[0] ?? "");
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
					frames.some(({ message }) => message["type"] === "tool_executing")
				) {
					// Mid-turn: the first turn is running its tool.
					for (const [index, text] of laterPrompts.entries())
						laterSends.push(send(text, commandIds[index + 1] ?? ""));
				}
				expect(
					frames.filter(
						({ message }) =>
							message["type"] === "done" && message["sessionId"] === sessionId,
					),
				).toHaveLength(options.prompts.length);
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
				lifecycle
					.filter((message) => message.command_uuid === commandId)
					.map((message) => message.state),
			).toEqual(expect.arrayContaining(["started", "completed"]));
		}
		expect([
			...new Set(lifecycle.map((message) => message.command_uuid)),
		]).toEqual(commandIds);
		expect(
			trace.flatMap((message) =>
				message.type === "result" ? (message.user_message_uuids ?? []) : [],
			),
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

		// Conduit's turn admission gate holds the mid-turn send until the first
		// turn ends, so the SDK sees the second input only then: two results.
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
