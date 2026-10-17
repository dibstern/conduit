/**
 * Paid smoke through an isolated daemon and real detached Cursor runners.
 * CURSOR_API_KEY must already be explicitly supplied in the environment.
 *
 * export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
 * RUN_CURSOR_LIVE_SMOKE=1 CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run \
 *   --config vitest.e2e.config.ts test/e2e/provider/cursor-fork-live-sdk.test.ts
 */
// Failure modes: recall guessed from the new prompt, source-agent reuse, source
// event mutation, hidden context rendered as an input, leaked API credentials,
// and detached runners surviving cleanup.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
	AddInstance,
	ForkSessionForSession,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	cursorSessionStorePath,
	readCursorSessionIdentity,
} from "../../../src/lib/provider/cursor/cursor-session-recovery.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_SMOKE =
	process.env["RUN_CURSOR_LIVE_SMOKE"] === "1" &&
	Boolean(process.env["CURSOR_API_KEY"]?.trim());
const TIMEOUT = 180_000;

function sourceEvents(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare<
				[string],
				{
					event_id: string;
					sequence: number;
					stream_version: number;
					type: string;
					data: string;
					metadata: string;
					provider: string;
					created_at: number;
				}
			>(
				"SELECT event_id, sequence, stream_version, type, data, metadata, provider, created_at FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(sessionId);
	} finally {
		db.close();
	}
}

describe.skipIf(!RUN_SMOKE)("Cursor fork recall through the real SDK", () => {
	it(
		"recalls a source-only marker in a fresh fork and leaves the source unchanged",
		{ timeout: 900_000 },
		async () => {
			const apiKey = process.env["CURSOR_API_KEY"]?.trim();
			if (!apiKey)
				throw new Error("The smoke requires an explicit CURSOR_API_KEY");
			const marker = `CURSOR_FORK_${randomUUID()}`;
			const capturePath = resolve(
				`test-results/conduit-test-xqsg.14-live-${randomUUID()}.jsonl`,
			);
			const evidence = {
				ticket: "conduit-test-xqsg.14",
				at: new Date().toISOString(),
				model: "composer-2.5",
				capturePath,
				marker,
				sourceSessionId: "",
				forkSessionId: "",
				sourceAgentId: "",
				forkAgentId: "",
				recallPrompt:
					"What exact verification marker did I ask you to remember in the prior conversation? Reply with only that marker. Do not call tools or create subagents.",
				recalledText: "",
				invariants: {
					markerAbsentFromNewPrompt: false,
					markerRecalled: false,
					separateSessionAndStore: false,
					freshAgentCreated: false,
					sourceEventsUnchanged: false,
					noHiddenInput: false,
					credentialAbsentFromCapture: false,
					noRemainingRunner: false,
				},
				completed: false,
				serverPid: null as number | null,
				runnerPids: [] as number[],
				remainingRunnerPids: [] as number[],
				failure: null as string | null,
			};
			let harness: ProcessHarness | undefined;
			try {
				harness = ProcessHarness.create({
					dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				});
				const fixture = harness;
				await harness.restart({
					startupTimeoutMs: TIMEOUT,
					runnerStartupTimeoutMs: TIMEOUT,
					serviceEnvironment: {
						CURSOR_API_KEY: apiKey,
						CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
					},
				});
				evidence.serverPid = harness.generations[0]?.pid ?? null;
				const { addedInstanceId } = await harness.requestRpc(
					new AddInstance({ name: "Cursor fork live smoke", driver: "cursor" }),
				);
				if (!addedInstanceId) throw new Error("Missing Cursor account");
				const browser = await harness.connect();
				const sourceId = await browser.createSession(
					"Cursor source marker",
					addedInstanceId,
					"cursor",
					{
						modelId: evidence.model,
						contextWindow: "",
						permissionMode: "full",
					},
				);
				evidence.sourceSessionId = sourceId;
				const sourcePrompt = `Remember this exact verification marker for later: ${marker}. Reply with only SAVED. Do not call tools or create subagents.`;
				const sourceReply = await browser.send(sourceId, sourcePrompt, TIMEOUT);
				expect(sourceReply.done["status"]).toBe("idle");
				await vi.waitFor(
					() =>
						expect(
							sourceEvents(fixture, sourceId).some(
								({ type }) => type === "input.sent",
							),
						).toBe(true),
					{ timeout: TIMEOUT },
				);
				const before = sourceEvents(harness, sourceId);
				const sourceIdentity = readCursorSessionIdentity(
					harness.configDir,
					sourceId,
				);
				if (!sourceIdentity) throw new Error("Missing source agent identity");
				evidence.sourceAgentId = sourceIdentity.agentId;
				const { sessionId: forkId } = await harness.requestRpc(
					new ForkSessionForSession({
						originId: browser.originId,
						sessionId: sourceId,
					}),
				);
				evidence.forkSessionId = forkId;
				expect(forkId).not.toBe(sourceId);
				expect(evidence.recallPrompt).not.toContain(marker);
				evidence.invariants.markerAbsentFromNewPrompt = true;
				const recall = await browser.send(
					forkId,
					evidence.recallPrompt,
					TIMEOUT,
				);
				evidence.recalledText = recall.chunks.join("");
				expect(recall.done["status"]).toBe("idle");
				expect(evidence.recalledText).toContain(marker);
				evidence.invariants.markerRecalled = true;
				const forkIdentity = readCursorSessionIdentity(
					harness.configDir,
					forkId,
				);
				if (!forkIdentity) throw new Error("Missing fork agent identity");
				evidence.forkAgentId = forkIdentity.agentId;
				expect(forkIdentity.agentId).not.toBe(sourceIdentity.agentId);
				evidence.invariants.freshAgentCreated = true;
				const sourceStore = cursorSessionStorePath(harness.configDir, sourceId);
				const forkStore = cursorSessionStorePath(harness.configDir, forkId);
				expect(forkStore).not.toBe(sourceStore);
				expect(existsSync(join(sourceStore, "session.json"))).toBe(true);
				expect(existsSync(join(forkStore, "session.json"))).toBe(true);
				evidence.invariants.separateSessionAndStore = true;
				expect(sourceEvents(harness, sourceId)).toEqual(before);
				evidence.invariants.sourceEventsUnchanged = true;
				const userMessages = (await browser.history(forkId)).filter(
					({ role }) => role === "user",
				);
				expect(userMessages.map(({ text }) => text)).toEqual([
					sourcePrompt,
					evidence.recallPrompt,
				]);
				evidence.invariants.noHiddenInput = true;
				const capture = readFileSync(capturePath, "utf8");
				expect(capture).not.toContain(apiKey);
				evidence.invariants.credentialAbsentFromCapture = true;
				const trace = capture
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { kind?: string; data?: unknown });
				expect(
					trace.filter(({ kind }) => kind === "create.options"),
				).toHaveLength(2);
				expect(
					trace
						.filter(({ kind }) => kind === "resume.options")
						.some(({ data }) =>
							JSON.stringify(data).includes(sourceIdentity.agentId),
						),
				).toBe(false);
				evidence.runnerPids = harness.runnerPids();
				expect(evidence.runnerPids).toHaveLength(2);
				expect(evidence.runnerPids).not.toContain(evidence.serverPid);
				evidence.completed = true;
			} catch (error) {
				evidence.failure = String(error).split(apiKey).join("[REDACTED]");
				throw error;
			} finally {
				try {
					await harness?.dispose();
				} finally {
					evidence.remainingRunnerPids = harness?.remainingRunnerPids() ?? [];
					evidence.invariants.noRemainingRunner =
						evidence.remainingRunnerPids.length === 0;
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						"test-results/conduit-test-xqsg.14-live.json",
						`${JSON.stringify(evidence, null, 2)}\n`,
					);
					expect(evidence.remainingRunnerPids).toEqual([]);
					if (existsSync(capturePath))
						expect(readFileSync(capturePath, "utf8")).not.toContain(apiKey);
				}
			}
		},
	);
});
