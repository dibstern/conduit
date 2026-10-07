/**
 * Re-capture the real Claude extra-folder Read trace with an existing login.
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-extra-folder-trace-capture.test.ts
 * Copies the captured session to extra-folder-read-turn.jsonl only after a
 * successful SDK result and a reply containing the marker. Review before committing.
 */
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
import { describe, expect, it } from "vitest";
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
					const response = await browser.send(
						sessionId,
						`Use the Read tool to read the file at the absolute path ${markerPath}, then reply with its contents.`,
						120_000,
					);
					const text = response.chunks.join("");
					evidence["text"] = text;
					expect(text).toContain(MARKER);
					expect(response.done["status"]).toBe("idle");
					const captured = join(captureDir, `${sessionId}.jsonl`);
					expect(existsSync(captured)).toBe(true);
					const trace = readFileSync(captured, "utf8")
						.split("\n")
						.filter((line) => line.trim() !== "")
						.map((line) => decodeClaudeSDKMessage(JSON.parse(line)));
					const results = trace.filter((message) => message.type === "result");
					expect(results).toHaveLength(1);
					expect(results[0]).toMatchObject({
						subtype: "success",
						is_error: false,
					});
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
