import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { ContinuationTag } from "../../../src/lib/domain/relay/Services/continuation.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	createEventId,
} from "../../../src/lib/persistence/events.js";
import {
	runnerFailure,
	runnerSinkId,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	recoverRunnerCommands,
	settleUnclaimedRunnerCommands,
} from "../../../src/lib/provider/runner/runner-recovery.js";
import { failRunnerTurn } from "../../../src/lib/provider/runner/runner-turn-failure.js";
import type {
	DurableSessionTurn,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
} from "../../../src/lib/provider/runner/session-runner.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

// Failure modes: upgrade declares an executing runner idle, guessing a legacy
// turn owner places old events, recovery loses the reserved run id, or a
// migrated turn ignores its own recovery terminal;
// a successful joined replay leaves its migrated reservation running forever.
it.each([
	"stopped",
	"completed",
	"joined",
	"superseded",
] as const)("keeps a migrated executing run busy until its exact %s owned runner terminal", async (result) => {
	const succeeded = result === "completed" || result === "joined";
	const root = mkdtempSync(join(tmpdir(), "legacy-run-upgrade-"));
	const database = join(root, "events.db");
	const proof = {
		case: `legacy-running-upgrade-${result}`,
		outcome: "failed",
		queuedWhileRunning: false,
		recoveredTerminalLegacyTurn: false,
		ownedRecoveryTerminal: false,
		handoffsAfterRecovery: 0,
	};
	let dispose: (() => Promise<void>) | undefined;
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					Object.fromEntries(
						Object.entries(effectMigrationEntries).slice(0, 77),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
					VALUES ('legacy', 'test-project', 'claude', 1, 1)`;
				yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at, project_id)
					VALUES ('legacy-created', 'legacy', 1, 'session.created',
					'{"sessionId":"legacy","title":"Legacy","provider":"claude"}', 'claude', 1, 'test-project')`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, input_id, created_at, updated_at)
					VALUES ('legacy-input', 'legacy', 'user', 'old request', 'legacy-input', 1, 1)`;
				yield* sql`INSERT INTO turns (id, session_id, user_message_id, state, requested_at)
					VALUES ('legacy-input', 'legacy', 'legacy-input', 'running', 1)`;
				yield* sql`INSERT INTO command_receipts
					(command_id, session_id, status, command_type, project_key, created_at, updated_at)
					VALUES ('legacy-input', 'legacy', 'side_effect_requested', 'send_turn', 'test-project', 10, 10)`;
				yield* sql`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id, effect_type,
					payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'legacy-input', 'test-project', 'legacy', 'claude', 'send_turn',
					'{"inputId":"legacy-input"}', 'running', 1, 10, 10)`;
			}).pipe(Effect.provide(SqliteClient.layer({ filename: database }))),
		);
		const handoffs: string[] = [];
		const persistence = makePersistenceEffectLayer(database, "test-project");
		const dependencies = Layer.mergeAll(
			persistence,
			makeTestHandlerLayer({ persistenceLayer: persistence }),
			Layer.succeed(SessionEventBusTag)({
				publish: () => Effect.void,
				publishAdvance: () => Effect.void,
				subscribe: () => Effect.succeed(Stream.empty),
				subscribeAdvances: () => Effect.succeed(Stream.empty),
			}),
			Layer.succeed(Usage)({
				readings: Stream.empty,
				latest: () => Effect.succeed(undefined),
				refresh: () => Effect.succeed([]),
				turnEnded: () => Effect.void,
				pickFailover: () => Effect.succeed(undefined),
			}),
			Layer.succeed(ContinuationTag)({
				requestContinuation: () => Effect.void,
				intakeLimit: () => Effect.succeed(false),
				dismissCutOff: () => Effect.void,
				cancelContinuation: () => Effect.void,
				sweepDueContinuations: () => Effect.void,
				queueLimitPolicy: () => Effect.void,
				runLimitPolicies: Effect.never,
			}),
			Layer.succeed(ProviderTurnServiceTag)({
				holdUserTurnsForAccountSwitch: () => Effect.void,
				prepareTurnSession: () => Effect.succeed("claude"),
				beginStop: () => Effect.succeed(Effect.void),
				turnFences: () => ({ stopping: false, switching: false }),
				fenceLifts: Effect.succeed(Stream.empty),
				sendTurn: (input) =>
					Effect.sync(() => {
						handoffs.push(input.commandId);
					}),
			}),
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		);
		const runtime = ManagedRuntime.make(
			SessionInboxLive.pipe(Layer.provideMerge(dependencies)),
		);
		dispose = () => runtime.dispose();
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const inbox = yield* SessionInboxTag;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const [reservation] = yield* sql<{
					id: string;
					status: string;
				}>`SELECT id, status FROM provider_runs`;
				expect(reservation?.status).toBe("running");
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'run.started'`,
				).toEqual([]);
				expect(yield* sql`SELECT state, run_id FROM turns`).toEqual([
					{ state: "running", run_id: reservation?.id },
				]);
				expect(
					yield* inbox.submit({
						clientId: "browser",
						sessionId: "legacy",
						inputId: "next-input",
						delivery: "queue",
						request: { text: "next request" },
					}),
				).toEqual({ handedOff: false });
				expect(handoffs).toEqual([]);
				proof.queuedWhileRunning = true;
				const emit = (
					output: SessionOutput,
				): Effect.Effect<SessionOutputReply, SessionFailure> =>
					output.type === "event"
						? ingestion.ingest(output.event).pipe(
								Effect.as({}),
								Effect.mapError(() => ({
									operation: "persist recovery",
									message: "Recovery ingestion failed",
								})),
							)
						: Effect.succeed({});
				if (result !== "stopped") {
					const recovered = yield* recoverRunnerCommands(
						sql,
						"legacy",
						"claude",
						{
							driverForAccount: (account) =>
								account === "claude" ? "claude" : undefined,
							decodeInput: (row) =>
								JSON.parse(row.payload_json) as DurableSessionTurn,
							resolveSinkId: (commandId, _inputId, attempt) =>
								runnerSinkId(commandId, attempt),
							closing: () => false,
							failTurn: () =>
								Effect.die("Successful legacy replay must not fail"),
							replay: (_row, input) =>
								Effect.gen(function* () {
									expect(input.runId).toBe(reservation?.id);
									// The adapter supplies ownership before this ingestion seam.
									// A superseded attempt has no current binding and stays unowned.
									if (result === "superseded")
										yield* sql`UPDATE provider_command_outbox SET attempt_count = 2 WHERE command_id = 'legacy-input'`.pipe(
											Effect.mapError((cause) =>
												runnerFailure("supersede fixture attempt", cause),
											),
										);
									yield* emit({
										type: "event",
										sinkId: "legacy-input:1",
										event: {
											eventId: createEventId(),
											...(result === "superseded"
												? {}
												: { runId: input.runId }),
											type: "turn.completed",
											providerId: "claude",
											sessionId: "legacy",
											providerRefs: {},
											rawSource: { kind: "claude.sdk.translator" },
											createdAt: 20,
											data: { messageId: "", duration: 10 },
										},
									});
									return {
										status: result === "joined" ? "joined" : "completed",
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 10,
										providerStateUpdates: [],
									};
								}),
						},
					);
					expect(recovered).toHaveLength(1);
					const [command] = recovered;
					if (!command)
						return yield* Effect.die("Missing recovered legacy command");
					if (result === "superseded") {
						yield* command.wait;
						expect(
							yield* sql`SELECT status FROM provider_runs WHERE id = ${reservation?.id}`,
						).toEqual([{ status: "running" }]);
						expect(
							yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
						).toEqual([{ status: "running", attempt_count: 2 }]);
						expect(
							yield* sql`SELECT type FROM events WHERE type = 'turn.completed' AND json_extract(metadata, '$.runId') IS NOT NULL`,
						).toEqual([]);
						proof.outcome = "passed";
						return;
					}
					yield* command.wait;
					proof.recoveredTerminalLegacyTurn = true;
				} else
					yield* settleUnclaimedRunnerCommands(
						sql,
						new Set(),
						"claude",
						(account) => (account === "claude" ? "claude" : undefined),
						(sinkId, turn, failure) => {
							expect(turn).toMatchObject({
								runId: reservation?.id,
								userMessageId: "legacy-input",
							});
							proof.recoveredTerminalLegacyTurn = true;
							return failRunnerTurn(emit, sinkId, turn, failure, "claude");
						},
					);
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = ${reservation?.id}`,
				).toEqual([{ status: succeeded ? "completed" : "error" }]);
				expect(
					yield* sql`SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted') AND json_extract(metadata, '$.runId') IS NOT NULL`,
				).toEqual([
					{
						type: succeeded ? "turn.completed" : "turn.error",
						run_id: reservation?.id,
					},
				]);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([
					{
						status: succeeded ? "completed" : "failed",
						attempt_count: 1,
					},
				]);
				expect(
					yield* sql`SELECT status, error_code FROM command_receipts`,
				).toEqual([
					{
						status: succeeded ? "side_effect_completed" : "side_effect_failed",
						error_code: succeeded ? null : "runner_stopped",
					},
				]);
				expect(yield* sql`SELECT state, run_id FROM turns`).toEqual([
					{ state: succeeded ? "completed" : "error", run_id: reservation?.id },
				]);
				proof.ownedRecoveryTerminal = true;
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'run.started'`,
				).toEqual([]);
				expect(
					yield* inbox.sendNow({
						clientId: "browser",
						sessionId: "legacy",
						inputId: "next-input",
					}),
				).toBe("accepted");
				expect(
					yield* inbox.sendNow({
						clientId: "browser",
						sessionId: "legacy",
						inputId: "next-input",
					}),
				).toBe("already_started");
				expect(handoffs).toEqual(["next-input"]);
				proof.handoffsAfterRecovery = handoffs.length;
				proof.outcome = "passed";
			}),
		);
	} finally {
		await dispose?.();
		rmSync(root, { recursive: true, force: true });
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/82tn24-legacy-upgrade${result === "stopped" ? "" : `-${result}`}.json`,
			`${JSON.stringify(proof, null, 2)}\n`,
		);
	}
}, 30_000);

// Failure modes: a later provider result appends a second terminal after a
// refusal, two terminals share one unprojected batch, or a joined reservation
// bypasses its effective owner's terminal. Racing writers must share the winner.
it.each([
	{ delivery: "separate", joined: false, aliasFirst: false },
	{ delivery: "separate", joined: true, aliasFirst: false },
	{ delivery: "batch", joined: false, aliasFirst: false },
	{ delivery: "batch", joined: true, aliasFirst: false },
	{ delivery: "concurrent", joined: false, aliasFirst: false },
	{ delivery: "concurrent", joined: true, aliasFirst: false },
	{ delivery: "batch", joined: true, aliasFirst: true },
	{ delivery: "separate", joined: true, aliasFirst: true },
	{ delivery: "separate", joined: false, aliasFirst: true },
	{ delivery: "cleanup", joined: true, aliasFirst: true },
] as const)("persists only one owned terminal with $delivery delivery, joined $joined, alias first $aliasFirst", async ({
	delivery,
	joined,
	aliasFirst,
}) => {
	const root = mkdtempSync(join(tmpdir(), "run-terminal-once-"));
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(join(root, "events.db"), "test-project"),
	);
	const proof: Record<string, unknown> = {
		delivery,
		joined,
		aliasFirst,
		outcome: "failed",
	};
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const commit = yield* makeCommitAndSignal;
				const sql = yield* SqlClient.SqlClient;
				yield* commit([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						title: "Owned terminal",
						provider: "claude",
					}),
					canonicalEvent("run.requested", "session", {
						runId: "run",
						inputId: "input",
					}),
					...(joined
						? [
								canonicalEvent("run.requested", "session", {
									runId: "reservation",
									inputId: "input",
								}),
							]
						: []),
				]);
				yield* persist.persistUserMessage("session", "Original prompt", {
					inputId: "input",
					messageId: "input",
					runId: "run",
				});
				yield* persist.persistEvent(
					canonicalEvent(
						"run.started",
						"session",
						{
							inputId: "input",
							requestedRunId: joined ? "reservation" : "run",
						},
						{ provider: "claude", metadata: { runId: "run" } },
					),
				);
				const first = canonicalEvent(
					"turn.error",
					"session",
					{
						messageId: "input",
						error: "Project was removed",
						code: "project_inactive",
						retryable: false,
					},
					{
						provider: "claude",
						metadata: { runId: aliasFirst ? "reservation" : "run" },
					},
				);
				const later = canonicalEvent(
					"turn.completed",
					"session",
					{
						messageId: "",
						userMessageId: "input",
						providerCostTotalUsd: 99,
						tokens: { input: 99, output: 99 },
					},
					{
						provider: "claude",
						metadata: { runId: joined && !aliasFirst ? "reservation" : "run" },
					},
				);
				if (delivery === "cleanup") {
					for (let attempt = 0; attempt < 2; attempt++)
						yield* persist.persistUserMessage("session", "Original prompt", {
							inputId: "input",
							messageId: "input",
							runId: "reservation",
							failure: {
								message: "Project was removed",
								code: "project_inactive",
							},
						});
					yield* persist.persistEvent(later);
				} else if (delivery === "batch")
					yield* persist.persistEvents([first, later]);
				else if (delivery === "concurrent")
					yield* Effect.all(
						[persist.persistEvent(first), persist.persistEvent(later)],
						{ concurrency: 2 },
					);
				else {
					yield* persist.persistEvent(first);
					if (aliasFirst)
						yield* persist.persistEvent({ ...first, eventId: createEventId() });
					yield* persist.persistEvent(later);
				}
				const terminals = yield* sql<{ type: string; run_id: string }>`
					SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events
					WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted') ORDER BY sequence`;
				proof["terminals"] = terminals;
				expect(terminals).toEqual(
					aliasFirst
						? [
								{ type: "turn.error", run_id: "reservation" },
								{ type: "turn.completed", run_id: "run" },
							]
						: [{ type: "turn.error", run_id: "run" }],
				);
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ status: aliasFirst ? "completed" : "error" }]);
				const hasAccounting = aliasFirst || !joined;
				expect(
					yield* sql`SELECT state, tokens_in, tokens_out, cost FROM turns`,
				).toEqual([
					{
						state: aliasFirst ? "completed" : "error",
						tokens_in: hasAccounting ? 99 : null,
						tokens_out: hasAccounting ? 99 : null,
						cost: hasAccounting ? 99 : null,
					},
				]);
				proof["outcome"] = "passed";
			}),
		);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/82tn10-4-round3-terminal-${delivery}-${joined}${aliasFirst ? "-alias-first" : ""}.json`,
			`${JSON.stringify(proof, null, 2)}\n`,
		);
	}
});

// A completed run can still receive background messages. Keep their accounting
// without a second run terminal; retrying the same message must not add it twice.
it.each([
	"separate",
	"batch",
	"inline",
] as const)("retains background message accounting after a single run terminal with %s delivery", async (delivery) => {
	const root = mkdtempSync(join(tmpdir(), "background-message-accounting-"));
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(join(root, "events.db"), "test-project"),
	);
	const proof: Record<string, unknown> = { delivery, outcome: "failed" };
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "background", {
						sessionId: "background",
						title: "Background",
						provider: "claude",
					}),
					canonicalEvent("run.requested", "background", {
						runId: "background-run",
						inputId: "input",
					}),
				]);
				yield* persist.persistUserMessage("background", "Original prompt", {
					messageId: "input",
					inputId: "input",
					runId: "background-run",
				});
				const metadata = {
					provider: "claude",
					metadata: { runId: "background-run" },
				};
				yield* persist.persistEvent(
					canonicalEvent(
						"run.started",
						"background",
						{ requestedRunId: "background-run", inputId: "input" },
						metadata,
					),
				);
				const completions = [];
				const pending: CanonicalEvent[] = [];
				for (const [index, total] of [10, 15, 21].entries()) {
					const messageId = `answer-${index}`;
					const created = canonicalEvent(
						"message.created",
						"background",
						{
							sessionId: "background",
							messageId,
							role: "assistant",
							parentID: "input",
						},
						metadata,
					);
					if (delivery !== "inline" || index === 0)
						yield* persist.persistEvent(created);
					const completed = canonicalEvent(
						"turn.completed",
						"background",
						{
							messageId,
							providerCostTotalUsd: total,
							providerSessionId: "native-background",
							contextTokens: (index + 1) * 111,
							tokens: { input: index + 1, output: (index + 1) * 2 },
						},
						metadata,
					);
					completions.push(completed);
					if (delivery === "inline" && index > 0)
						pending.push(created, completed);
				}
				const first = completions[0];
				if (!first) throw new Error("Missing fixture completion");
				yield* persist.persistEvent(first);
				const before =
					yield* sql`SELECT status, completed_at FROM provider_runs WHERE id = 'background-run'`;
				const boundary =
					yield* sql`SELECT last_turn_end_version FROM sessions WHERE id = 'background'`;
				const correction = canonicalEvent(
					"turn.completed",
					"background",
					{
						messageId: "answer-0",
						providerCostTotalUsd: 12,
						providerSessionId: "native-background",
						contextTokens: 444,
						tokens: { input: 4, output: 8 },
					},
					metadata,
				);
				const bare = canonicalEvent(
					"turn.completed",
					"background",
					{
						messageId: "answer-0",
						userMessageId: "input",
						providerCostTotalUsd: 14,
						providerSessionId: "native-background",
						tokens: { input: 5, output: 10 },
					},
					metadata,
				);
				yield* persist.persistEvents([correction, bare]);
				if (delivery === "inline") yield* persist.persistEvents(pending);
				else if (delivery === "batch")
					yield* persist.persistEvents(completions.slice(1));
				else
					for (const completion of completions.slice(1))
						yield* persist.persistEvent(completion);
				expect(
					yield* sql`SELECT COUNT(*) AS count FROM events WHERE type = 'message.completed'`,
				).toEqual([{ count: 4 }]);
				for (const completion of [...completions, correction, bare])
					yield* persist.persistEvent({
						...completion,
						eventId: createEventId(),
					});
				const recorded =
					yield* sql`SELECT type, json_extract(data, '$.messageId') AS message_id,
				json_extract(data, '$.cost') AS cost, json_extract(metadata, '$.runId') AS run_id
				FROM events WHERE type IN ('turn.completed', 'message.completed') ORDER BY sequence`;
				proof["recorded"] = recorded;
				expect(recorded).toEqual([
					{
						type: "turn.completed",
						message_id: "answer-0",
						cost: 10,
						run_id: "background-run",
					},
					{
						type: "message.completed",
						message_id: "answer-0",
						cost: 2,
						run_id: "background-run",
					},
					{
						type: "message.completed",
						message_id: "answer-0",
						cost: 2,
						run_id: "background-run",
					},
					{
						type: "message.completed",
						message_id: "answer-1",
						cost: 1,
						run_id: "background-run",
					},
					{
						type: "message.completed",
						message_id: "answer-2",
						cost: 6,
						run_id: "background-run",
					},
				]);
				expect(
					yield* sql`SELECT id, cost, context_tokens, is_streaming FROM messages WHERE role = 'assistant' ORDER BY id`,
				).toEqual([
					{ id: "answer-0", cost: 12, context_tokens: 444, is_streaming: 0 },
					{ id: "answer-1", cost: 1, context_tokens: 222, is_streaming: 0 },
					{ id: "answer-2", cost: 6, context_tokens: 333, is_streaming: 0 },
				]);
				expect(
					yield* sql`SELECT state, cost, tokens_in, tokens_out FROM turns`,
				).toEqual([
					{ state: "completed", cost: 21, tokens_in: 15, tokens_out: 30 },
				]);
				expect(
					yield* sql`SELECT status, completed_at FROM provider_runs WHERE id = 'background-run'`,
				).toEqual(before);
				expect(
					yield* sql`SELECT last_turn_end_version FROM sessions WHERE id = 'background'`,
				).toEqual(boundary);
				proof["outcome"] = "passed";
			}),
		);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/82tn10-4-round3-background-accounting-${delivery}.json`,
			`${JSON.stringify(proof, null, 2)}\n`,
		);
	}
});
