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
// Main's control outcomes (3.4, 3.12, 2.1 row 215). How they could fail:
// 13. a writer that ends a control row (the executor, the refusal sweep, drain's removed-project
//     cancel, pending-prompt retirement) appends no effect_outcome, or appends it in another write;
// 14. an unclaimed row's outcome names a transmission other than 0, or a claimed one's another n;
// 15. the folded outcome leaves the control's issue live, or its replay inserts an outbox row.
// One transaction (3.12, S9.2). How it could fail:
// 16. a provider event commits while the ledger decision it carries fails, or the reverse.
// Transmissions (3.4, D59). How they could fail:
// 17. a runner-held send's fresh-run retry run.requested is a transmission too, so the retry counts
//     twice, once at its request and once at its dispatch;
// 18. a fresh-run retry reserves a second Run, or a direct send's retry is no transmission of its Run.
// Load (3.12). How it could fail:
// 19. a session whose only open work is unknown background tasks reads Quiescent, so a restart's
//     load, which rebuilds only Open rows, skips it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Ref, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { makeRetireReplacedProcessPrompts } from "../../../src/lib/persistence/effect/retire-pending-prompts.js";
import {
	loadLedgerView,
	makeRunLedgerArm,
} from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import { SessionRollupProjects } from "../../../src/lib/persistence/effect/session-rollup-projects.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
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

	it.effect(
		"D59: a runner-held fresh-run retry is one transmission, its dispatch; a direct send's run.requested is one",
		() =>
			withStore(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					// The direct marker's event, its token the runId it names (3.4).
					const marker = (
						sessionId: string,
						runId: string,
						createdAt: number,
					) =>
						canonicalEvent(
							"evidence.delivery_indeterminate",
							sessionId,
							{ runId, commandId: "c1" },
							at(createdAt, { runId }),
						);
					const step = (event: CanonicalEvent) =>
						Effect.gen(function* () {
							const entries = sql<{
								n: number;
							}>`SELECT COUNT(*) AS n FROM run_ledger_entries`;
							const [before] = yield* entries;
							yield* projectOnline([event]);
							const [after] = yield* entries;
							const view = yield* loadLedgerView(event.sessionId);
							return {
								folded: (after?.n ?? 0) > (before?.n ?? 0),
								runId: view?.active?.runId,
								inputs: view?.active?.inputs.map((input) => input.state.tag),
								live: view?.live.map((issue) =>
									issue.tag === "Main" ? issue.commandId : issue.token,
								),
							};
						});
					// Main's retry on a fresh run (4.8): a new runId for an input Run r1 holds.
					const retry = (sessionId: string) =>
						canonicalEvent(
							"run.requested",
							sessionId,
							{ runId: "r2", inputId: "u1" },
							at(1007, { runId: "r2" }),
						);
					// Claude: dispatched as c1's transmission 1, then released unsent (an unlaunch, 3.6).
					yield* projectOnline([
						...turn("s1", "claude").slice(0, 4),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "rn", label: "rn:1", reattached: false },
							at(1004, {}, "claude"),
						),
						canonicalEvent(
							"run.dispatched",
							"s1",
							{ runId: "r1", runnerId: "rn", commandId: "c1", transmission: 1 },
							at(1005, { runId: "r1" }, "claude"),
						),
						canonicalEvent(
							"run.released",
							"s1",
							{
								runId: "r1",
								runnerId: "rn",
								commandId: "c1",
								transmission: 1,
								reason: "NotSent",
							},
							at(1006, { runId: "r1" }, "claude"),
						),
					]);
					const held = [
						yield* step(retry("s1")),
						yield* step(marker("s1", "r2", 1008)),
						yield* step(
							canonicalEvent(
								"run.dispatched",
								"s1",
								{
									runId: "r2",
									runnerId: "rn",
									commandId: "c1",
									transmission: 2,
								},
								at(1009, { runId: "r2" }, "claude"),
							),
						),
					];
					// 17, 18: the retry names Run r1 and transmits nothing; the marker naming r2 finds no
					// transmission; the dispatch is the retry's one transmission, which moves its input to
					// Dispatching (3.9, 4.11).
					expect(held).toEqual([
						{ folded: true, runId: "r1", inputs: ["Queued"], live: [] },
						{ folded: false, runId: "r1", inputs: ["Queued"], live: [] },
						{
							folded: true,
							runId: "r1",
							inputs: ["Dispatching"],
							live: ["c1"],
						},
					]);

					// OpenCode: run.requested r1 is the direct start's transmission, under its input's id.
					yield* projectOnline(turn("s2", "opencode").slice(0, 4));
					const direct = [
						yield* step(marker("s2", "r9", 1006)),
						yield* step(retry("s2")),
						yield* step(marker("s2", "r2", 1008)),
					];
					// 18: an unknown runId is no transmission; the retry names Run r1 and is one.
					expect(direct).toEqual([
						{
							folded: false,
							runId: "r1",
							inputs: ["Dispatching"],
							live: ["u1"],
						},
						{
							folded: true,
							runId: "r1",
							inputs: ["Dispatching"],
							live: ["u1"],
						},
						{ folded: true, runId: "r1", inputs: ["Delivered"], live: ["u1"] },
					]);
				}),
			),
	);

	it.effect(
		"keeps a session with only unknown background tasks Open, the row a restart's load rebuilds",
		() =>
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "run-ledger-arm-"));
				const file = join(dir, "events.db");
				const open = <A, E>(
					effect: Effect.Effect<A, E, PersistenceEffectContext>,
				) =>
					effect.pipe(
						Effect.provide(makePersistenceEffectLayer(file, "test-project")),
					);
				const process = (sessionId: string, reattached: boolean) =>
					canonicalEvent(
						"evidence.process_started",
						sessionId,
						{
							runnerId: `rn-${sessionId}`,
							label: `rn-${sessionId}:1`,
							reattached,
						},
						at(1004, {}, "claude"),
					);
				const observed = Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return {
						rows: yield* sql`SELECT session_id, state FROM run_ledger_sessions ORDER BY session_id`,
						tasks: (yield* loadLedgerView("s1"))?.tasks,
					};
				});
				const before = yield* open(
					Effect.gen(function* () {
						// s1's runner survived a restart: its tasks are unknown, its only open work. s2's
						// is fresh, with none.
						yield* projectOnline([
							makeSessionCreatedEvent("s1", {
								provider: "claude",
								createdAt: 1000,
							}),
							process("s1", true),
							makeSessionCreatedEvent("s2", {
								provider: "claude",
								createdAt: 1000,
							}),
							process("s2", false),
						]);
						return yield* observed;
					}),
				);
				// A fresh graph over the same file, as a restart's.
				const after = yield* open(
					Effect.gen(function* () {
						yield* (yield* ProjectionRunnerEffectTag).recover();
						return yield* observed;
					}),
				).pipe(
					Effect.ensuring(
						Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
					),
				);
				// 19: the row is Open, so the load rebuilds s1 with its tasks unknown.
				expect(before).toEqual({
					rows: [
						{ session_id: "s1", state: "Open" },
						{ session_id: "s2", state: "Quiescent" },
					],
					tasks: { tag: "unknown", label: "rn-s1:1" },
				});
				expect(after).toEqual(before);
			}),
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
	it.live(
		"appends one effect_outcome where each writer ends a control row, n 0 when unclaimed",
		() =>
			Effect.gen(function* () {
				const interrupts: string[] = [];
				// s2 lives in a project that is later removed; the others in test-project.
				const opened = ["s1", "s2", "s3", "s4"].map((id) =>
					turn(id, "opencode"),
				);
				const stops = ["s1", "s2", "s3", "s4"].map((id, index) =>
					canonicalEvent(
						"interrupt.requested",
						id,
						{ providerProcessId: "p1", stop: null },
						at(1010, { commandId: `c${index + 1}` }),
					),
				);
				const online = yield* withStore(
					Effect.scoped(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							const commit = yield* makeCommitAndSignal;
							const runner = yield* ProjectionRunnerEffectTag;
							const local = yield* EventStoreEffectTag;
							const gone = yield* makeEventStoreEffect.pipe(
								Effect.provideService(PersistenceProjectTag, {
									projectId: "gone",
								}),
							);
							yield* runner.recover();
							for (const [index, events] of opened.entries())
								for (const event of [...events, stops[index]])
									if (event)
										yield* runner.projectEvent(
											yield* (index === 1 ? gone : local).append(event),
										);
							const live = (sessionId: string) =>
								loadLedgerView(sessionId).pipe(
									Effect.map((view) =>
										(view?.live ?? []).flatMap((issued) =>
											// Main's controls; u1 is the running turn's send.
											issued.tag === "Main" && issued.commandId !== "u1"
												? [issued.commandId]
												: [],
										),
									),
								);
							const issued = [
								yield* live("s1"),
								yield* live("s2"),
								yield* live("s3"),
								yield* live("s4"),
							];
							const control = (index: number) =>
								sql`INSERT INTO provider_command_outbox (request_sequence, command_id,
									project_key, session_id, provider_id, effect_type, payload_json, run_id,
									provider_process_id, status, attempt_count, requested_at, updated_at)
									VALUES (${100 + index}, ${`c${index + 1}`}, ${index === 1 ? "gone" : "test-project"},
										${`s${index + 1}`}, 'opencode', 'interrupt_turn',
										${JSON.stringify({ type: "interrupt_turn", sessionId: `s${index + 1}`, providerProcessId: "p1", stop: null })},
										'r1', ${index === 0 || index === 3 ? "p1" : null}, 'pending', 0, 1010, 1010)`;
							const reactor = (
								isProjectReady?: (
									projectId: string,
									sessionId: string,
								) => Effect.Effect<boolean, ProviderInstanceFailure>,
							) =>
								new ProviderSideEffectReactor({
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
											getNativeSessionEffect: () => Effect.succeed(undefined),
											// c1's process is live; c4's expired with it but is retired by its session.
											getControlProcessIdEffect: () => Effect.succeed("p1"),
											resolvePermissionEffect: () => Effect.void,
											resolveQuestionEffect: () => Effect.void,
											shutdownEffect: () => Effect.void,
											endSessionEffect: () => Effect.void,
										},
									]),
									...(isProjectReady ? { isProjectReady } : {}),
									nowMs: () => 2000,
								});
							// Pending-prompt retirement ends c4, bound to the expired process p1.
							yield* control(3);
							const retire = yield* makeRetireReplacedProcessPrompts;
							yield* retire(null, { sessionId: "s4", expiredProcessId: "p1" });
							// The refusal sweep ends c3, and every ledger row still open.
							yield* control(2);
							yield* reactor((_, sessionId) =>
								Effect.fail(
									new ProviderInstanceFailure({
										providerId: "opencode",
										operation: sessionId,
										cause: new Error("unavailable"),
										code: "project_unavailable",
									}),
								),
							).drain();
							// drain cancels c2, whose project is no longer registered.
							yield* control(1);
							const registered = yield* Ref.make<readonly string[]>([
								"test-project",
							]);
							const removedProjectDrain = reactor()
								.drain()
								.pipe(Effect.provideService(SessionRollupProjects, registered));
							yield* removedProjectDrain;
							// The executor claims c1 and records its success.
							yield* control(0);
							yield* removedProjectDrain;
							return {
								issued,
								after: [
									yield* live("s1"),
									yield* live("s2"),
									yield* live("s3"),
									yield* live("s4"),
								],
								controls:
									yield* sql`SELECT command_id, status, attempt_count FROM provider_command_outbox
									WHERE effect_type = 'interrupt_turn' ORDER BY command_id`,
								outcomes: yield* sql<{
									sequence: number;
									project_id: string;
									data: string;
								}>`SELECT sequence, project_id, data FROM events
									WHERE type = 'evidence.effect_outcome'
										AND json_extract(data, '$.token') IS NULL ORDER BY sequence`,
								folded: yield* sql<{
									event_sequence: number;
								}>`SELECT DISTINCT event_sequence FROM run_ledger_entries`,
								// Both projects' outcomes, as canonical events: the read is not project-scoped.
								answers: (yield* local.readFromSequence(0)).flatMap((event) =>
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
				expect(online.issued).toEqual([["c1"], ["c2"], ["c3"], ["c4"]]);
				expect(interrupts).toEqual(["s1"]);
				expect(online.controls).toEqual([
					{ command_id: "c1", status: "completed", attempt_count: 1 },
					{ command_id: "c2", status: "cancelled", attempt_count: 0 },
					{ command_id: "c3", status: "failed", attempt_count: 0 },
					{ command_id: "c4", status: "cancelled", attempt_count: 0 },
				]);
				// 13, 14: one outcome per ended control, in its row's project.
				expect(
					online.outcomes.map(({ project_id, data }) => ({
						project_id,
						...JSON.parse(data),
					})),
				).toEqual([
					{
						project_id: "test-project",
						commandId: "c4",
						transmission: 0,
						outcome: { tag: "permanent", code: "provider_process_gone" },
					},
					{
						project_id: "test-project",
						commandId: "c3",
						transmission: 0,
						outcome: { tag: "permanent", code: "project_unavailable" },
					},
					{
						project_id: "gone",
						commandId: "c2",
						transmission: 0,
						outcome: { tag: "permanent", code: "project_inactive" },
					},
					{
						project_id: "test-project",
						commandId: "c1",
						transmission: 1,
						outcome: { tag: "succeeded" },
					},
				]);
				// 15: each was folded in its write; a swept control's issue ends, while c1's delivered
				// interrupt stays live until its Run ends.
				for (const { sequence } of online.outcomes)
					expect(online.folded.map((row) => row.event_sequence)).toContain(
						sequence,
					);
				expect(online.after).toEqual([["c1"], [], [], []]);

				// 15: a cold replay of both projects' logs folds the same and inserts no row.
				const replayed = yield* withStore(
					Effect.gen(function* () {
						const local = yield* EventStoreEffectTag;
						const gone = yield* makeEventStoreEffect.pipe(
							Effect.provideService(PersistenceProjectTag, {
								projectId: "gone",
							}),
						);
						const runner = yield* ProjectionRunnerEffectTag;
						for (const event of [
							...opened.flatMap((events, index) => [
								...events,
								...(stops[index] ? [stops[index]] : []),
							]),
							...online.answers,
						])
							yield* (event.sessionId === "s2" ? gone : local).append(event);
						yield* runner.recover();
						return yield* ledgerRows;
					}),
				);
				expect(replayed.outbox).toEqual([]);
				expect(replayed.entries).toEqual(online.rows.entries);
				expect(replayed.sessions).toEqual(online.rows.sessions);
			}),
	);

	it.effect(
		"commits a provider event and its ledger decision together: a failed fold leaves neither",
		() =>
			withStore(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					yield* commit(turn("s1", "claude"));
					const before = yield* ledgerRows;
					const view = yield* loadLedgerView("s1");
					const completed = canonicalEvent(
						"turn.completed",
						"s1",
						{ messageId: "m1" },
						at(1005, { runId: "r1" }, "claude"),
					);
					// A crash inside the arm's write, after the event's insert.
					yield* sql`CREATE TRIGGER crash BEFORE INSERT ON run_ledger_entries
						BEGIN SELECT RAISE(ABORT, 'crash'); END`;
					const crashed = yield* Effect.exit(commit([completed]));
					const stored = sql<{
						n: number;
					}>`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.completed'`;
					expect(crashed._tag).toBe("Failure");
					expect(yield* stored).toEqual([{ n: 0 }]);
					expect(yield* ledgerRows).toEqual(before);
					expect(yield* loadLedgerView("s1")).toEqual(view);
					yield* sql`DROP TRIGGER crash`;
					yield* commit([completed]);
					expect(yield* stored).toEqual([{ n: 1 }]);
					expect((yield* loadLedgerView("s1"))?.active).toBeUndefined();
				}),
			),
	);
});
