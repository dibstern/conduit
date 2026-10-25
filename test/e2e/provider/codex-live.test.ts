// Opt in with CONDUIT_CODEX_LIVE=1 after `codex login`. The daemon and workspace
// are isolated; Codex reads the user's default login and runs read-only.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 180_000;

function storedEvents(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare<
				[string],
				{
					event_id: string;
					sequence: number;
					type: string;
					data: string;
					metadata: string;
					provider: string;
					created_at: number;
				}
			>(
				"SELECT event_id, sequence, type, data, metadata, provider, created_at FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(sessionId)
			.map(({ data, metadata, ...event }) => ({
				...event,
				data: JSON.parse(data) as Record<string, unknown>,
				metadata: JSON.parse(metadata) as Record<string, unknown>,
			}));
	} finally {
		db.close();
	}
}

describe.skipIf(process.env["CONDUIT_CODEX_LIVE"] !== "1")(
	"Codex live turn through the daemon",
	() => {
		it(
			"captures a real turn and the browser's stored events",
			{ timeout: 360_000 },
			async () => {
				const artifacts = resolve("test-results/codex-live");
				mkdirSync(artifacts, { recursive: true });
				const root = mkdtempSync(join(artifacts, "run-"));
				const capturePath = join(root, "app-server.jsonl");
				const modelId =
					process.env["CONDUIT_CODEX_LIVE_MODEL"] ?? "gpt-6.1-sol";
				const codexHome = process.env["CONDUIT_TEST_REAL_CODEX_HOME"];
				const evidence: Record<string, unknown> = {
					modelId,
					capturePath,
					completed: false,
				};
				let harness: ProcessHarness | undefined;
				let sessionId: string | undefined;
				try {
					harness = ProcessHarness.create({
						dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
					});
					const fixture = harness;
					await fixture.restart({
						startupTimeoutMs: TIMEOUT,
						runnerStartupTimeoutMs: TIMEOUT,
						serviceEnvironment: {
							CONDUIT_CODEX_APP_SERVER_TRACE: "",
							CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
							...(process.env["CONDUIT_CODEX_BINARY"]
								? { CONDUIT_CODEX_BINARY: process.env["CONDUIT_CODEX_BINARY"] }
								: {}),
						},
					});
					const { addedInstanceId } = await fixture.requestRpc({
						_tag: "AddInstance",
						name: "Codex default login smoke",
						driver: "codex",
						configDir: codexHome,
					});
					if (!addedInstanceId) throw new Error("Missing Codex account");
					const browser = await fixture.connect();
					const account = (await browser.instances()).instances.find(
						({ id }) => id === addedInstanceId,
					);
					evidence["account"] = account;
					expect(account).toMatchObject({ driver: "codex", available: true });
					const catalogCursor = browser.frames.length;
					await browser.getModels(addedInstanceId);
					const catalog = await browser.waitFor(
						(message) =>
							message["type"] === "project_setting" &&
							message["_tag"] === "providerModels" &&
							message["accountId"] === addedInstanceId,
						catalogCursor,
					);
					expect(
						(catalog["providers"] as ProviderInfo[]).flatMap(
							({ models }) => models,
						),
					).toContainEqual(expect.objectContaining({ id: modelId }));
					sessionId = await browser.createSession(
						"Codex live smoke",
						addedInstanceId,
						"codex",
						{ modelId, contextWindow: "", permissionMode: "ask" },
					);
					evidence["sessionId"] = sessionId;
					const reply = await browser.send(
						sessionId,
						"Do not call tools or create subagents. Think briefly about 17 times 19, then reply with exactly CODEX_LIVE_SMOKE_OK.",
						TIMEOUT,
					);
					expect(reply.chunks.join("")).toContain("CODEX_LIVE_SMOKE_OK");
					const id = sessionId;
					await vi.waitFor(
						() =>
							expect(
								storedEvents(fixture, id).some(
									({ type }) => type === "turn.completed",
								),
							).toBe(true),
						{ timeout: TIMEOUT },
					);
					const events = storedEvents(fixture, id);
					expect(
						events.filter(({ type }) => type === "turn.error"),
					).toHaveLength(0);
					expect(
						events.filter(({ type }) => type === "text.delta").length,
					).toBeGreaterThan(0);
					const capture = readFileSync(capturePath, "utf8");
					expect(capture).toContain('"method":"turn/start"');
					expect(capture).toContain('"method":"turn/completed"');
					evidence["completed"] = true;
				} catch (error) {
					evidence["failure"] =
						error instanceof Error ? error.message : String(error);
					throw error;
				} finally {
					if (harness && sessionId)
						writeFileSync(
							join(root, "events.json"),
							`${JSON.stringify(storedEvents(harness, sessionId), null, 2)}\n`,
						);
					if (harness) {
						const logPath = join(harness.configDir, "runners.log");
						if (existsSync(logPath))
							writeFileSync(join(root, "runners.log"), readFileSync(logPath));
						await harness.dispose();
						evidence["process"] = harness.proof();
						expect(harness.remainingRunnerPids()).toEqual([]);
					}
					writeFileSync(
						join(root, "evidence.json"),
						`${JSON.stringify(evidence, null, 2)}\n`,
					);
				}
			},
		);
	},
);
