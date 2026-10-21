import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DrainReport,
	EventRetentionTag,
} from "../../../src/lib/domain/persistence/Services/event-retention.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { refreshSidebar } from "../../../src/lib/persistence/effect/sidebar-projection.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { verifyReplayParity } from "../../../src/lib/persistence/replay-parity.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { ProjectShellEnvResolver } from "../../../src/lib/provider/project-shell-env.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

const DAY = 86_400_000;
const emptyReport: DrainReport = {
	sessionsFreed: 0,
	eventsFreed: 0,
	bytesFreed: 0,
	held: [],
	orphans: [],
	pointerKept: 0,
};

interface EventRow {
	sequence: number;
	event_id: string;
	session_id: string;
	type: string;
	data: string;
}

// Failure modes: the sweep destroys history or markers, live forks veto logical
// deletion, a deleted middle fork loses its Source hold, or a child's reclaimed
// approval leaves an ancestor's read annotation looking like replay corruption.
describe("archived event retention through the relay", () => {
	let harness: RelayHarness | undefined;
	let db: Database.Database | undefined;
	let directory: string;
	const evidence: Record<string, Record<string, unknown>> = {};

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "conduit-archived-retention-"));
		mkdirSync(join(directory, "home"));
		mkdirSync(join(directory, "login"));
		vi.stubEnv("HOME", join(directory, "home"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(directory, "login"));
		vi.stubEnv("CONDUIT_CONFIG_DIR", directory);
		vi.spyOn(ProjectShellEnvResolver.prototype, "register").mockImplementation(
			() => {},
		);
		vi.spyOn(
			ProjectShellEnvResolver.prototype,
			"waitUntilReady",
		).mockResolvedValue(true);
		__setProbeOverrideForTesting(async () => ({
			models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
			commands: [],
			agents: [],
		}));
	});

	afterEach(async () => {
		try {
			db?.close();
			await harness?.stop();
		} finally {
			db = undefined;
			harness = undefined;
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			__setProbeOverrideForTesting(undefined);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/hiuf-12-archived-event-retention.json",
				`${JSON.stringify({ tickets: ["conduit-test-hiuf.12", "conduit-test-hiuf.15"], scenarios: evidence }, null, 2)}\n`,
			);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	async function setup(name: string) {
		const scenario: Record<string, unknown> = {};
		evidence[name] = scenario;
		const relay = await createRelayHarness("chat-simple", {
			configDir: directory,
			defaultModel: null,
			claudeSdk,
		});
		harness = relay;
		const database = new Database(relay.eventsDbPath, { readonly: true });
		db = database;
		const runtime = relay.stack.effectRuntime.runtime;
		const retention = await runtime.runPromise(EventRetentionTag);
		const originalDrain = retention.drain;
		// Separate sweep and drain observations. Automatic kicks are covered by
		// event-retention-scheduling.integration.ts and the daemon sweep test.
		const scheduledDrains = vi
			.spyOn(retention, "drain")
			.mockImplementation(() => Effect.succeed(emptyReport));
		const commit = await runtime.runPromise(makeCommitAndSignal);
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const root = String(
			(
				await client.createSession("Archived Source", {
					instanceId: "claude",
					model: {
						providerId: "claude",
						modelId: "sonnet",
						variant: "",
						contextWindow: "",
					},
				})
			)["id"],
		);
		const events = () =>
			database
				.prepare<[], EventRow>(
					"SELECT sequence, event_id, session_id, type, data FROM events ORDER BY sequence",
				)
				.all();
		const transcript = (sessionId: string) => ({
			messages: database
				.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
				.all(sessionId),
			parts: database
				.prepare(
					"SELECT p.* FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? ORDER BY p.id",
				)
				.all(sessionId),
			resultEvents: database
				.prepare(
					"SELECT DISTINCT e.* FROM events e JOIN message_parts p ON p.result_event_seq = e.sequence JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? ORDER BY e.sequence",
				)
				.all(sessionId),
		});
		const addTranscript = async (sessionId: string) => {
			const messageId = randomUUID();
			const userMessageId = randomUUID();
			await runtime.runPromise(
				commit([
					canonicalEvent("message.created", sessionId, {
						sessionId,
						messageId: userMessageId,
						role: "user",
					}),
					canonicalEvent("message.created", sessionId, {
						sessionId,
						messageId,
						parentID: userMessageId,
						role: "assistant",
					}),
					canonicalEvent("text.delta", sessionId, {
						messageId,
						partId: `text_${messageId}`,
						text: "Retained answer",
					}),
					canonicalEvent("tool.started", sessionId, {
						messageId,
						partId: `tool_${messageId}`,
						callId: `call_${messageId}`,
						toolName: "Read",
						input: { tool: "Read", filePath: "/fixture" },
					}),
					canonicalEvent("tool.completed", sessionId, {
						messageId,
						partId: `tool_${messageId}`,
						// Large results live in the event log behind result_event_seq.
						result: "Retained tool result ".repeat(1200),
						duration: 1,
					}),
					canonicalEvent("turn.completed", sessionId, { messageId }),
				]),
			);
		};
		const child = async (parentId: string) => {
			const sessionId = `child_${randomUUID()}`;
			await runtime.runPromise(
				commit([
					canonicalEvent("session.created", sessionId, {
						sessionId,
						parentId,
						provider: "claude",
						title: "Child",
					}),
				]),
			);
			return sessionId;
		};
		const archive = () =>
			runtime.runPromise(
				commit([
					canonicalEvent(
						"session.archived",
						root,
						{ sessionId: root, automatic: false },
						{ createdAt: Date.now() - 31 * DAY },
					),
				]),
			);
		const sweepAndDrain = async (removedIds: string[]) => {
			const beforeSweep = events();
			const scheduledBefore = scheduledDrains.mock.calls.length;
			scenario["eventsBeforeSweep"] = beforeSweep;
			// The daemon invokes this effect outside the project's runtime.
			const sweepResult = await Effect.runPromise(
				relay.stack.deleteArchivedSessions(30 * DAY, Date.now()),
			);
			const afterSweep = events();
			scenario["sweepResult"] = sweepResult;
			scenario["eventsAfterSweep"] = afterSweep;
			expect(sweepResult).toBe(removedIds.length === 0 ? 0 : 1);
			const beforeSequences = new Set(beforeSweep.map((row) => row.sequence));
			expect(
				afterSweep.filter((row) => beforeSequences.has(row.sequence)),
			).toEqual(beforeSweep);
			const appended = afterSweep.filter(
				(row) => !beforeSequences.has(row.sequence),
			);
			expect(appended).toHaveLength(removedIds.length);
			for (const sessionId of removedIds) {
				expect(
					database
						.prepare("SELECT id FROM sessions WHERE id = ?")
						.get(sessionId),
				).toBeUndefined();
				expect(appended).toContainEqual(
					expect.objectContaining({
						session_id: sessionId,
						type: "session.deleted",
					}),
				);
			}
			if (removedIds.length > 0)
				await vi.waitFor(
					() =>
						expect(scheduledDrains.mock.calls.length).toBeGreaterThan(
							scheduledBefore,
						),
					{ timeout: 5000 },
				);
			scenario["scheduledDrains"] =
				scheduledDrains.mock.calls.length - scheduledBefore;
			const drainReport = await runtime.runPromise(originalDrain());
			const afterDrain = events();
			const parity = await relay.checkReplayParity();
			scenario["drainReport"] = drainReport;
			scenario["eventsAfterDrain"] = afterDrain;
			scenario["parity"] = parity;
			expect(drainReport.eventsFreed).toBe(
				afterSweep.length - afterDrain.length,
			);
			expect(drainReport.eventsFreed).toBeGreaterThan(0);
			expect(drainReport.pointerKept).toBe(0);
			expect(drainReport.orphans).toEqual([]);
			for (const marker of afterSweep.filter(
				(row) => row.type === "session.deleted",
			))
				expect(afterDrain).toContainEqual(marker);
			expect(parity.diffs).toEqual([]);
			expect(parity.danglingPartPointers).toEqual([]);
			return { drainReport, afterDrain };
		};
		return {
			relay,
			database,
			runtime,
			commit,
			client,
			root,
			scenario,
			events,
			transcript,
			addTranscript,
			child,
			archive,
			sweepAndDrain,
		};
	}

	it("(a) sweeps an expired archived tree without deleting events, then drains to markers", async () => {
		const flow = await setup("a/expired-tree");
		const child = await flow.child(flow.root);
		const grandchild = await flow.child(child);
		await flow.addTranscript(flow.root);
		await flow.addTranscript(grandchild);
		await flow.archive();
		const { drainReport, afterDrain } = await flow.sweepAndDrain([
			flow.root,
			child,
			grandchild,
		]);
		expect(drainReport.sessionsFreed).toBe(3);
		expect(drainReport.held).toEqual([]);
		expect(
			afterDrain.filter((row) =>
				[flow.root, child, grandchild].includes(row.session_id),
			),
		).toHaveLength(3);
	});

	it.each([
		false,
		true,
	])("keeps the transcript and result events of a surviving fork, deleted middle = %s", async (deletedMiddle) => {
		const flow = await setup(
			deletedMiddle ? "c/deleted-middle-fork" : "b/surviving-fork",
		);
		await flow.addTranscript(flow.root);
		let source = flow.root;
		if (deletedMiddle) {
			source = String(
				(await flow.client.forkSession({ sessionId: source }))["id"],
			);
			await flow.addTranscript(source);
		}
		const fork = String(
			(await flow.client.forkSession({ sessionId: source }))["id"],
		);
		// Match the existing retention fixture's replay baseline for per-viewer
		// read state, which is outside the log under ADR-0004.
		await flow.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql.withTransaction(
					Effect.gen(function* () {
						const rows = yield* sql<{ id: string; version: number }>`
							UPDATE sessions SET seen_version = NULL RETURNING id, version`;
						yield* refreshSidebar(
							rows.map((row) => row.id),
							Math.max(0, ...rows.map((row) => row.version)),
						);
					}),
				);
			}),
		);
		await flow.client.renameSession(fork, "Surviving fork");
		if (deletedMiddle) {
			await flow.client.renameSession(source, "Middle fork");
			await flow.client.deleteSession(source);
		}
		const before = flow.transcript(fork);
		expect(before.messages.length).toBeGreaterThan(0);
		expect(before.parts.length).toBeGreaterThan(0);
		expect(before.resultEvents).toHaveLength(deletedMiddle ? 2 : 1);
		flow.scenario["transcriptBefore"] = before;
		await flow.addTranscript(flow.root);
		await flow.archive();
		const { drainReport } = await flow.sweepAndDrain([flow.root]);
		const after = flow.transcript(fork);
		flow.scenario["transcriptAfter"] = after;
		expect(after).toEqual(before);
		expect(drainReport.held.map((held) => held.sessionId)).toContain(flow.root);
		if (deletedMiddle)
			expect(drainReport.held.map((held) => held.sessionId)).toContain(source);
	});

	it("(d) treats ancestor wake state from a reclaimed child's approval as a read annotation", async () => {
		const flow = await setup("d/ancestor-wake-annotation");
		const child = await flow.child(flow.root);
		const snoozedAt = Date.now() - 1000;
		const wokenAt = snoozedAt + 1;
		await flow.runtime.runPromise(
			flow.commit([
				canonicalEvent(
					"session.snoozed",
					flow.root,
					{
						sessionId: flow.root,
						until: null,
					},
					{ createdAt: snoozedAt },
				),
				canonicalEvent(
					"permission.asked",
					child,
					{
						id: randomUUID(),
						sessionId: child,
						toolName: "Read",
						input: { filePath: "/fixture" },
					},
					{ createdAt: wokenAt },
				),
			]),
		);
		const wake = () =>
			flow.database
				.prepare(
					"SELECT snoozed_at, woken_at, woken_reason FROM sessions WHERE id = ?",
				)
				.get(flow.root);
		expect(wake()).toEqual({
			snoozed_at: snoozedAt,
			woken_at: wokenAt,
			woken_reason: "approval",
		});
		flow.scenario["wakeBeforeDelete"] = wake();
		await flow.client.deleteSession(child);
		await flow.sweepAndDrain([]);
		expect(wake()).toEqual({
			snoozed_at: snoozedAt,
			woken_at: wokenAt,
			woken_reason: "approval",
		});
		flow.scenario["wakeAfterDrain"] = wake();
		expect(
			flow
				.events()
				.filter((row) => row.session_id === child)
				.map((row) => row.type),
		).toEqual(["session.deleted"]);
		const strict = await Effect.runPromise(
			verifyReplayParity(flow.relay.eventsDbPath, {
				projectId: "integration-test",
				ignoredColumns: [
					"version",
					"session_sidebar.row.version",
					"sessions.history_complete",
				],
			}),
		);
		flow.scenario["parityWithoutWakeIgnores"] = strict;
		expect(
			strict.diffs.some(
				(diff) => diff.table === "sessions" && diff.fields.includes("woken_at"),
			),
		).toBe(true);
		expect(
			strict.diffs.some(
				(diff) =>
					diff.table === "session_sidebar" && diff.fields.includes("row"),
			),
		).toBe(true);
	});
});
