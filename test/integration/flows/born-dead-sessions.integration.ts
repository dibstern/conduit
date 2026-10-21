import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Deferred, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { decodeProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	type DrainReport,
	EventRetentionTag,
} from "../../../src/lib/domain/persistence/Services/event-retention.js";
import { ProviderRuntimeIngestionTag } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeClaudeEventPersistEffect } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { isSessionDeleted } from "../../../src/lib/persistence/effect/session-seeder-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

interface EventRow {
	sequence: number;
	session_id: string;
	type: string;
	data: string;
}

describe("born-dead sessions through the relay", () => {
	let harness: RelayHarness | undefined;
	let db: Database.Database | undefined;
	const evidence: Record<string, unknown> = {};

	beforeEach(() => {
		// Browser bootstrap asks for catalogues. Keep its discovery local so a
		// real SDK probe cannot leave project hooks writing after test teardown.
		__setProbeOverrideForTesting(async () => ({
			models: [],
			commands: [],
			agents: [],
		}));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		db?.close();
		db = undefined;
		await harness?.stop();
		harness = undefined;
		__setProbeOverrideForTesting(undefined);
		mkdirSync("test-results/born-dead-sessions", { recursive: true });
		writeFileSync(
			"test-results/born-dead-sessions/flows.json",
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
	});

	it("keeps a live parent and child when the parent's deletion event names another session", async () => {
		harness = await createRelayHarness();
		const relay = harness;
		const runtime = relay.stack.effectRuntime.runtime;
		const database = new Database(relay.eventsDbPath, { readonly: true });
		db = database;
		const sourceId = "foreign-marker-source";
		const childId = "foreign-marker-child";
		const targetId = "foreign-marker-target";
		const { commit, ingestion, retention, sql } = await runtime.runPromise(
			Effect.gen(function* () {
				return {
					commit: yield* makeCommitAndSignal,
					ingestion: yield* ProviderRuntimeIngestionTag,
					retention: yield* EventRetentionTag,
					sql: yield* SqlClient.SqlClient,
				};
			}),
		);
		await runtime.runPromise(
			commit([
				canonicalEvent("session.created", sourceId, {
					sessionId: sourceId,
					title: "Live source",
					provider: "claude",
				}),
				canonicalEvent("session.created", targetId, {
					sessionId: targetId,
					title: "Deletion target",
					provider: "claude",
				}),
				canonicalEvent("session.created", childId, {
					sessionId: childId,
					title: "Live child",
					provider: "claude",
					parentId: sourceId,
				}),
				canonicalEvent("message.created", childId, {
					messageId: "foreign-marker-message",
					sessionId: childId,
					role: "assistant",
				}),
				canonicalEvent("text.delta", childId, {
					messageId: "foreign-marker-message",
					partId: "foreign-marker-text",
					text: "Keep this child history",
				}),
			]),
		);
		const historyBefore = database
			.prepare(
				"SELECT event_id, type, data FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(childId);
		const reports: DrainReport[] = [];
		const drain = retention.drain;
		vi.spyOn(retention, "drain").mockImplementation(() =>
			drain().pipe(
				Effect.tap((report) => Effect.sync(() => reports.push(report))),
			),
		);
		// The stream belongs to S, but this event deletes T. It is not S's marker.
		await runtime.runPromise(
			commit([
				canonicalEvent("session.deleted", sourceId, { sessionId: targetId }),
			]),
		);
		let transaction: unknown;
		await runtime.runPromise(
			ingestion.ingestBatch(
				[
					decodeProviderRuntimeEvent({
						eventId: "evt_foreign_marker_late_child",
						type: "session.created",
						providerId: "claude",
						sessionId: childId,
						createdAt: Date.now(),
						providerRefs: {},
						rawSource: { kind: "born-dead-relay-test" },
						data: {
							sessionId: childId,
							title: "Late child update",
							parentId: sourceId,
						},
					}),
				],
				{
					beforeCommit: Effect.gen(function* () {
						transaction = {
							events:
								yield* sql<EventRow>`SELECT sequence, session_id, type, data FROM events
						WHERE session_id = ${childId} AND event_id NOT IN (SELECT value FROM json_each(${JSON.stringify(historyBefore.map((row) => (row as { event_id: string }).event_id))}))
						ORDER BY sequence`,
							sessions:
								yield* sql`SELECT id, parent_id, title FROM sessions WHERE id IN (${sourceId}, ${childId}) ORDER BY id`,
							sourceDead: yield* isSessionDeleted(sourceId),
							childDead: yield* isSessionDeleted(childId),
						};
					}).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
				},
			),
		);
		await relay.drainEventRetention();
		const projectedRows = database
			.prepare(
				"SELECT id, parent_id, title FROM sessions WHERE id IN (?, ?) ORDER BY id",
			)
			.all(sourceId, childId);
		const childMarkers = database
			.prepare(
				"SELECT type, data FROM events WHERE session_id = ? AND type = 'session.deleted' AND json_extract(data, '$.sessionId') = session_id",
			)
			.all(childId);
		const historyAfter = database
			.prepare(
				"SELECT event_id, type, data FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(childId);
		const messages = database
			.prepare(
				"SELECT m.id, part.text FROM messages m JOIN message_parts part ON part.message_id = m.id WHERE m.session_id = ?",
			)
			.all(childId);
		const parity = await relay.checkReplayParity();
		evidence["foreign-named-deletion"] = {
			writer: "ProviderRuntimeIngestion.ingestBatch",
			sourceId,
			childId,
			targetId,
			transaction,
			projectedRows,
			childMarkers,
			historyBefore,
			historyAfter,
			messages,
			drainReports: reports,
			parity,
		};
		expect(projectedRows).toEqual([
			{ id: childId, parent_id: sourceId, title: "Late child update" },
			{ id: sourceId, parent_id: null, title: "Live source" },
		]);
		expect(
			database.prepare("SELECT id FROM sessions WHERE id = ?").get(targetId),
		).toBeUndefined();
		expect(await runtime.runPromise(isSessionDeleted(sourceId))).toBe(false);
		expect(await runtime.runPromise(isSessionDeleted(childId))).toBe(false);
		expect(childMarkers).toEqual([]);
		expect(historyAfter).toEqual(expect.arrayContaining(historyBefore));
		expect(historyAfter).toHaveLength(historyBefore.length + 1);
		expect(messages).toEqual([
			{ id: "foreign-marker-message", text: "Keep this child history" },
		]);
		expect(reports.length).toBeGreaterThan(0);
		for (const report of reports) {
			expect(report.sessionsFreed).toBe(0);
			expect(report.eventsFreed).toBe(0);
		}
		expect(parity.diffs).toEqual([]);
		expect(parity.danglingPartPointers).toEqual([]);
	});

	// Failure modes: a delete wins between ingress and append; a missing parent
	// or source trips a FK; a marker is only projected on replay; a marker with
	// no removed row loses its kick; drain cannot reclaim the creation; or a
	// previously deleted id is resurrected. Gates fix the transaction ordering.
	it.each([
		{ name: "parent-during-delete", reference: "parentId", during: true },
		{ name: "parent-after-delete", reference: "parentId", during: false },
		{ name: "source-after-delete", reference: "forkedFrom", during: false },
		{ name: "recreate-own-id", reference: "sessionId", during: false },
		{ name: "recreate-payload-id", reference: "sessionId", during: false },
	] as const)("$name", async ({ name, reference, during }) => {
		harness = await createRelayHarness();
		const relay = harness;
		const database = new Database(relay.eventsDbPath, { readonly: true });
		db = database;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const parent = await client.createSession("Born dead source", {
			providerId: "opencode",
		});
		const parentId = String(parent["id"]);
		const childId = reference === "sessionId" ? parentId : `ses_${name}`;
		const runtime = relay.stack.effectRuntime.runtime;
		const { commit, ingestion, retention, sql } = await runtime.runPromise(
			Effect.gen(function* () {
				return {
					commit: yield* makeCommitAndSignal,
					ingestion: yield* ProviderRuntimeIngestionTag,
					retention: yield* EventRetentionTag,
					sql: yield* SqlClient.SqlClient,
				};
			}),
		);
		const deleteEntered = Deferred.makeUnsafe<void>();
		const finishDelete = Deferred.makeUnsafe<void>();
		const drainGate = Deferred.makeUnsafe<void>();
		const reports: DrainReport[] = [];
		const drain = retention.drain;
		let drains: ReturnType<typeof vi.spyOn> | undefined;
		const observeDrains = () => {
			drains = vi.spyOn(retention, "drain").mockImplementation(() =>
				Deferred.await(drainGate).pipe(
					Effect.flatMap(() => drain()),
					Effect.tap((report) => Effect.sync(() => reports.push(report))),
				),
			);
		};
		if (during) observeDrains();
		const deletion = runtime.runPromise(
			commit(
				[canonicalEvent("session.deleted", parentId, { sessionId: parentId })],
				{
					beforeCommit: during
						? Effect.gen(function* () {
								yield* Deferred.succeed(deleteEntered, undefined);
								yield* Deferred.await(finishDelete);
							})
						: Effect.void,
				},
			),
		);
		if (during) {
			await runtime.runPromise(Deferred.await(deleteEntered));
		} else {
			await deletion;
			await vi.waitFor(() =>
				expect(
					database
						.prepare(
							"SELECT type FROM events WHERE session_id = ? AND type <> 'session.deleted'",
						)
						.all(parentId),
				).toEqual([]),
			);
			observeDrains();
		}
		const baseline = database
			.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events")
			.get() as { sequence: number };
		let transaction: unknown;
		const arrival = runtime.runPromise(
			ingestion.ingestBatch(
				[
					decodeProviderRuntimeEvent({
						eventId: `evt_born_dead_${name}`,
						type: "session.created",
						providerId: "claude",
						sessionId:
							name === "recreate-payload-id" ? "ses_other_stream" : childId,
						createdAt: Date.now(),
						providerRefs: {},
						rawSource: { kind: "born-dead-relay-test" },
						data: {
							sessionId: childId,
							title: "Late subagent",
							...(reference === "sessionId" ? {} : { [reference]: parentId }),
						},
					}),
				],
				{
					beforeCommit: Effect.gen(function* () {
						const events =
							yield* sql<EventRow>`SELECT sequence, session_id, type, data
							FROM events WHERE session_id = ${childId} AND sequence > ${baseline.sequence}
							ORDER BY sequence`;
						const sessions =
							yield* sql`SELECT id FROM sessions WHERE id = ${childId}`;
						const providers =
							yield* sql`SELECT id FROM session_providers WHERE session_id = ${childId}`;
						const dead = yield* isSessionDeleted(childId);
						// An independent reader cannot see either new event before COMMIT.
						const externallyVisible = database
							.prepare(
								"SELECT type FROM events WHERE session_id = ? AND sequence > ?",
							)
							.all(childId, baseline.sequence);
						transaction = {
							events,
							sessions,
							providers,
							dead,
							externallyVisible,
						};
						expect(sessions).toEqual([]);
						expect(providers).toEqual([]);
						expect(dead).toBe(true);
						expect(externallyVisible).toEqual([]);
						expect(events.map((event) => event.type)).toEqual(
							reference === "sessionId"
								? []
								: ["session.created", "session.deleted"],
						);
					}).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
				},
			),
		);
		if (during) {
			await runtime.runPromise(Deferred.succeed(finishDelete, undefined));
			await deletion;
		}
		await arrival;
		expect(transaction).toBeDefined();
		const projectedRows = {
			sessions: database
				.prepare("SELECT id FROM sessions WHERE id = ?")
				.all(childId),
			providers: database
				.prepare("SELECT id FROM session_providers WHERE session_id = ?")
				.all(childId),
			dead: await runtime.runPromise(isSessionDeleted(childId)),
		};
		expect(projectedRows).toEqual({ sessions: [], providers: [], dead: true });
		const beforeDrainParity = await relay.checkReplayParity();
		expect(beforeDrainParity.diffs).toEqual([]);
		expect(beforeDrainParity.danglingPartPointers).toEqual([]);
		if (reference === "sessionId") {
			expect(drains).not.toHaveBeenCalled();
		} else {
			// No manual drain or additional delete: only the committed marker kicks it.
			await vi.waitFor(() => expect(drains).toHaveBeenCalled());
		}
		await runtime.runPromise(Deferred.succeed(drainGate, undefined));
		if (reference !== "sessionId") {
			await vi.waitFor(() => {
				expect(reports.some((report) => report.sessionsFreed >= 1)).toBe(true);
				expect(
					database
						.prepare("SELECT type FROM events WHERE session_id = ?")
						.all(childId),
				).toEqual([{ type: "session.deleted" }]);
			});
		}
		const afterDrainParity = await relay.checkReplayParity();
		expect(afterDrainParity.diffs).toEqual([]);
		expect(afterDrainParity.danglingPartPointers).toEqual([]);
		evidence[name] = {
			writer: "ProviderRuntimeIngestion.ingestBatch",
			parentId,
			childId,
			transaction,
			projectedRows,
			drainReports: reports,
			beforeDrainParity,
			afterDrainParity,
		};
	});

	it.each([
		"missing-parent",
		"batch-cascade",
	] as const)("refuses %s without committing any events", async (scenario) => {
		harness = await createRelayHarness();
		const relay = harness;
		const runtime = relay.stack.effectRuntime.runtime;
		const database = new Database(relay.eventsDbPath, { readonly: true });
		db = database;
		const eventsBefore = () =>
			database.prepare("SELECT event_id FROM events ORDER BY sequence").all();
		const setup = await runtime.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "batch-parent", {
						sessionId: "batch-parent",
						title: "Parent",
						provider: "claude",
					}),
					canonicalEvent("session.created", "batch-descendant", {
						sessionId: "batch-descendant",
						title: "Descendant",
						provider: "claude",
						parentId: "batch-parent",
					}),
					canonicalEvent("session.created", "batch-target", {
						sessionId: "batch-target",
						title: "Target",
						provider: "claude",
					}),
				]);
				return {
					manager: yield* SessionManagerServiceTag,
					persist: yield* makeClaudeEventPersistEffect,
				};
			}),
		);
		const before = eventsBefore();
		const result =
			scenario === "missing-parent"
				? await runtime.runPromise(
						Effect.result(
							setup.manager.establishOpenCodeSession(
								{
									id: "unknown-parent-child",
									parentID: "unknown-parent",
									title: "Must not seed",
									projectID: "integration-test",
									directory: process.cwd(),
									version: "1.0.0",
									time: { created: 1, updated: 1 },
								},
								AccountIdSchema.make("opencode"),
							),
						),
					)
				: await runtime.runPromise(
						Effect.result(
							setup.persist.persistEvents([
								canonicalEvent("session.deleted", "batch-parent", {
									sessionId: "batch-parent",
								}),
								canonicalEvent("session.created", "batch-target", {
									sessionId: "batch-target",
									title: "Must not fork",
									provider: "claude",
									forkedFrom: "batch-descendant",
								}),
							]),
						),
					);
		expect(result._tag).toBe("Failure");
		expect(eventsBefore()).toEqual(before);
		const rows = database
			.prepare(
				"SELECT id, parent_id, forked_from FROM sessions WHERE id IN ('batch-parent', 'batch-descendant', 'batch-target', 'unknown-parent-child') ORDER BY id",
			)
			.all();
		expect(rows).toHaveLength(3);
		const parity = await relay.checkReplayParity();
		expect(parity.diffs).toEqual([]);
		expect(parity.danglingPartPointers).toEqual([]);
		evidence[scenario] = {
			writer:
				scenario === "missing-parent"
					? "SessionManager.establishOpenCodeSession"
					: "ClaudeEventPersist.persistEvents",
			eventsAppended: [],
			projectedRows: rows,
			refusal: result,
			parity,
			drainReport: await relay.drainEventRetention(),
		};
	});
});
