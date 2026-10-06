/**
 * Re-capture a real Claude Side Thread's first turn: a whole-session fork that
 * then answers in plan mode, with an existing login.
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-side-thread-trace-capture.test.ts
 * Copies the Side Thread's trace to side-thread-plan-turn.jsonl only after the
 * answer recalls the parent's word and the SDK reports plan mode. Hook output
 * and home paths are redacted; review the trace before committing it.
 */
import { randomUUID } from "node:crypto";
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
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import { isRecord } from "../../../src/lib/utils.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const PARENT_PROMPT =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const QUESTION =
	"What word did I ask you to remember? Reply with only the word.";

describe.skipIf(!RUN_EXPENSIVE)(
	"Claude Side Thread trace capture (real SDK)",
	() => {
		it(
			"captures a forked Side Thread's first turn in plan mode",
			async () => {
				const fixturePath = join(
					import.meta.dirname,
					"../../fixtures/claude-sdk-traces/side-thread-plan-turn.jsonl",
				);
				const captureDir = mkdtempSync(
					join(tmpdir(), "conduit-side-thread-capture-"),
				);
				const harness = ProcessHarness.create({
					dist: "dist",
					realSdk: true,
					claudeCaptureDir: captureDir,
				});
				const evidence: Record<string, unknown> = {
					ticket: "conduit-test-8sq4.4",
					at: new Date().toISOString(),
					fixturePath,
					captured: false,
				};
				try {
					await harness.restart();
					const browser = await harness.connect();
					const send = async (sessionId: string, text: string) => {
						const cursor = browser.frames.length;
						await Effect.runPromise(
							browser.rpc
								.SendMessage({
									projectSlug: "process-test",
									sessionId,
									originId: browser.originId,
									commandId: randomUUID(),
									text,
								})
								.pipe(Effect.timeout(15_000)),
						);
						await vi.waitFor(
							() =>
								expect(
									browser.frames
										.slice(cursor)
										.some(
											({ message }) =>
												message["type"] === "done" &&
												message["sessionId"] === sessionId,
										),
								).toBe(true),
							{ timeout: 120_000, interval: 50 },
						);
						return browser.frames
							.slice(cursor)
							.filter(
								({ message }) =>
									message["sessionId"] === sessionId &&
									message["type"] === "delta",
							)
							.map(({ message }) => String(message["text"]))
							.join("");
					};

					const parentId = await browser.createSession("Side Thread capture");
					evidence["parentId"] = parentId;
					evidence["parentText"] = await send(parentId, PARENT_PROMPT);
					// The SDK resume cursor commits just after the turn ends.
					const { sessionId: sideId } = await vi.waitFor(
						() =>
							Effect.runPromise(
								browser.rpc.StartSideThread({
									projectSlug: "process-test",
									parentSessionId: parentId,
									title: QUESTION,
								}),
							),
						{ timeout: 15_000, interval: 250 },
					);
					evidence["sideId"] = sideId;
					await browser.view(sideId);
					const text = await send(sideId, QUESTION);
					evidence["sideText"] = text;
					expect(text.toLowerCase()).toContain("alpha");

					const captured = join(captureDir, `${sideId}.jsonl`);
					expect(existsSync(captured)).toBe(true);
					const lines = readFileSync(captured, "utf8")
						.split("\n")
						.filter((line) => line.trim() !== "");
					const trace = lines.map((line) =>
						decodeClaudeSDKMessage(JSON.parse(line)),
					);
					const init = trace.find(
						(message) =>
							message.type === "system" && message.subtype === "init",
					);
					expect(init).toMatchObject({ permissionMode: "plan" });
					const models = trace.flatMap((message) =>
						message.type === "assistant" ? [message.message.model] : [],
					);
					evidence["models"] = [...new Set(models)];
					expect(models.length).toBeGreaterThan(0);
					expect(models.some((model) => /haiku/i.test(model))).toBe(false);

					const redacted = lines.map((line) => {
						const message: unknown = JSON.parse(line);
						if (isRecord(message) && message["subtype"] === "hook_response") {
							for (const key of ["output", "stdout", "stderr"]) {
								if (message[key] !== "")
									message[key] = "[redacted: local hook output]";
							}
						}
						return JSON.stringify(message)
							.replaceAll(homedir(), "/home/test")
							.replace(
								/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
								"redacted@example.test",
							);
					});
					writeFileSync(fixturePath, `${redacted.join("\n")}\n`);
					evidence["captured"] = true;
				} finally {
					try {
						await harness.dispose();
					} finally {
						rmSync(captureDir, { recursive: true, force: true });
						evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
						mkdirSync("test-results", { recursive: true });
						writeFileSync(
							"test-results/8sq4-4-side-thread-trace-capture.json",
							JSON.stringify(evidence, null, 2),
						);
						expect(harness.remainingRunnerPids()).toEqual([]);
					}
				}
			},
			{ timeout: 300_000 },
		);
	},
);
