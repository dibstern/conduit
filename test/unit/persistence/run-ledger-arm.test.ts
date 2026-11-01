// The Run Ledger's arm (CONTRACT.md 3.1, 3.12) against real SQLite. How it could fail:
// 1. it folds nothing, or folds a fact twice when an event is projected again;
// 2. replay inserts an outbox row, or the live and replayed folds differ (LI4);
// 3. an effect insert is not keyed, so a second fold of the same token inserts twice;
// 4. its per-session row is rewritten by every activity frame in one phase (A15);
// 5. a second writer's commit leaves its cache stale, so the next fold forks the log;
// 6. a wake's non-terminal turn.completed ends the Run (F18);
// 7. a folded fact does not advance the read model (A.21).
// The ledger effects' executor (3.12, 2.1 row 216, 3.7). How it could fail:
// 8. a ledger row waits in the session lane behind a running send, so a Stop never acts;
// 9. nothing wakes the reactor after the commit that inserts one, so it waits for an unrelated drain;
// 10. its status and effect_outcome land in separate writes, or the outcome is never folded;
// 11. a probe's provider call outlives its retry deadline, or its timeout is not retryable at it;
// 12. a replay of the outcome inserts an outbox row.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	loadLedgerView,
	makeRunLedgerArm,
} from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const withStore = <A, E>(
	effect: Effect.Effect<A, E, PersistenceEffectContext>,
) =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "run-ledger-arm-"))),
		(dir) =>
			effect.pipe(
				Effect.provide(
					makePersistenceEffectLayer(join(dir, "events.db"), "test-project"),
				),
			),
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	);

const at = (createdAt: number, metadata = {}, provider?: string) => ({
	createdAt,
	metadata,
	...(provider ? { provider } : {}),
});

/** One input admitted, handed off, requested, started; then the Stop's interrupt. */
const turn = (sessionId: string, provider: "claude" | "opencode") => [
	makeSessionCreatedEvent(sessionId, { provider, createdAt: 1000 }),
	canonicalEvent(
		"input.admitted",
		sessionId,
		{
			sessionId,
			inputId: "u1",
			delivery: "queue",
			request: { text: "hi", images: [] },
		},
		at(1001),
	),
	canonicalEvent(
		"input.sent",
		sessionId,
		{ sessionId, inputId: "u1" },
		at(1002),
	),
	canonicalEvent(
		"run.requested",
		sessionId,
		{ runId: "r1", inputId: "u1" },
		at(1003, { runId: "r1" }),
	),
	canonicalEvent(
		"run.started",
		sessionId,
		{ inputId: "u1", requestedRunId: "r1" },
		at(1004, { runId: "r1" }, provider),
	),
];

const ledgerRows = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return {
		entries: yield* sql<{
			session_id: string;
			entry_seq: number;
			event_sequence: number;
			entry_json: string;
		}>`SELECT session_id, entry_seq, event_sequence, entry_json FROM run_ledger_entries
			ORDER BY session_id, entry_seq`,
		sessions:
			yield* sql`SELECT session_id, provider, state, alarm_at FROM run_ledger_sessions ORDER BY session_id`,
		outbox: yield* sql<{
			command_id: string;
			effect_type: string;
			status: string;
			payload_json: string;
		}>`SELECT command_id, effect_type, status, payload_json FROM provider_command_outbox
			WHERE effect_type IN ('probe', 'stop_task', 'cancel_request') ORDER BY request_sequence`,
	};
});

const projectOnline = (events: readonly CanonicalEvent[]) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		yield* runner.recover();
		for (const event of events)
			yield* runner.projectEvent(yield* store.append(event));
	});

describe("Run Ledger arm", () => {
	it.effect(
		"folds main's events in the projecting write; a wake's turn.completed ends nothing",
		() =>
			withStore(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* projectOnline([
						...turn("s1", "claude"),
						canonicalEvent(
							"turn.completed",
							"s1",
							{ messageId: "m1" },
							at(1005, { runId: "r1" }, "claude"),
						),
					]);
					const ended = yield* ledgerRows;
					const endedView = yield* loadLedgerView("s1");
					expect(ended.entries.length).toBeGreaterThan(0);
					expect(ended.sessions).toEqual([
						{
							session_id: "s1",
							provider: "claude",
							state: "Quiescent",
							alarm_at: null,
						},
					]);
					expect((yield* loadLedgerView("s1"))?.active).toBeUndefined();
					// A.21: the session row took the last folded event's version.
					const [session] = yield* sql<{
						version: number;
					}>`SELECT version FROM sessions WHERE id = 's1'`;
					expect(session?.version).toBeGreaterThan(0);

					// F18: a wake's turn.completed under the ended Run is main's non-terminal one; the
					// decider records its fact and changes nothing.
					yield* projectOnline([
						canonicalEvent(
							"turn.completed",
							"s1",
							{ messageId: "m2" },
							at(1006, { runId: "r1" }, "claude"),
						),
					]);
					const woken = yield* ledgerRows;
					expect(woken.sessions).toEqual(ended.sessions);
					expect(yield* loadLedgerView("s1")).toEqual(endedView);
					expect(
						woken.entries
							.slice(ended.entries.length)
							.map((entry) => JSON.parse(entry.entry_json).kind),
					).toEqual(["fact"]);
				}),
			),
	);

	it.effect(
		"inserts a Stop's ledger effects once live, and replay rebuilds the same fold with no outbox row",
		() =>
			Effect.gen(function* () {
				const events = [
					...turn("s1", "opencode"),
					canonicalEvent(
						"interrupt.requested",
						"s1",
						{ providerProcessId: "p1", stop: null },
						at(1010, { commandId: "c-stop" }),
					),
				];
				const online = yield* withStore(
					Effect.gen(function* () {
						yield* projectOnline(events);
						return {
							rows: yield* ledgerRows,
							view: yield* loadLedgerView("s1"),
						};
					}),
				);
				expect(online.rows.outbox.map((row) => row.effect_type).sort()).toEqual(
					["cancel_request", "probe"],
				);
				expect(
					online.rows.outbox.every((row) => row.status === "pending"),
				).toBe(true);
				const probe = online.rows.outbox.find(
					(row) => row.effect_type === "probe",
				);
				// 3.7: a probe carries its retry deadline, issue + probeMs.
				expect(JSON.parse(probe?.payload_json ?? "{}").deadlineAt).toBe(
					1010 + 30_000,
				);

				const replayed = yield* withStore(
					Effect.gen(function* () {
						const store = yield* EventStoreEffectTag;
						const runner = yield* ProjectionRunnerEffectTag;
						for (const event of events) yield* store.append(event);
						yield* runner.recover();
						return {
							rows: yield* ledgerRows,
							view: yield* loadLedgerView("s1"),
						};
					}),
				);
				// 3.1, A.20 trace 2: replay folds the same entries and issues nothing.
				expect(replayed.rows.outbox).toEqual([]);
				expect(replayed.rows.entries).toEqual(online.rows.entries);
				expect(replayed.rows.sessions).toEqual(online.rows.sessions);
				expect(replayed.view).toEqual(online.view);
			}),
	);

	it.effect(
		"writes the session row only when its value changes across activity frames",
		() =>
			withStore(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE row_writes (n INTEGER)`;
					yield* sql`CREATE TRIGGER count_insert AFTER INSERT ON run_ledger_sessions
						BEGIN INSERT INTO row_writes VALUES (1); END`;
					yield* sql`CREATE TRIGGER count_update AFTER UPDATE ON run_ledger_sessions
						BEGIN INSERT INTO row_writes VALUES (1); END`;
					yield* projectOnline([
						...turn("s1", "claude"),
						canonicalEvent(
							"turn.completed",
							"s1",
							{ messageId: "m1" },
							at(1005, { runId: "r1" }, "claude"),
						),
					]);
					const counts = sql<{ writes: number; entries: number }>`SELECT
						(SELECT COUNT(*) FROM row_writes) AS writes,
						(SELECT COUNT(*) FROM run_ledger_entries) AS entries`;
					const [before] = yield* counts;
					// Twenty wake frames in the Ended phase: each folds a fact, none changes the row.
					yield* projectOnline(
						Array.from({ length: 20 }, (_, index) =>
							canonicalEvent(
								"turn.completed",
								"s1",
								{ messageId: `wake-${index}` },
								at(2000 + index, { runId: "r1" }, "claude"),
							),
						),
					);
					const [after] = yield* counts;
					expect(after?.entries).toBe((before?.entries ?? 0) + 20);
					expect(after?.writes).toBe(before?.writes);
				}),
			),
	);

	it.effect(
		"reloads a session another writer folded into, never folding on a stale cache",
		() =>
			withStore(
				Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					const sql = yield* SqlClient.SqlClient;
					const [created, ...rest] = turn("s1", "claude");
					if (!created) return;
					yield* projectOnline([created]);
					const first = makeRunLedgerArm();
					const second = makeRunLedgerArm();
					const project = (
						arm: ReturnType<typeof makeRunLedgerArm>,
						event: CanonicalEvent,
					) =>
						Effect.gen(function* () {
							const stored = yield* store.append(event);
							yield* sql.withTransaction(
								arm.project(stored, { version: stored.sequence }),
							);
						});
					const [admitted, sent, requested, started] = rest;
					if (!admitted || !sent || !requested || !started) return;
					yield* project(first, admitted);
					yield* project(first, sent);
					yield* project(second, requested);
					yield* project(first, started);
					const entries = yield* sql<{
						entry_seq: number;
					}>`SELECT entry_seq FROM run_ledger_entries WHERE session_id = 's1' ORDER BY entry_seq`;
					expect(entries.map(({ entry_seq }) => entry_seq)).toEqual(
						entries.map((_, index) => index + 1),
					);
					// The first arm folded run.started onto the second's run.requested: a Run is active.
					expect((yield* loadLedgerView("s1"))?.active).toBeDefined();
				}),
			),
	);
	it.live(
		"runs a Stop's ledger effects beside a running send, woken by their commit, each outcome folded in its write",
		() =>
			Effect.gen(function* () {
				const interrupts: string[] = [];
				const opened = turn("s1", "opencode");
				const stop = canonicalEvent(
					"interrupt.requested",
					"s1",
					{ providerProcessId: "p1", stop: null },
					at(1010, { commandId: "c-stop" }),
				);
				const online = yield* withStore(
					Effect.scoped(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							const commit = yield* makeCommitAndSignal;
							yield* projectOnline(opened);
							// A running send holds the session lane (8).
							yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id,
								project_key, session_id, provider_id, effect_type, payload_json, run_id,
								provider_process_id, status, attempt_count, requested_at, updated_at)
								VALUES (1, 'send', 'test-project', 's1', 'opencode', 'send_turn', '{}', 'r1',
									NULL, 'running', 1, 1003, 1003)`;
							const reactor = new ProviderSideEffectReactor({
								sql,
								write: commit.write,
								ingestion: {
									ingest: () => Effect.die("unused"),
									ingestBatch: () => Effect.die("unused"),
								},
								registry: new ProviderRegistry([
									{
										providerId: "opencode",
										generateTextEffect: () => Effect.die("unused"),
										discoverEffect: () => Effect.die("unused"),
										sendTurnEffect: () => Effect.die("unused"),
										interruptTurnEffect: (sessionId) =>
											Effect.sync(() => {
												interrupts.push(sessionId);
											}),
										// The probe never answers: its deadline bounds it (11).
										getNativeSessionEffect: () => Effect.never,
										resolvePermissionEffect: () => Effect.void,
										resolveQuestionEffect: () => Effect.void,
										shutdownEffect: () => Effect.void,
										endSessionEffect: () => Effect.void,
									},
								]),
								scope: yield* Scope.Scope,
								// 50 ms before the probe's deadline, issue 1010 + probeMs.
								nowMs: () => 1010 + 30_000 - 50,
							});
							yield* reactor.drain();
							// The Stop's commit inserts the effects; its wake alone runs them (9).
							yield* commit([stop]);
							const ledgerOutbox = sql<{
								command_id: string;
								effect_type: string;
								status: string;
								attempt_count: number;
								next_attempt_at: number | null;
							}>`SELECT command_id, effect_type, status, attempt_count, next_attempt_at
								FROM provider_command_outbox WHERE effect_type <> 'send_turn' ORDER BY effect_type`;
							for (let tries = 0; tries < 200; tries++) {
								const rows = yield* ledgerOutbox;
								if (
									rows.length === 2 &&
									rows.every(
										(row) =>
											row.status !== "pending" && row.status !== "running",
									)
								)
									break;
								yield* Effect.sleep(10);
							}
							return {
								outbox: yield* ledgerOutbox,
								send: yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'send'`,
								outcomes: yield* sql<{
									sequence: number;
									data: string;
								}>`SELECT sequence, data FROM events WHERE type = 'evidence.effect_outcome' ORDER BY sequence`,
								folded: yield* sql<{
									event_sequence: number;
								}>`SELECT DISTINCT event_sequence FROM run_ledger_entries ORDER BY event_sequence`,
								// The reactor's outcome events, as canonical events for the replay.
								answers: (yield* (yield* EventStoreEffectTag).readFromSequence(
									0,
								)).flatMap((event) =>
									event.type === "evidence.effect_outcome"
										? [
												canonicalEvent(
													event.type,
													event.sessionId,
													event.data,
													{
														createdAt: event.createdAt,
														provider: event.provider,
														metadata: event.metadata,
													},
												),
											]
										: [],
								),
								rows: yield* ledgerRows,
							};
						}),
					),
				);
				expect(interrupts).toEqual(["s1"]);
				expect(online.send).toEqual([{ status: "running" }]);
				expect(online.outbox.map(({ command_id: _, ...row }) => row)).toEqual([
					{
						effect_type: "cancel_request",
						status: "completed",
						attempt_count: 1,
						next_attempt_at: null,
					},
					{
						effect_type: "probe",
						status: "retryable_failed",
						attempt_count: 1,
						next_attempt_at: null,
					},
				]);
				const outcomes = online.outcomes.map((row) => JSON.parse(row.data));
				expect(outcomes).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							commandId: online.outbox[0]?.command_id,
							transmission: 1,
							outcome: { tag: "succeeded" },
						}),
						expect.objectContaining({
							commandId: online.outbox[1]?.command_id,
							transmission: 1,
							outcome: { tag: "retryable", retryAt: 1010 + 30_000 },
						}),
					]),
				);
				// 10: each outcome was folded in the write that appended it.
				for (const { sequence } of online.outcomes)
					expect(online.folded.map((row) => row.event_sequence)).toContain(
						sequence,
					);

				// 12: a cold replay of the same log folds the same entries and inserts no row.
				const replayed = yield* withStore(
					Effect.gen(function* () {
						const store = yield* EventStoreEffectTag;
						const runner = yield* ProjectionRunnerEffectTag;
						for (const event of [...opened, stop, ...online.answers])
							yield* store.append(event);
						yield* runner.recover();
						return yield* ledgerRows;
					}),
				);
				expect(replayed.outbox).toEqual([]);
				expect(replayed.entries).toEqual(online.rows.entries);
				expect(replayed.sessions).toEqual(online.rows.sessions);
			}),
	);
});
