/**
 * Re-capture the real Claude extra-folder Read trace with an existing login.
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-extra-folder-trace-capture.test.ts
 * Copies the captured session to extra-folder-read-turn.jsonl only after the
 * reply contains the marker. Review the trace before committing it.
 */
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
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
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import { SaveProject } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { isRecord } from "../../../src/lib/utils.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const MARKER = "CONDUIT-EXTRA-FOLDER-MARKER-7f3a";

describe.skipIf(!RUN_EXPENSIVE)(
	"Claude extra-folder trace capture (real SDK)",
	() => {
		it(
			"captures a Read tool turn from a project's extra folder",
			async () => {
				const fixturePath = join(
					import.meta.dirname,
					"../../fixtures/claude-sdk-traces/extra-folder-read-turn.jsonl",
				);
				const captureDir = mkdtempSync(
					join(tmpdir(), "conduit-extra-folder-capture-"),
				);
				const harness = ProcessHarness.create({
					dist: "dist",
					realSdk: true,
					claudeCaptureDir: captureDir,
				});
				const extra = join(harness.root, "extra-folder");
				const markerPath = join(extra, "marker.txt");
				const evidence: Record<string, unknown> = {
					ticket: "conduit-test-usg5.6",
					at: new Date().toISOString(),
					fixturePath,
					main: harness.projectDir,
					extra,
					captureDir,
					captured: false,
				};
				try {
					mkdirSync(extra);
					writeFileSync(markerPath, MARKER);
					await harness.restart();
					const saved = await sendRpcRequest(
						join(harness.configDir, "relay.sock"),
						new SaveProject({
							slug: "process-test",
							folders: [harness.projectDir, extra],
						}),
					);
					evidence["save"] = saved;
					expect(saved.warnings).toEqual([]);
					const browser = await harness.connect();
					const sessionId = await browser.createSession(
						"Extra-folder Read capture",
					);
					evidence["sessionId"] = sessionId;
					const cursor = browser.frames.length;
					await Effect.runPromise(
						browser.rpc.input
							.submit({
								projectSlug: "process-test",
								sessionId,
								originId: browser.originId,
								inputId: randomUUID(),
								delivery: "queue",
								text: `Use the Read tool to read the file at the absolute path ${markerPath}, then reply with its contents.`,
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
					const messages = browser.frames
						.slice(cursor)
						.filter(({ message }) => message["sessionId"] === sessionId)
						.map(({ message }) => message);
					const text = messages
						.filter((message) => message["type"] === "delta")
						.map((message) => String(message["text"]))
						.join("");
					evidence["text"] = text;
					expect(text).toContain(MARKER);
					expect(
						messages.find((message) => message["type"] === "done"),
					).toMatchObject({
						code: 0,
					});
					const captured = join(captureDir, `${sessionId}.jsonl`);
					expect(existsSync(captured)).toBe(true);
					const trace = readFileSync(captured, "utf8")
						.split("\n")
						.filter((line) => line.trim() !== "")
						.map((line) => decodeClaudeSDKMessage(JSON.parse(line)));
					expect(
						trace.some(
							(message) =>
								message.type === "assistant" &&
								message.message.content.some(
									(block) =>
										block.type === "tool_use" &&
										block.name === "Read" &&
										isRecord(block.input) &&
										block.input["file_path"] === markerPath,
								),
						),
					).toBe(true);
					copyFileSync(captured, fixturePath);
					evidence["captured"] = true;
				} finally {
					try {
						await harness.dispose();
					} finally {
						rmSync(captureDir, { recursive: true, force: true });
						evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
						mkdirSync("test-results", { recursive: true });
						writeFileSync(
							"test-results/usg5-6-trace-capture.json",
							JSON.stringify(evidence, null, 2),
						);
						expect(harness.remainingRunnerPids()).toEqual([]);
					}
				}
			},
			{ timeout: 150_000 },
		);
	},
);
