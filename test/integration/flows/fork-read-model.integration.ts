import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { EventRetentionSchedulerTag } from "../../../src/lib/domain/persistence/Services/event-retention-scheduler.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { ProviderRuntimeIngestionTag } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { OrchestrationEngineTag } from "../../../src/lib/domain/relay/Services/services.js";
import {
	applySessionCommand,
	forkSession,
} from "../../../src/lib/domain/relay/Services/session-command.js";
import { readSessionWorktreeOwnership } from "../../../src/lib/domain/relay/Services/session-worktree-deletion.js";
import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { verifyReplayParity } from "../../../src/lib/persistence/replay-parity.js";
import { PREVIEW_CODE_POINTS } from "../../../src/lib/persistence/tool-wire-projection.js";
import { readWorktreeCleanupPaths } from "../../../src/lib/session/worktree-cleanup-sweep.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

const NOW = 1_800_000_000_000;
const goldenPath = new URL("./fork-read-model.golden.json", import.meta.url);

// Read markers are viewer annotations (ADR-0004), not replayable events.
// Keep every event-derived content, model, usage and tool-result field checked.
const checkParity = (harness: RelayHarness) =>
	Effect.runPromise(
		verifyReplayParity(harness.eventsDbPath, {
			projectId: "integration-test",
			ignoredColumns: [
				"version",
				"session_sidebar.row.version",
				"sessions.history_complete",
				"sessions.seen_version",
				"sessions.unread",
				"session_sidebar.row.session.unread",
				"session_sidebar.row.session.attention",
			],
		}),
	);

/** Fake provider output still enters the relay's production ingestion seam. */
async function emit(harness: RelayHarness, events: readonly CanonicalEvent[]) {
	await harness.stack.effectRuntime.runtime.runPromise(
		Effect.gen(function* () {
			const ingestion = yield* Effect.serviceOption(
				ProviderRuntimeIngestionTag,
			);
			if (ingestion._tag === "None")
				throw new Error("Relay ingestion unavailable");
			const commit = yield* makeCommitAndSignal;
			let pending: ProviderRuntimeEvent[] = [];
			for (const event of events) {
				if (event.type === "run.requested") {
					if (pending.length) yield* ingestion.value.ingestBatch(pending);
					pending = [];
					yield* commit([event]);
					continue;
				}
				pending.push({
					eventId: event.eventId,
					type: event.type,
					providerId: "claude",
					sessionId: event.sessionId,
					providerRefs: {},
					rawSource: { kind: "fork-golden-fixture" },
					createdAt: event.createdAt,
					data: event.data,
					metadata: event.metadata,
					...(event.metadata.runId ? { runId: event.metadata.runId } : {}),
				} as ProviderRuntimeEvent);
			}
			if (pending.length) yield* ingestion.value.ingestBatch(pending);
		}),
	);
}

function turn(sessionId: string, n: number, finished = true): CanonicalEvent[] {
	const user = `turn-${n}-user`;
	const reply = `turn-${n}-assistant`;
	const runId = `turn-${n}-run`;
	const timestamp = NOW - 1000 + n * 100;
	const event = <T extends CanonicalEvent["type"]>(
		type: T,
		data: Parameters<typeof canonicalEvent<T>>[2],
		offset = 0,
	) =>
		canonicalEvent(type, sessionId, data, {
			provider: "claude",
			createdAt: timestamp + offset,
			metadata: { runId },
		});
	return [
		event("run.requested", { runId, inputId: `input-${n}` }),
		event("message.created", {
			sessionId,
			messageId: user,
			role: "user",
			inputId: `input-${n}`,
		}),
		event("text.delta", {
			messageId: user,
			partId: `${user}-text`,
			text: `Question ${n}`,
		}),
		event("session.status", { sessionId, status: "busy" }, 1),
		event("run.started", { inputId: `input-${n}`, requestedRunId: runId }, 2),
		event(
			"message.created",
			{ sessionId, messageId: reply, role: "assistant", parentID: user },
			2,
		),
		event(
			"turn.model_resolved",
			{
				messageId: reply,
				requestedModel: "sonnet",
				expectedModel: "sonnet",
				actualModel: "claude-sonnet-4-6",
			},
			2,
		),
		event(
			"thinking.start",
			{ messageId: reply, partId: `${reply}-thinking` },
			3,
		),
		event(
			"thinking.delta",
			{ messageId: reply, partId: `${reply}-thinking`, text: "Think " },
			3,
		),
		event(
			"thinking.delta",
			{ messageId: reply, partId: `${reply}-thinking`, text: `about ${n}` },
			3,
		),
		event("thinking.end", { messageId: reply, partId: `${reply}-thinking` }, 4),
		event(
			"text.delta",
			{ messageId: reply, partId: `${reply}-text`, text: "Answer " },
			5,
		),
		event(
			"text.delta",
			{ messageId: reply, partId: `${reply}-text`, text: String(n) },
			5,
		),
		event(
			"tool.started",
			{
				messageId: reply,
				partId: `${reply}-tool`,
				callId: `call-${n}`,
				toolName: "Read",
				input: {
					tool: "Unknown",
					name: "Read",
					raw: { file_path: "/tmp/example.ts" },
				},
			},
			6,
		),
		event(
			"tool.running",
			{ messageId: reply, partId: `${reply}-tool`, metadata: { progress: 1 } },
			7,
		),
		event("tool.running", { messageId: reply, partId: `${reply}-tool` }, 8),
		...(finished
			? [
					event(
						"tool.completed",
						{
							messageId: reply,
							partId: `${reply}-tool`,
							result: `file output ${n}`,
							duration: 12,
							metadata: { lines: 3 },
						},
						9,
					),
					event(
						"file.attached",
						{
							messageId: reply,
							partId: `${reply}-file`,
							mime: "text/plain",
							filename: "example.txt",
							source: { url: "file:///tmp/example.txt" },
						},
						10,
					),
					...(n === 1
						? [
								event(
									"session.compaction",
									{
										sessionId,
										state: "completed",
										detail: "Compacted history",
										preTokens: 12000,
										postTokens: 3200,
									},
									11,
								),
							]
						: []),
					event(
						"turn.completed",
						{
							messageId: reply,
							cost: 0.02,
							duration: 15,
							contextTokens: 3400,
							tokens: {
								input: 3000,
								output: 50,
								cacheRead: 200,
								cacheWrite: 100,
								contextWindow: 200000,
							},
						},
						12,
					),
					event("session.status", { sessionId, status: "idle" }, 13),
				]
			: []),
	];
}

function dump(harness: RelayHarness, sessionId: string, sourceId: string) {
	const db = new Database(harness.eventsDbPath, { readonly: true });
	try {
		const rows = {
			sessions: db
				.prepare("SELECT * FROM sessions WHERE id = ?")
				.all(sessionId),
			turns: db
				.prepare(
					"SELECT * FROM turns WHERE session_id = ? ORDER BY requested_at, id",
				)
				.all(sessionId),
			messages: db
				.prepare(
					"SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id",
				)
				.all(sessionId),
			message_parts: db
				.prepare(
					"SELECT p.* FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? ORDER BY m.created_at, m.id, p.sort_order, p.id",
				)
				.all(sessionId),
		};
		// Generated compaction/error ids encode event sequence numbers too. Keep
		// their relationships, but discard the event identity just like *_seq.
		return JSON.parse(
			JSON.stringify(rows, (key, value: unknown) => {
				if (
					key === "version" ||
					key.endsWith("_seq") ||
					key.endsWith("_event_id") ||
					key.endsWith("_version") ||
					key === "rest_digest" ||
					key === "rest_payload"
				)
					return undefined;
				return typeof value === "string"
					? value
							.replaceAll(sessionId, "FORK")
							.replaceAll(sourceId, "SOURCE")
							.replace(
								/(compaction(?:-part)?|turn-error(?:-part)?)-\d+(?:_FORK)?/g,
								"$1-EVENT",
							)
					: value;
			}),
		) as unknown;
	} finally {
		db.close();
	}
}

describe("Fork read-model inheritance", () => {
	let harness: RelayHarness | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.stop();
		harness = undefined;
	});

	it.each([
		"current",
		"pre-snapshot",
	] as const)("retains each deleted descendant's own worktree ownership after marker-only drain (%s)", async (storage) => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const runtime = harness.stack.effectRuntime.runtime;
		const rootId = "ownership-root";
		const childId = "ownership-child";
		const rootOwnership = {
			folder: process.cwd(),
			path: `${process.cwd()}/.conduit-test-root`,
			branchName: "conduit/root",
			head: "a".repeat(40),
		};
		const childOwnership = {
			...rootOwnership,
			path: `${process.cwd()}/.conduit-test-child`,
			branchName: "conduit/child",
			head: "b".repeat(40),
		};
		await runtime.runPromise(
			applySessionCommand(
				{
					type: "session.created",
					data: { sessionId: rootId, title: "Owner", provider: "claude" },
				},
				{
					pick: {
						harness: "claude",
						model: { providerId: "claude", modelId: "sonnet" },
						effort: "",
						contextWindow: "200k",
					},
				},
			),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* applySessionCommand({
					type: "session.created",
					data: {
						sessionId: childId,
						parentId: rootId,
						title: "Independent owner",
						provider: "claude",
					},
				});
				for (const [sessionId, owned] of [
					[rootId, rootOwnership],
					[childId, childOwnership],
				] as const)
					yield* applySessionCommand({
						type: "session.workspace_changed",
						data: {
							sessionId,
							cause: "launch",
							origin: "conduit",
							worktrees: { [owned.folder]: owned.path },
							ownership: [owned],
						},
					});
			}),
		);
		await emit(harness, turn(rootId, 1));
		const inherited = await runtime.runPromise(
			forkSession(rootId, {
				side: { title: "Inherited checkout", inputId: "ownership-side" },
			}),
		);
		const renamed = { ...rootOwnership, branchName: "conduit/renamed-root" };
		await runtime.runPromise(
			applySessionCommand({
				type: "session.workspace_changed",
				data: {
					sessionId: rootId,
					cause: "branch-rename",
					origin: "conduit",
					worktrees: { [renamed.folder]: renamed.path },
					ownership: [renamed],
				},
			}),
		);
		// Prove the real fixture supplies inspection and canonical ownership before deletion.
		expect(
			await runtime.runPromise(readSessionWorktreeOwnership(rootId)),
		).toEqual([renamed]);
		expect(
			await runtime.runPromise(readSessionWorktreeOwnership(childId)),
		).toEqual([childOwnership]);
		expect(
			await runtime.runPromise(readSessionWorktreeOwnership(inherited.id)),
		).toEqual([]);
		await runtime.runPromise(
			applySessionCommand({
				type: "session.deleted",
				data: { sessionId: rootId },
			}).pipe(
				Effect.provideService(EventRetentionSchedulerTag, {
					kick: Effect.void,
				}),
			),
		);
		if (storage === "pre-snapshot") {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`UPDATE events SET data = json_remove(data, '$.worktreeOwnership')
					WHERE project_id = 'integration-test' AND session_id IN (${rootId}, ${childId}, ${inherited.id})
						AND type = 'session.deleted'
						AND json_extract(data, '$.sessionId') = session_id`;
				}),
			);
			const db = new Database(harness.eventsDbPath, { readonly: true });
			try {
				expect(
					db
						.prepare(`SELECT session_id, json_type(data, '$.worktreeOwnership') AS snapshot
					FROM events WHERE type = 'session.deleted' ORDER BY session_id`)
						.all(),
				).toEqual(
					[rootId, childId, inherited.id]
						.sort()
						.map((session_id) => ({ session_id, snapshot: null })),
				);
				expect(
					db
						.prepare(`SELECT session_id, json_extract(data, '$.cause') AS cause
							FROM events WHERE type = 'session.workspace_changed'
								AND session_id IN (?, ?) ORDER BY sequence`)
						.all(rootId, childId),
				).toEqual([
					{ session_id: rootId, cause: "launch" },
					{ session_id: childId, cause: "launch" },
					{ session_id: rootId, cause: "branch-rename" },
				]);
			} finally {
				db.close();
			}
			expect(
				await runtime.runPromise(readSessionWorktreeOwnership(rootId)),
			).toEqual([renamed]);
			expect(
				await runtime.runPromise(readSessionWorktreeOwnership(childId)),
			).toEqual([childOwnership]);
			expect(
				await runtime.runPromise(readSessionWorktreeOwnership(inherited.id)),
			).toEqual([]);
		}
		await harness.drainEventRetention();
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			const ids = [rootId, childId, inherited.id].sort();
			expect(
				db.prepare("SELECT id FROM sessions WHERE id IN (?, ?, ?)").all(...ids),
			).toEqual([]);
			expect(
				db
					.prepare(
						"SELECT session_id, type, json_extract(data, '$.sessionId') AS own_id FROM events WHERE session_id IN (?, ?, ?) ORDER BY session_id",
					)
					.all(...ids),
			).toEqual(
				ids.map((id) => ({
					session_id: id,
					type: "session.deleted",
					own_id: id,
				})),
			);
		} finally {
			db.close();
		}
		expect(
			await runtime.runPromise(readSessionWorktreeOwnership(rootId)),
		).toEqual([renamed]);
		expect(
			await runtime.runPromise(readSessionWorktreeOwnership(childId)),
		).toEqual([childOwnership]);
		expect(
			await runtime.runPromise(readSessionWorktreeOwnership(inherited.id)),
		).toEqual([]);
	});

	// Discovery must retain known paths without reviving older ownership authority.
	it.each(
		(["malformed", "conflict", "empty", "null"] as const).flatMap((state) =>
			[false, true].map((legacy) => ({ state, legacy })),
		),
	)("keeps historical deletion-marker paths without authorizing older ownership ($state, legacy=$legacy)", async ({
		state,
		legacy,
	}) => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const runtime = harness.stack.effectRuntime.runtime;
		const sessionId = `ownership-${state}`;
		const owned = {
			folder: process.cwd(),
			path: `${process.cwd()}/.conduit-test-${state}`,
			branchName: "conduit/old-owner",
			head: "a".repeat(40),
		};
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* applySessionCommand({
					type: "session.created",
					data: { sessionId, title: "Owner", provider: "claude" },
				});
				yield* applySessionCommand({
					type: "session.workspace_changed",
					data: {
						sessionId,
						cause: "launch",
						origin: "conduit",
						worktrees: { [owned.folder]: owned.path },
						ownership: [owned],
					},
				});
				yield* applySessionCommand({
					type: "session.deleted",
					data: { sessionId },
				});
			}).pipe(
				Effect.provideService(EventRetentionSchedulerTag, {
					kick: Effect.void,
				}),
			),
		);
		if (!legacy) await harness.drainEventRetention();
		expect(
			await runtime.runPromise(readSessionWorktreeOwnership(sessionId)),
		).toEqual([owned]);
		const worktreeOwnership =
			state === "malformed"
				? { _tag: "Owned", ownership: "invalid" }
				: state === "conflict"
					? { _tag: "Conflict", reason: "launch", discoveryPaths: [] }
					: state === "null"
						? null
						: { _tag: "Owned", ownership: [], discoveryPaths: [] };
		const newerData = JSON.stringify({ sessionId, worktreeOwnership });
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql.withTransaction(
					Effect.gen(function* () {
						if (legacy)
							yield* sql`UPDATE events SET data = json_remove(data, '$.worktreeOwnership')
						WHERE project_id = 'integration-test' AND session_id = ${sessionId}
							AND type = 'session.deleted' AND json_extract(data, '$.sessionId') = session_id`;
						yield* sql`INSERT INTO events
					(event_id, session_id, stream_version, type, data, metadata, provider, created_at, project_id)
					SELECT event_id || '-newer', session_id, stream_version + 1, type, ${newerData}, metadata, provider, created_at + 1, project_id
					FROM events WHERE session_id = ${sessionId} AND type = 'session.deleted'`;
					}),
				);
			}),
		);
		await harness.drainEventRetention();
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT data FROM events WHERE session_id = ? AND event_id LIKE '%-newer'",
					)
					.all(sessionId),
			).toEqual([{ data: newerData }]);
			expect(
				db
					.prepare("SELECT type FROM events WHERE session_id = ?")
					.all(sessionId),
			).toEqual([{ type: "session.deleted" }, { type: "session.deleted" }]);
		} finally {
			db.close();
		}
		const inspection = await runtime.runPromise(
			Effect.result(readSessionWorktreeOwnership(sessionId)),
		);
		expect(inspection).toMatchObject(
			state === "empty"
				? { _tag: "Success", success: [] }
				: { _tag: "Failure", failure: { operation: "worktree.inspect" } },
		);
		expect(
			await runtime.runPromise(
				readWorktreeCleanupPaths.pipe(
					Effect.provideService(PersistenceProjectTag, {
						projectId: "integration-test",
					}),
				),
			),
		).toContainEqual({
			session_id: sessionId,
			path: owned.path,
		});
	});

	// Failure cases: missing rich parts, inclusion of a removed turn, a cut
	// leaking future messages, lost model/context state, or a busy Side Thread.
	it("matches the old replay rows at latest, earlier and mid-turn Side Thread cuts", async () => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const created = await client.createSession("Rich Source", {
			providerId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sourceId = String(created["id"]);
		await emit(harness, [...turn(sourceId, 1), ...turn(sourceId, 2)]);
		await client.rpcCall((rpc) =>
			rpc.RewindSession({ sessionId: sourceId, messageId: "turn-2-user" }),
		);
		await emit(harness, [
			canonicalEvent(
				"message.removed",
				sourceId,
				{ messageId: "turn-2-user" },
				{ provider: "claude", createdAt: NOW - 750 },
			),
		]);
		await emit(harness, [...turn(sourceId, 3), ...turn(sourceId, 4, false)]);
		// Refresh the Source's sidebar after batched fake output. These real
		// commands do not enter inherited history, and leave its title unchanged.
		await client.renameSession(sourceId, "Rich Source refreshed");
		await client.renameSession(sourceId, "Rich Source");
		const latest = await client.forkSession({ sessionId: sourceId });
		const earlier = await client.forkSession({
			sessionId: sourceId,
			messageId: "turn-1-assistant",
		});
		const side = await harness.stack.effectRuntime.runtime.runPromise(
			forkSession(sourceId, {
				side: { title: "Mid-turn", inputId: "side-input" },
			}),
		);
		const actual = {
			latest: dump(harness, String(latest["id"]), sourceId),
			earlier: dump(harness, String(earlier["id"]), sourceId),
			side: dump(harness, side.id, sourceId),
		};
		if (process.env["UPDATE_FORK_GOLDEN"] === "1")
			writeFileSync(goldenPath, `${JSON.stringify(actual, null, "\t")}\n`);
		expect(actual).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
		const latestId = String(latest["id"]);
		// RPC optional fields include undefined in their types; the JSON wire
		// omits those keys, matching the renderer's HistoryMessage contract.
		const rendered = historyToChatMessages([
			...(await client.loadMoreHistory(latestId)).messages,
		] as HistoryMessage[]);
		expect(
			splitAtForkPoint(rendered, "turn-4-assistant", NOW - 598, latestId)
				.current,
		).toEqual([]);
		const report = await checkParity(harness);
		expect(report.diffs).toEqual([]);
		expect(report.danglingPartPointers).toEqual([]);
	});

	// Failure cases: a missing/hidden cut sneaks through, a pending rewind
	// leaks hidden rows, or a Side Thread inherits the unfinished first turn.
	it("rejects hidden cuts and unfinished Side Threads and respects pending rewind", async () => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const runtime = harness.stack.effectRuntime.runtime;
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Pending", {
			providerId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sourceId = String(created["id"]);
		await emit(harness, [...turn(sourceId, 1), ...turn(sourceId, 2)]);
		const userCut = await runtime.runPromise(
			forkSession(sourceId, { messageId: "turn-1-user" }),
		);
		const cutDb = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				cutDb
					.prepare(
						"SELECT state, assistant_message_id, started_at, cost, tokens_in, actual_model FROM turns WHERE session_id = ?",
					)
					.all(userCut.id),
			).toEqual([
				{
					state: "completed",
					assistant_message_id: null,
					started_at: null,
					cost: null,
					tokens_in: null,
					actual_model: null,
				},
			]);
			expect(
				cutDb
					.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
					.get(userCut.id),
			).toEqual({ n: 1 });
		} finally {
			cutDb.close();
		}
		await client.rpcCall((rpc) =>
			rpc.RewindSession({ sessionId: sourceId, messageId: "turn-2-user" }),
		);
		await expect(
			client.forkSession({
				sessionId: sourceId,
				messageId: "turn-2-assistant",
			}),
		).rejects.toThrow(/not found/);
		await expect(
			client.forkSession({ sessionId: sourceId, messageId: "missing" }),
		).rejects.toThrow(/not found/);
		const fork = await runtime.runPromise(forkSession(sourceId));
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT id FROM messages WHERE session_id = ? ORDER BY created_at, id",
					)
					.all(fork.id),
			).toEqual([
				{ id: `turn-1-user_${fork.id}` },
				{ id: `turn-1-assistant_${fork.id}` },
			]);
		} finally {
			db.close();
		}
		await client.rpcCall((rpc) =>
			rpc.RewindSession({ sessionId: sourceId, messageId: "turn-2-assistant" }),
		);
		const visibleSide = await runtime.runPromise(
			forkSession(sourceId, {
				side: { title: "Visible completed turn", inputId: "visible-side" },
			}),
		);
		expect(visibleSide.forkMessageId).toBe("turn-1-assistant");
		const unfinished = await client.createSession("Unfinished", {
			providerId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const unfinishedId = String(unfinished["id"]);
		await expect(
			runtime.runPromise(
				forkSession(unfinishedId, {
					side: { title: "Empty", inputId: "empty-side" },
				}),
			),
		).rejects.toThrow(
			"This session has no messages yet. Send a message first.",
		);
		await runtime.runPromise(
			applySessionCommand(
				{
					type: "session.created",
					data: {
						sessionId: "result-only-source",
						title: "Result only",
						provider: "claude",
					},
				},
				{
					pick: {
						harness: "claude",
						model: { providerId: "claude", modelId: "sonnet" },
						effort: "",
						contextWindow: "200k",
					},
				},
			),
		);
		await emit(harness, [
			canonicalEvent(
				"run.requested",
				"result-only-source",
				{ runId: "result-only-run", inputId: "result-only-user" },
				{
					provider: "claude",
					createdAt: NOW - 20,
					metadata: { runId: "result-only-run" },
				},
			),
			canonicalEvent(
				"message.created",
				"result-only-source",
				{
					sessionId: "result-only-source",
					messageId: "result-only-user",
					role: "user",
				},
				{
					provider: "claude",
					createdAt: NOW - 20,
					metadata: { runId: "result-only-run" },
				},
			),
			canonicalEvent(
				"turn.completed",
				"result-only-source",
				{ messageId: "result-only-user", userMessageId: "result-only-user" },
				{
					provider: "claude",
					createdAt: NOW - 10,
					metadata: { runId: "result-only-run" },
				},
			),
		]);
		const resultOnly = await runtime.runPromise(
			forkSession("result-only-source", {
				side: { title: "Result side", inputId: "result-only-side" },
			}),
		);
		expect(resultOnly.forkMessageId).toBe("result-only-user");
		await emit(harness, turn(unfinishedId, 5, false));
		await expect(
			runtime.runPromise(
				forkSession(unfinishedId, {
					side: { title: "Unfinished", inputId: "unfinished-side" },
				}),
			),
		).rejects.toThrow("Wait for this session's first reply to finish.");
	});

	// Remove the point at the native-receipt lookup, which follows the command's
	// preflight read but precedes its append transaction. The command must read
	// the point again under the same transaction that creates the child.
	it("rejects a cut removed between preflight and the append transaction", async () => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const runtime = harness.stack.effectRuntime.runtime;
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Racing cut", {
			providerId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sourceId = String(created["id"]);
		await emit(harness, turn(sourceId, 1));
		let removed = false;
		await expect(
			runtime.runPromise(
				Effect.gen(function* () {
					const commit = yield* makeCommitAndSignal;
					return yield* forkSession(sourceId, {
						messageId: "turn-1-assistant",
					}).pipe(
						Effect.provideService(Statement.CurrentTransformer, (statement) => {
							if (
								!removed &&
								/FROM provider_state\b/i.test(statement.compile()[0])
							) {
								removed = true;
								return commit([
									canonicalEvent(
										"message.removed",
										sourceId,
										{ messageId: "turn-1-assistant" },
										{ provider: "claude" },
									),
								]).pipe(Effect.orDie, Effect.as(statement));
							}
							return Effect.succeed(statement);
						}),
					);
				}),
			),
		).rejects.toThrow(/not found/);
		expect(removed).toBe(true);
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare("SELECT id FROM sessions WHERE forked_from = ?")
					.all(sourceId),
			).toEqual([]);
		} finally {
			db.close();
		}
	});

	// Historical logs contain their own inherited events. Absence of the flag
	// must leave creation alone even when the Source and cut are available.
	it("replays legacy fork events once and can fork inherited read-model messages", async () => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const runtime = harness.stack.effectRuntime.runtime;
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Legacy Source", {
			providerId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sourceId = String(created["id"]);
		await emit(harness, [...turn(sourceId, 1), ...turn(sourceId, 2)]);
		await emit(harness, [
			canonicalEvent(
				"tool.completed",
				sourceId,
				{
					messageId: "turn-1-assistant",
					partId: "turn-1-assistant-tool",
					result: "full output ".repeat(PREVIEW_CODE_POINTS),
					duration: 20,
				},
				{ provider: "claude", createdAt: NOW - 880 },
			),
		]);
		const legacyId = "legacy-fork";
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* applySessionCommand({
					type: "session.created",
					data: {
						sessionId: legacyId,
						title: "Legacy",
						provider: "claude",
						forkedFrom: sourceId,
						forkPointTimestamp: NOW - 898,
						forkPointMessageId: "turn-1-assistant",
					},
				});
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"message.created",
						legacyId,
						{ sessionId: legacyId, messageId: "legacy-user", role: "user" },
						{
							provider: "claude",
							createdAt: NOW - 900,
							metadata: { inherited: true },
						},
					),
					canonicalEvent(
						"message.created",
						legacyId,
						{
							sessionId: legacyId,
							messageId: "legacy-assistant",
							role: "assistant",
						},
						{
							provider: "claude",
							createdAt: NOW - 898,
							metadata: { inherited: true },
						},
					),
					canonicalEvent(
						"text.delta",
						legacyId,
						{
							messageId: "legacy-assistant",
							partId: "legacy-text",
							text: "Copied once",
						},
						{
							provider: "claude",
							createdAt: NOW - 897,
							metadata: { inherited: true },
						},
					),
					canonicalEvent(
						"turn.completed",
						legacyId,
						{ messageId: "legacy-assistant" },
						{
							provider: "claude",
							createdAt: NOW - 896,
							metadata: { inherited: true },
						},
					),
				]);
			}),
		);
		const first = await runtime.runPromise(forkSession(sourceId));
		const second = await runtime.runPromise(
			forkSession(first.id, { messageId: `turn-1-assistant_${first.id}` }),
		);
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY id")
					.all(legacyId),
			).toEqual([{ id: "legacy-assistant" }, { id: "legacy-user" }]);
			expect(
				db
					.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
					.get(second.id),
			).toEqual({ n: 2 });
			const pointer = db
				.prepare(
					"SELECT p.result_event_seq AS inherited, s.result_event_seq AS source FROM message_parts p JOIN message_parts s ON s.id = 'turn-1-assistant-tool' WHERE p.id = ?",
				)
				.get(`turn-1-assistant-tool_${first.id}`);
			expect(pointer).toEqual(
				expect.objectContaining({
					inherited: expect.any(Number),
					source: expect.any(Number),
				}),
			);
			const values = pointer as { inherited: number; source: number };
			expect(values.inherited).toBe(values.source);
		} finally {
			db.close();
		}
		const report = await checkParity(harness);
		expect(report.diffs).toEqual([]);
		expect(report.danglingPartPointers).toEqual([]);
	});

	// A continuation retries the same input with a fresh run. Its display owner
	// changes to the new reply, while an earlier cut must keep the old owner.
	it.each([
		true,
		false,
	])("preserves a reopened turn's display reply and bounds its earlier cut (keyed model: %s)", async (keyed) => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const runtime = harness.stack.effectRuntime.runtime;
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Reopened turn", {
			providerId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sourceId = String(created["id"]);
		await emit(
			harness,
			turn(sourceId, 6).map((event) =>
				event.type === "turn.model_resolved" && !keyed
					? canonicalEvent(
							"turn.model_resolved",
							sourceId,
							{
								requestedModel: "sonnet",
								expectedModel: "sonnet",
								actualModel: "claude-sonnet-4-6",
							},
							{
								provider: "claude",
								createdAt: event.createdAt,
								metadata: event.metadata,
							},
						)
					: event,
			),
		);
		const continuation = { runId: "continued-run" };
		await emit(harness, [
			canonicalEvent(
				"run.requested",
				sourceId,
				{ runId: continuation.runId, inputId: "input-6" },
				{ provider: "claude", createdAt: NOW - 301 },
			),
			canonicalEvent(
				"message.created",
				sourceId,
				{
					sessionId: sourceId,
					messageId: "turn-6-user",
					role: "user",
					inputId: "input-6",
				},
				{ provider: "claude", createdAt: NOW - 301, metadata: continuation },
			),
			canonicalEvent(
				"run.started",
				sourceId,
				{ inputId: "input-6", requestedRunId: continuation.runId },
				{ provider: "claude", createdAt: NOW - 300, metadata: continuation },
			),
			canonicalEvent(
				"message.created",
				sourceId,
				{
					sessionId: sourceId,
					messageId: "continued-reply",
					role: "assistant",
					parentID: "turn-6-user",
				},
				{ provider: "claude", createdAt: NOW - 300, metadata: continuation },
			),
			canonicalEvent(
				"turn.model_resolved",
				sourceId,
				{
					...(keyed ? { messageId: "continued-reply" } : {}),
					actualModel: "later-model",
				},
				{ provider: "claude", createdAt: NOW - 300, metadata: continuation },
			),
			canonicalEvent(
				"text.delta",
				sourceId,
				{
					messageId: "continued-reply",
					partId: "continued-text",
					text: "More work",
				},
				{ provider: "claude", createdAt: NOW - 299, metadata: continuation },
			),
			canonicalEvent(
				"turn.completed",
				sourceId,
				{
					messageId: "continued-reply",
					cost: 0.03,
					tokens: { input: 100, output: 20 },
				},
				{ provider: "claude", createdAt: NOW - 298, metadata: continuation },
			),
		]);
		const latest = await runtime.runPromise(forkSession(sourceId));
		const earlier = await runtime.runPromise(
			forkSession(sourceId, { messageId: "turn-6-assistant" }),
		);
		const nested = await runtime.runPromise(
			forkSession(latest.id, { messageId: `turn-6-assistant_${latest.id}` }),
		);
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT assistant_message_id, actual_model FROM turns WHERE session_id = ?",
					)
					.get(latest.id),
			).toEqual({
				assistant_message_id: `continued-reply_${latest.id}`,
				actual_model: "later-model",
			});
			expect(
				db
					.prepare(
						"SELECT assistant_message_id, cost, tokens_in, tokens_out, actual_model FROM turns WHERE session_id = ?",
					)
					.get(earlier.id),
			).toEqual({
				assistant_message_id: `turn-6-assistant_${earlier.id}`,
				cost: 0.02,
				tokens_in: 3000,
				tokens_out: 50,
				actual_model: "claude-sonnet-4-6",
			});
			expect(
				db
					.prepare("SELECT actual_model FROM turns WHERE session_id = ?")
					.get(nested.id),
			).toEqual({ actual_model: "claude-sonnet-4-6" });
		} finally {
			db.close();
		}
	});

	it("keeps a turn error's synthetic message when cutting at its owning reply", async () => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Errored turn", {
			providerId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sourceId = String(created["id"]);
		await emit(harness, turn(sourceId, 7, false));
		await emit(harness, [
			canonicalEvent(
				"turn.error",
				sourceId,
				{
					messageId: "turn-7-assistant",
					error: "Permission denied",
					code: "DENIED",
				},
				{
					provider: "claude",
					createdAt: NOW - 200,
					metadata: { runId: "turn-7-run" },
				},
			),
		]);
		const fork = await harness.stack.effectRuntime.runtime.runPromise(
			forkSession(sourceId, { messageId: "turn-7-assistant" }),
		);
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT p.text, p.metadata FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? AND p.type = 'error'",
					)
					.all(fork.id),
			).toEqual([
				{
					text: "Permission denied",
					metadata: JSON.stringify({ code: "DENIED" }),
				},
			]);
			expect(
				db.prepare("SELECT state FROM turns WHERE session_id = ?").all(fork.id),
			).toEqual([{ state: "error" }]);
		} finally {
			db.close();
		}
	});

	it("renders copied prefix-related ids on the inherited side of a tied Source cut", async () => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Tied ordering", {
			providerId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sourceId = String(created["id"]);
		await emit(
			harness,
			["a", "a0", "a1"].flatMap((id, index) => [
				canonicalEvent(
					"message.created",
					sourceId,
					{
						sessionId: sourceId,
						messageId: id,
						role: index === 0 ? "user" : "assistant",
					},
					{ provider: "claude", createdAt: NOW - 100 },
				),
				canonicalEvent(
					"text.delta",
					sourceId,
					{ messageId: id, partId: `${id}-text`, text: id },
					{ provider: "claude", createdAt: NOW - 100 },
				),
			]),
		);
		const fork = await harness.stack.effectRuntime.runtime.runPromise(
			forkSession(sourceId, { messageId: "a0" }),
		);
		const rendered = historyToChatMessages([
			...(await client.loadMoreHistory(fork.id)).messages,
		] as HistoryMessage[]);
		expect(rendered).toHaveLength(2);
		expect(
			splitAtForkPoint(rendered, "a0", NOW - 100, fork.id).inherited,
		).toEqual(rendered);
		expect(
			splitAtForkPoint(rendered, `a0_${fork.id}`, NOW - 100, fork.id).inherited,
		).toEqual(rendered);
	});

	it("forks a Cursor source without appending copied events or saving a digest early", async () => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		await harness.stack.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				const sourceId = "cursor-digest-source";
				yield* applySessionCommand(
					{
						type: "session.created",
						data: {
							sessionId: sourceId,
							title: "Cursor Source",
							provider: "cursor",
						},
					},
					{
						pick: {
							harness: "cursor",
							model: { providerId: "cursor", modelId: "composer-2.5" },
							effort: "",
							contextWindow: "",
						},
					},
				);
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"run.requested",
						sourceId,
						{ runId: "cursor-run", inputId: "cursor-user" },
						{
							provider: "cursor",
							createdAt: NOW - 100,
							metadata: { runId: "cursor-run" },
						},
					),
					canonicalEvent(
						"message.created",
						sourceId,
						{ sessionId: sourceId, messageId: "cursor-user", role: "user" },
						{
							provider: "cursor",
							createdAt: NOW - 100,
							metadata: { runId: "cursor-run" },
						},
					),
					canonicalEvent(
						"text.delta",
						sourceId,
						{
							messageId: "cursor-user",
							partId: "cursor-user-text",
							text: "Remember the blue marker",
						},
						{
							provider: "cursor",
							createdAt: NOW - 100,
							metadata: { runId: "cursor-run" },
						},
					),
					canonicalEvent(
						"run.started",
						sourceId,
						{ inputId: "cursor-user", requestedRunId: "cursor-run" },
						{
							provider: "cursor",
							createdAt: NOW - 90,
							metadata: { runId: "cursor-run" },
						},
					),
					canonicalEvent(
						"message.created",
						sourceId,
						{
							sessionId: sourceId,
							messageId: "cursor-reply",
							role: "assistant",
							parentID: "cursor-user",
						},
						{
							provider: "cursor",
							createdAt: NOW - 90,
							metadata: { runId: "cursor-run" },
						},
					),
					canonicalEvent(
						"text.delta",
						sourceId,
						{
							messageId: "cursor-reply",
							partId: "cursor-reply-text",
							text: "The marker is blue",
						},
						{
							provider: "cursor",
							createdAt: NOW - 90,
							metadata: { runId: "cursor-run" },
						},
					),
					canonicalEvent(
						"turn.completed",
						sourceId,
						{ messageId: "cursor-reply" },
						{
							provider: "cursor",
							createdAt: NOW - 80,
							metadata: { runId: "cursor-run" },
						},
					),
				]);
				const fork = yield* forkSession(sourceId);
				const sql = yield* SqlClient.SqlClient;
				// The first turn builds the digest from the inherited rows
				// (cursor-fork-flow.test.ts); forking saves none.
				expect(
					yield* sql`SELECT value FROM provider_state WHERE session_id = ${fork.id} AND key = 'cursor.forkDigest'`,
				).toEqual([]);
				expect(
					yield* sql`SELECT type FROM events WHERE session_id = ${fork.id} AND type IN ('message.created', 'text.delta')`,
				).toEqual([]);
				expect(
					(yield* sql<{
						fork_point_message_id: string;
					}>`SELECT fork_point_message_id FROM sessions WHERE id = ${fork.id}`)[0]
						?.fork_point_message_id,
				).toBe("cursor-reply");
			}).pipe(
				Effect.provideService(
					AccountDirectory,
					makeMockAccountDirectory([
						{
							driver: "cursor",
							id: AccountIdSchema.make("cursor"),
							name: "Cursor",
							usageEligible: false,
						},
					]),
				),
				Effect.provideService(
					OrchestrationEngineTag,
					withDispatchEffect({
						dispatchEffect: () =>
							Effect.succeed({
								models: [
									{
										id: "composer-2.5",
										name: "Composer",
										providerId: "cursor",
										variants: {},
										contextWindowOptions: [{ value: "", label: "Default" }],
									},
								],
							}),
					}),
				),
			),
		);
	});

	// Statement count must be independent of history size, including the
	// projection and all command bookkeeping. SQL instrumentation counts the
	// actual statements executed by this command's fiber in the relay runtime.
	it("creates N and 10N message forks with equal statement counts", async () => {
		harness = await createRelayHarness("chat-simple", { claudeSdk });
		const runtime = harness.stack.effectRuntime.runtime;
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const measurements = [];
		for (const messages of [20, 200]) {
			const created = await client.createSession(`Cost ${messages}`, {
				providerId: "claude",
				model: {
					providerId: "claude",
					modelId: "sonnet",
					variant: "",
					contextWindow: "200k",
				},
			});
			const sourceId = String(created["id"]);
			const events = Array.from({ length: messages / 2 }, (_, n) => {
				const user = `${messages}-${String(n).padStart(4, "0")}-user`;
				const assistant = `${messages}-${String(n).padStart(4, "0")}-assistant`;
				const createdAt = NOW - 10_000 + n * 10;
				return [
					canonicalEvent(
						"run.requested",
						sourceId,
						{ runId: `${user}-run`, inputId: user },
						{
							provider: "claude",
							createdAt,
							metadata: { runId: `${user}-run` },
						},
					),
					canonicalEvent(
						"message.created",
						sourceId,
						{ sessionId: sourceId, messageId: user, role: "user" },
						{
							provider: "claude",
							createdAt,
							metadata: { runId: `${user}-run` },
						},
					),
					canonicalEvent(
						"text.delta",
						sourceId,
						{ messageId: user, partId: `${user}-text`, text: user },
						{
							provider: "claude",
							createdAt,
							metadata: { runId: `${user}-run` },
						},
					),
					canonicalEvent(
						"run.started",
						sourceId,
						{ inputId: user, requestedRunId: `${user}-run` },
						{
							provider: "claude",
							createdAt: createdAt + 1,
							metadata: { runId: `${user}-run` },
						},
					),
					canonicalEvent(
						"message.created",
						sourceId,
						{
							sessionId: sourceId,
							messageId: assistant,
							role: "assistant",
							parentID: user,
						},
						{
							provider: "claude",
							createdAt: createdAt + 1,
							metadata: { runId: `${user}-run` },
						},
					),
					canonicalEvent(
						"text.delta",
						sourceId,
						{
							messageId: assistant,
							partId: `${assistant}-text`,
							text: assistant,
						},
						{
							provider: "claude",
							createdAt: createdAt + 1,
							metadata: { runId: `${user}-run` },
						},
					),
					canonicalEvent(
						"turn.completed",
						sourceId,
						{ messageId: assistant },
						{
							provider: "claude",
							createdAt: createdAt + 2,
							metadata: { runId: `${user}-run` },
						},
					),
				];
			}).flat();
			await emit(harness, events);
			for (const kind of ["fork", "side-thread"] as const) {
				const statements: string[] = [];
				const started = performance.now();
				const fork = await runtime.runPromise(
					forkSession(
						sourceId,
						kind === "side-thread"
							? { side: { title: "Cost side", inputId: `cost-${messages}` } }
							: undefined,
					).pipe(
						Effect.provideService(Statement.CurrentTransformer, (statement) => {
							statements.push(
								statement.compile()[0].replace(/\s+/g, " ").trim(),
							);
							return Effect.succeed(statement);
						}),
					),
				);
				const milliseconds = performance.now() - started;
				const counts = await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return (yield* sql<{ messages: number; events: number }>`SELECT
						(SELECT COUNT(*) FROM messages WHERE session_id = ${fork.id}) AS messages,
						(SELECT COUNT(*) FROM events WHERE session_id = ${fork.id}) AS events`)[0];
					}),
				);
				expect(counts?.messages).toBe(messages);
				expect(counts?.events).toBeLessThan(15);
				measurements.push({
					kind,
					messages,
					statements: statements.length,
					milliseconds,
					events: counts?.events,
				});
			}
		}
		mkdirSync("docs/performance", { recursive: true });
		writeFileSync(
			"docs/performance/hiuf-3-fork-cost.json",
			`${JSON.stringify({ ticket: "conduit-test-hiuf.3", instrumentation: "effect/sql Statement.CurrentTransformer around production forkSession in the relay harness", measurements }, null, "\t")}\n`,
		);
		for (const kind of ["fork", "side-thread"]) {
			const counts = measurements
				.filter((entry) => entry.kind === kind)
				.map((entry) => entry.statements);
			expect(counts).toHaveLength(2);
			expect(counts[0]).toBe(counts[1]);
		}
	}, 60_000);
});
