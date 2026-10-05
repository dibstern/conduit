/**
 * Re-capture the real Claude replay traces used by claude-replay.spec.ts with an
 * existing login.
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-replay-trace-capture.test.ts
 * Each capture is copied over its fixture only after the turn finished and the
 * trace shows the SDK echoing the sent input id. Review the traces before
 * committing them.
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
	prompt: string;
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
		const commandId = randomUUID();
		await Effect.runPromise(
			browser.rpc
				.SendMessage({
					projectSlug: "process-test",
					sessionId,
					originId: browser.originId,
					commandId,
					text: options.prompt,
				})
				.pipe(Effect.timeout(15_000)),
		);
		const answered = new Set<unknown>();
		await vi.waitFor(
			async () => {
				for (const { message } of browser.frames.slice(cursor)) {
					if (
						message["type"] !== "permission_request" ||
						answered.has(message["requestId"])
					)
						continue;
					answered.add(message["requestId"]);
					await browser.answerApproval(message, "allow");
				}
				expect(
					browser.frames
						.slice(cursor)
						.some(
							({ message }) =>
								message["type"] === "done" &&
								message["sessionId"] === sessionId,
						),
				).toBe(true);
			},
			{ timeout: 240_000, interval: 100 },
		);
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
		// The input went out with uuid = commandId; the SDK names it back.
		const lifecycle = trace.filter(
			(message): message is ClaudeSDKCommandLifecycleMessage =>
				message.type === "command_lifecycle",
		);
		expect(lifecycle.map((message) => message.state)).toEqual(
			expect.arrayContaining(["started", "completed"]),
		);
		expect(
			lifecycle.every((message) => message.command_uuid === commandId),
		).toBe(true);
		expect(trace.find((message) => message.type === "result")).toMatchObject({
			user_message_uuids: [commandId],
		});
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
					prompt: "Hello, reply with just the word pong",
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
					prompt:
						"Use the Agent tool in the foreground (run_in_background false) to ask a subagent to read package.json and report its name field. Wait for its result, then reply starting with exactly 'The subagent reports' followed by what it found.",
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
