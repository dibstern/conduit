import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { HandoffReceiptsLive } from "../../../src/lib/domain/relay/Services/handoff-receipts.js";
import {
	type SessionEventBus,
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { sendPreparedClaudeTurn } from "../../../src/lib/provider/claude/prepare-turn.js";

describe("ClaudeEventPersistEffect session lifecycle", () => {
	for (const terminal of [
		"turn.completed",
		"turn.interrupted",
		"turn.error",
	] as const) {
		it.effect(`records a handoff only after its owned ${terminal}`, () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const persist = yield* ClaudeEventPersistEffectTag;
				const commit = yield* makeCommitAndSignal;
				const handoff = {
					included: 2,
					omitted: 0,
					tokens: 8,
					instanceId: "personal",
				};
				yield* commit([
					canonicalEvent("session.created", "handoff", {
						sessionId: "handoff",
						provider: "claude",
						title: "Handoff",
					}),
					canonicalEvent(
						"run.requested",
						"handoff",
						{ runId: "handoff-run", inputId: "handoff-input" },
						{ metadata: { runId: "handoff-run" }, provider: "claude" },
					),
					canonicalEvent(
						"message.created",
						"handoff",
						{
							sessionId: "handoff",
							messageId: "handoff-input",
							inputId: "handoff-input",
							role: "user",
						},
						{ metadata: { runId: "handoff-run" }, provider: "claude" },
					),
				]);
				// A catch-up held past a slash command ends only with this delivery.
				yield* sql`INSERT INTO provider_state (session_id, key, value)
					VALUES ('handoff', 'claude.heldCatchUp:personal', '0')`;
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
					VALUES ('handoff-command', 'handoff', 'side_effect_requested', 1, 'send_turn', 'test-project', 'hash', 1, 1, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'handoff-command', 'test-project', 'handoff', 'claude', 'send_turn', ${JSON.stringify({ handoff })}, 'handoff-run', 'running', 1, 1, 1)`;
				yield* commit([
					canonicalEvent(
						"run.started",
						"handoff",
						{ inputId: "handoff-input", requestedRunId: "handoff-run" },
						{ metadata: { runId: "handoff-run" }, provider: "claude" },
					),
				]);
				// Intake is not a successful handoff, including when recovery observes it.
				if (terminal === "turn.completed") {
					yield* sendPreparedClaudeTurn({
						sessionId: "handoff",
						instanceId: "personal",
						commandId: "handoff-command",
						userText: "Original prompt",
						options: {
							folderSource: "account",
							configDir: configuredClaudeConfigDir("/accounts/personal"),
							liveSession: {
								instanceId: "personal",
								configDir: configuredClaudeConfigDir("/accounts/personal"),
								resumeSessionId: "live-handoff",
							},
						},
						send: (prepared) =>
							Effect.sync(() => {
								expect(prepared.resumeSessionId).toBe("live-handoff");
								expect(prepared.handoff).toBeUndefined();
								return undefined;
							}),
					});
				}
				yield* persist.persistHandoffDelivered(
					"handoff",
					handoff,
					"handoff-command",
				);
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'session.handoff_delivered'`,
				).toEqual([]);
				expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "running" },
				]);
				// Recovery publishes the same bare, owned terminal; no result callback is needed.
				const end = canonicalEvent(
					terminal,
					"handoff",
					{
						messageId: "",
						...(terminal === "turn.error"
							? { error: "Runner exited", code: "runner_exited" }
							: {}),
					},
					{ metadata: { runId: "handoff-run" }, provider: "claude" },
				);
				yield* commit([end]);
				yield* Effect.yieldNow;
				yield* Effect.yieldNow;
				const status =
					terminal === "turn.completed"
						? "completed"
						: terminal === "turn.error"
							? "error"
							: "interrupted";
				expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
					{ status },
				]);
				expect(yield* sql`SELECT state, run_id FROM turns`).toEqual([
					{ state: status, run_id: "handoff-run" },
				]);
				expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
					{ status: status === "completed" ? "completed" : "failed" },
				]);
				expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
					{
						status:
							status === "completed"
								? "side_effect_completed"
								: "side_effect_failed",
					},
				]);
				expect(
					yield* sql`SELECT value FROM provider_state WHERE key = 'claude.heldCatchUp:personal'`,
				).toEqual(terminal === "turn.completed" ? [] : [{ value: "0" }]);
				const receipts =
					yield* sql`SELECT type, data FROM events WHERE type = 'session.handoff_delivered'`;
				expect(receipts).toEqual(
					terminal === "turn.completed"
						? [
								{
									type: "session.handoff_delivered",
									data: JSON.stringify(handoff),
								},
							]
						: [],
				);
				// Replaying the same end or recovery callback cannot write a second receipt.
				yield* persist.persistHandoffDelivered(
					"handoff",
					handoff,
					"handoff-command",
				);
				expect(
					(yield* sql`SELECT type FROM events WHERE type = 'session.handoff_delivered'`)
						.length,
				).toBe(terminal === "turn.completed" ? 1 : 0);
			}).pipe(
				Effect.provide(
					HandoffReceiptsLive.pipe(
						Layer.provideMerge(
							Layer.merge(
								makePersistenceEffectLayer(":memory:", "test-project"),
								SessionEventBusLive,
							),
						),
					),
				),
			),
		);
	}
	it.effect(
		"checks successful handoff completion inside its append transaction",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const persist = yield* ClaudeEventPersistEffectTag;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "handoff-race", {
						sessionId: "handoff-race",
						provider: "claude",
						title: "Handoff race",
					}),
				]);
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
				VALUES ('handoff-race-command', 'handoff-race', 'side_effect_completed', 1, 'send_turn', 'test-project', 'hash', 1, 1, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'handoff-race-command', 'test-project', 'handoff-race', 'claude', 'send_turn', '{}', 'completed', 1, 1, 1)`;
				const withTransaction = sql.withTransaction;
				// A command's status changes before this append acquires its transaction.
				const transaction = vi
					.spyOn(sql, "withTransaction")
					.mockImplementation((body) =>
						withTransaction(
							sql`UPDATE provider_command_outbox SET status = 'failed' WHERE command_id = 'handoff-race-command'`.pipe(
								Effect.andThen(body),
							),
						),
					);
				yield* persist
					.persistHandoffDelivered(
						"handoff-race",
						{ included: 1, omitted: 0, tokens: 8 },
						"handoff-race-command",
					)
					.pipe(Effect.ensuring(Effect.sync(() => transaction.mockRestore())));
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'session.handoff_delivered'`,
				).toEqual([]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
	);
	for (const rejectTerminal of [false, true]) {
		it.effect(
			`places an admission failure atomically (reject terminal: ${rejectTerminal})`,
			() =>
				Effect.gen(function* () {
					const persist = yield* ClaudeEventPersistEffectTag;
					const sql = yield* SqlClient.SqlClient;
					const runner = yield* ProjectionRunnerEffectTag;
					const eventStore = yield* EventStoreEffectTag;
					yield* runner.recover();
					yield* runner.projectEvent(
						yield* eventStore.append(
							canonicalEvent("session.created", "failed", {
								sessionId: "failed",
								title: "Failed admission",
								provider: "claude",
							}),
						),
					);
					if (rejectTerminal)
						yield* sql.unsafe(`CREATE TRIGGER reject_failure BEFORE UPDATE OF status ON provider_runs
						WHEN NEW.status = 'error' BEGIN SELECT RAISE(ABORT, 'reject failure'); END`);
					const result = yield* Effect.result(
						persist.persistUserMessage("failed", "Cannot send", {
							messageId: "failed-user",
							inputId: "failed-input",
							images: ["data:image/png;base64,aW1hZ2U="],
							failure: { message: "Missing folder", code: "SEND_FAILED" },
						}),
					);
					if (rejectTerminal) {
						expect(result._tag).toBe("Failure");
						expect(yield* sql`SELECT id FROM provider_runs`).toEqual([]);
						expect(yield* sql`SELECT id FROM messages`).toEqual([]);
						expect(
							yield* sql`SELECT type FROM events WHERE type <> 'session.created'`,
						).toEqual([]);
					} else {
						expect(result._tag).toBe("Success");
						yield* persist.persistUserMessage("failed", "Cannot send", {
							messageId: "failed-user",
							inputId: "failed-input",
							failure: { message: "Missing folder", code: "SEND_FAILED" },
						});
						expect(
							yield* sql`SELECT type FROM events WHERE type = 'turn.error'`,
						).toEqual([{ type: "turn.error" }]);
						expect(
							yield* sql`SELECT status, started_at FROM provider_runs`,
						).toEqual([{ status: "error", started_at: null }]);
						expect(
							yield* sql`SELECT state, run_id, started_at FROM turns`,
						).toEqual([
							{ state: "error", run_id: expect.any(String), started_at: null },
						]);
						expect(
							yield* sql`SELECT type FROM events WHERE type = 'run.requested'`,
						).toEqual([{ type: "run.requested" }]);
						expect(
							yield* sql`SELECT type FROM message_parts ORDER BY type`,
						).toEqual([{ type: "error" }, { type: "file" }, { type: "text" }]);
					}
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
		);
	}
	for (const echoBeforeFailure of [false, true]) {
		it.effect(
			`settles a reserved send failure without duplicating placement (native echo: ${echoBeforeFailure})`,
			() =>
				Effect.gen(function* () {
					const persist = yield* ClaudeEventPersistEffectTag;
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "failed-send", {
							sessionId: "failed-send",
							provider: "claude",
							title: "Failed send",
						}),
						canonicalEvent("run.requested", "failed-send", {
							runId: "failed-run",
							inputId: "failed-input",
						}),
					]);
					yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
						VALUES ('failed-input', 'failed-send', 'side_effect_requested', 1, 'send_turn', 'test-project', 'hash', 1, 1, 1)`;
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
						VALUES (1, 'failed-input', 'test-project', 'failed-send', 'claude', 'send_turn', '{}', 'failed-run', 'running', 1, 1, 1)`;
					if (echoBeforeFailure) {
						yield* commit([
							canonicalEvent(
								"message.created",
								"failed-send",
								{
									messageId: "native-user",
									inputId: "failed-input",
									role: "user",
									sessionId: "failed-send",
								},
								{ provider: "claude", metadata: { runId: "failed-run" } },
							),
							canonicalEvent("text.delta", "failed-send", {
								messageId: "native-user",
								partId: "native-user-0",
								text: "Native body",
							}),
						]);
					}
					for (let cleanup = 0; cleanup < 2; cleanup++)
						yield* persist.persistUserMessage("failed-send", "Local body", {
							messageId: "local-user",
							inputId: "failed-input",
							runId: "failed-run",
							failure: { message: "Send failed", code: "SEND_FAILED" },
						});
					expect(
						yield* sql`SELECT status, started_at FROM provider_runs`,
					).toEqual([{ status: "error", started_at: null }]);
					expect(
						yield* sql`SELECT state, run_id, started_at FROM turns`,
					).toEqual([
						{ state: "error", run_id: "failed-run", started_at: null },
					]);
					expect(
						yield* sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "failed" }]);
					expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
						{ status: "side_effect_failed" },
					]);
					expect(
						yield* sql`SELECT type FROM events WHERE type IN ('run.requested', 'message.created', 'turn.error') ORDER BY sequence`,
					).toEqual([
						{ type: "run.requested" },
						{ type: "message.created" },
						{ type: "turn.error" },
					]);
					expect(
						yield* sql`SELECT id, text FROM messages WHERE role = 'user'`,
					).toEqual([
						{
							id: echoBeforeFailure ? "native-user" : "local-user",
							text: echoBeforeFailure ? "Native body" : "Local body",
						},
					]);
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
		);
	}

	for (const joined of [false, true]) {
		it.effect(
			`failure cleanup preserves a completed run and places its missing turn (joined: ${joined})`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const persist = yield* ClaudeEventPersistEffectTag;
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "finished", {
							sessionId: "finished",
							title: "Finished",
							provider: "claude",
						}),
						canonicalEvent("run.requested", "finished", {
							runId: "finished-run",
							inputId: "input",
						}),
						...(joined
							? [
									canonicalEvent("run.requested", "finished", {
										runId: "reservation",
										inputId: "input",
									}),
									canonicalEvent(
										"run.started",
										"finished",
										{ inputId: "input", requestedRunId: "reservation" },
										{ provider: "claude", metadata: { runId: "finished-run" } },
									),
								]
							: []),
						canonicalEvent(
							"turn.completed",
							"finished",
							{ messageId: "answer" },
							{ provider: "claude", metadata: { runId: "finished-run" } },
						),
					]);
					for (let cleanup = 0; cleanup < 2; cleanup++)
						yield* persist.persistUserMessage("finished", "Original prompt", {
							messageId: "input",
							inputId: "input",
							runId: joined ? "reservation" : "finished-run",
							failure: {
								message: "Transport failure after completion",
								code: "SEND_FAILED",
							},
						});
					expect(yield* sql`SELECT state, run_id FROM turns`).toEqual([
						{ state: "completed", run_id: "finished-run" },
					]);
					expect(
						yield* sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error')`,
					).toEqual([{ type: "turn.completed" }]);
					expect(
						yield* sql`SELECT type FROM message_parts WHERE type = 'error'`,
					).toEqual([]);
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
		);
	}

	for (const deadRef of ["child", "parent"] as const) {
		it.effect(`refuses subagent creation with a dead ${deadRef}`, () => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-born-dead-"));
			const layer = makePersistenceEffectLayer(
				join(dir, "events.db"),
				"test-project",
			);
			return Effect.gen(function* () {
				const eventStore = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.recover();
				const parentId = "born-dead-parent";
				const childId = "born-dead-child";
				const parent = yield* eventStore.append(
					canonicalEvent("session.created", parentId, {
						sessionId: parentId,
						title: "Parent",
						provider: "claude",
					}),
				);
				yield* runner.projectEvent(parent);
				yield* sql`UPDATE sessions SET model_id = 'sonnet', model_provider = 'claude',
					variant = '', context_window = '' WHERE id = ${parentId}`;
				const deletedId = deadRef === "child" ? childId : parentId;
				if (deadRef === "child") {
					yield* sql`INSERT INTO sessions
						(id, project_id, provider, provider_sid, parent_id, title, status, created_at, updated_at)
						VALUES (${childId}, 'test-project', 'claude', 'sdk-child', ${parentId}, 'Stale child', 'idle', 1, 1)`;
				}
				// Leave the row stale to prove the marker is the death authority.
				yield* eventStore.append(
					canonicalEvent("session.deleted", deletedId, {
						sessionId: deletedId,
					}),
				);
				const before =
					yield* sql`SELECT event_id FROM events ORDER BY sequence`;

				const result = yield* Effect.result(
					persist.ensureClaudeSubagentSession({
						childSessionId: childId,
						parentSessionId: parentId,
						providerSessionId: "sdk-child",
						title: "Must stay dead",
					}),
				);

				expect(result).toMatchObject({
					_tag: "Failure",
					failure: {
						_tag: "ClaudeSessionLifecycleError",
						operation: "ensureClaudeSubagentSession",
						sessionId: deletedId,
						role: `subagent-${deadRef}`,
						reason: "missing-session",
					},
				});
				expect(
					yield* sql`SELECT event_id FROM events ORDER BY sequence`,
				).toEqual(before);
				if (deadRef === "parent")
					expect(
						yield* sql`SELECT id FROM sessions WHERE id = ${childId}`,
					).toEqual([]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		});
	}

	for (const method of ["persistEvent", "persistEvents"] as const) {
		it.effect(`refuses ${method} creation from a dead fork source`, () => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-dead-source-"));
			const layer = makePersistenceEffectLayer(
				join(dir, "events.db"),
				"test-project",
			);
			return Effect.gen(function* () {
				const eventStore = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.recover();
				for (const id of ["existing-child", "dead-source"]) {
					const created = yield* eventStore.append(
						canonicalEvent("session.created", id, {
							sessionId: id,
							title: id,
							provider: "claude",
						}),
					);
					yield* runner.projectEvent(created);
				}
				yield* eventStore.append(
					canonicalEvent("session.deleted", "dead-source", {
						sessionId: "dead-source",
					}),
				);
				const before =
					yield* sql`SELECT event_id FROM events ORDER BY sequence`;
				const event = canonicalEvent("session.created", "existing-child", {
					sessionId: "existing-child",
					title: "Must stay dead",
					provider: "claude",
					forkedFrom: "dead-source",
				});
				const result = yield* Effect.result(
					method === "persistEvent"
						? persist.persistEvent(event)
						: persist.persistEvents([event]),
				);

				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "ClaudeSessionLifecycleError" },
				});
				expect(
					yield* sql`SELECT event_id FROM events ORDER BY sequence`,
				).toEqual(before);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		});
	}

	it.effect(
		"reuses the user body while placing a fresh retry reservation exactly once",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const persist = yield* ClaudeEventPersistEffectTag;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent("session.created", "retry", {
							sessionId: "retry",
							title: "Retry",
							provider: "claude",
						}),
					),
				);
				yield* persist.persistEvents([
					canonicalEvent("run.requested", "retry", {
						runId: "r1",
						inputId: "input",
					}),
				]);
				yield* persist.persistUserMessage("retry", "original body", {
					messageId: "original-message",
					inputId: "input",
					runId: "r1",
				});
				const before =
					yield* sql`SELECT id, text, created_at FROM messages WHERE session_id = 'retry' AND role = 'user'`;
				yield* persist.persistEvents([
					canonicalEvent(
						"turn.error",
						"retry",
						{ messageId: "", error: "first attempt failed" },
						{ provider: "claude", metadata: { runId: "r1" } },
					),
					canonicalEvent("run.requested", "retry", {
						runId: "r2",
						inputId: "input",
					}),
				]);
				yield* persist.persistUserMessage(
					"retry",
					"must not append another body",
					{ messageId: "another-candidate", inputId: "input", runId: "r2" },
				);
				expect(
					yield* sql`SELECT state, run_id, started_at, completed_at FROM turns WHERE user_message_id = 'original-message'`,
				).toEqual([
					{
						state: "pending",
						run_id: "r2",
						started_at: null,
						completed_at: null,
					},
				]);
				expect(
					yield* sql`SELECT id, text, created_at FROM messages WHERE session_id = 'retry' AND role = 'user'`,
				).toEqual(before);
				expect(
					yield* sql`SELECT text FROM message_parts WHERE message_id = 'original-message'`,
				).toEqual([{ text: "original body" }]);
				const placed = yield* store.readBySession("retry");
				expect(
					placed.filter((event) => event.type === "message.created"),
				).toHaveLength(2);
				expect(
					placed.filter((event) => event.type === "text.delta"),
				).toHaveLength(1);
				yield* persist.persistUserMessage("retry", "duplicate body", {
					inputId: "input",
					runId: "r2",
				});
				expect((yield* store.readBySession("retry")).length).toBe(
					placed.length,
				);
				yield* persist.persistEvents([
					canonicalEvent("run.requested", "retry", {
						runId: "joined",
						inputId: "input",
					}),
					canonicalEvent(
						"run.started",
						"retry",
						{ requestedRunId: "joined", inputId: "input" },
						{ metadata: { runId: "r2" } },
					),
				]);
				const joined = yield* store.readBySession("retry");
				yield* persist.persistUserMessage("retry", "joined duplicate", {
					messageId: "another-candidate",
					inputId: "input",
					runId: "joined",
				});
				expect((yield* store.readBySession("retry")).length).toBe(
					joined.length,
				);
				expect(
					yield* sql`SELECT id, text, created_at FROM messages WHERE session_id = 'retry' AND role = 'user'`,
				).toEqual(before);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project"), {
					local: true,
				}),
			),
	);

	it.effect(
		"omits empty user deltas without losing attachments or nonempty text",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-empty-delta-"));
			const layer = makePersistenceEffectLayer(
				join(dir, "events.db"),
				"test-project",
			);
			const sessionId = "attachment-session";

			return Effect.gen(function* () {
				const eventStore = yield* EventStoreEffectTag;
				const projectionRunner = yield* ProjectionRunnerEffectTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* projectionRunner.recover();
				const created = yield* eventStore.append(
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: "Attachments",
						provider: "claude",
						providerSessionId: "sdk-session",
					}),
				);
				yield* projectionRunner.projectEvent(created);
				yield* persist.persistUserMessage(sessionId, "", {
					messageId: "image-message",
				});
				yield* persist.persistEvent(
					canonicalEvent("file.attached", sessionId, {
						messageId: "image-message",
						partId: "image-part",
						mime: "image/png",
						url: "data:image/png;base64,aW1hZ2U=",
					}),
				);
				yield* persist.persistUserMessage(sessionId, "Hello", {
					messageId: "text-message",
				});
				yield* persist.persistUserMessage(sessionId, " ", {
					messageId: "space-message",
				});
				const events = yield* eventStore.readBySession(sessionId);
				expect(
					events
						.filter((event) => event.type !== "session.created")
						.map((event) => ({ type: event.type, data: event.data })),
				).toEqual([
					{
						type: "message.created",
						data: { messageId: "image-message", role: "user", sessionId },
					},
					{
						type: "file.attached",
						data: {
							messageId: "image-message",
							partId: "image-part",
							mime: "image/png",
							url: "data:image/png;base64,aW1hZ2U=",
						},
					},
					{
						type: "message.created",
						data: { messageId: "text-message", role: "user", sessionId },
					},
					{
						type: "text.delta",
						data: {
							messageId: "text-message",
							partId: "text-message-0",
							text: "Hello",
						},
					},
					{
						type: "message.created",
						data: { messageId: "space-message", role: "user", sessionId },
					},
					{
						type: "text.delta",
						data: {
							messageId: "space-message",
							partId: "space-message-0",
							text: " ",
						},
					},
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"preserves delayed authoritative OpenCode ownership during user-message persistence",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-interleaving-"));
			const filename = join(dir, "events.db");
			const layer = makePersistenceEffectLayer(filename, "test-project");
			const sessionId = "interleaved-opencode-session";

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const eventStore = yield* EventStoreEffectTag;
				const projectionRunner = yield* ProjectionRunnerEffectTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* projectionRunner.recover();
				yield* sql`
				INSERT INTO sessions (
					id, project_id, provider, provider_sid, title, status, created_at, updated_at
				) VALUES (
					${sessionId}, 'test-project', 'opencode', ${sessionId}, 'OpenCode Session', 'idle', 1, 1
				)`;
				const delayedCreation = yield* eventStore.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "OpenCode Session",
							provider: "opencode",
							providerSessionId: sessionId,
						},
						{ provider: "opencode", createdAt: 2 },
					),
				);

				yield* persist.persistUserMessage(sessionId, "switch to Claude");
				yield* projectionRunner.projectEvent(delayedCreation);

				const sessions = yield* sql<{
					readonly provider: string;
					readonly provider_sid: string | null;
				}>`SELECT provider, provider_sid FROM sessions WHERE id = ${sessionId}`;
				const creations = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM events
				WHERE session_id = ${sessionId} AND type = 'session.created'`;
				const bindings = yield* sql<{
					readonly id: string;
					readonly provider: string;
				}>`
				SELECT id, provider FROM session_providers
				WHERE session_id = ${sessionId} AND status = 'active'`;

				expect(sessions).toEqual([
					{ provider: "opencode", provider_sid: sessionId },
				]);
				expect(creations[0]?.count).toBe(1);
				expect(bindings).toEqual([
					{ id: `${sessionId}:initial`, provider: "opencode" },
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"rejects a user message for a missing session without writing or publishing",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-lifecycle-"));
			const filename = join(dir, "events.db");
			const publish = vi.fn(() => Effect.void);
			const busLayer = Layer.succeed(SessionEventBusTag)({
				publish,
				publishAdvance: () => Effect.void,
				subscribe: () => Effect.succeed(Stream.empty),
				subscribeAdvances: () =>
					Effect.die(new Error("unused test subscription")),
			} satisfies SessionEventBus);
			const layer = makePersistenceEffectLayer(
				filename,
				"test-project",
				undefined,
				busLayer,
			);

			return Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const result = yield* Effect.result(
					persist.persistUserMessage("missing-session", "hello"),
				);
				const sql = yield* SqlClient.SqlClient;
				const sessionRows = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM sessions WHERE id = 'missing-session'`;
				const eventRows = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM events WHERE session_id = 'missing-session'`;

				expect(result).toMatchObject({
					_tag: "Failure",
					failure: expect.objectContaining({
						_tag: "ClaudeSessionLifecycleError",
						operation: "persistUserMessage",
						sessionId: "missing-session",
						role: "existing-session",
						reason: "missing-session",
					}),
				});
				expect(sessionRows[0]?.count).toBe(0);
				expect(eventRows[0]?.count).toBe(0);
				expect(publish).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"rejects a raw-only session row without a durable creation event",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-raw-only-"));
			const filename = join(dir, "events.db");
			const layer = makePersistenceEffectLayer(filename, "test-project");
			const sessionId = "legacy-raw-only-session";

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* sql`
					INSERT INTO sessions (
						id, provider, provider_sid, title, status, created_at, updated_at
					) VALUES (
						${sessionId}, 'opencode', ${sessionId}, 'Legacy raw seed', 'idle', 1, 1
					)`;

				const result = yield* Effect.result(
					persist.persistUserMessage(sessionId, "must not dispatch"),
				);
				const events = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events WHERE session_id = ${sessionId}`;

				expect(result).toMatchObject({
					_tag: "Failure",
					failure: expect.objectContaining({
						_tag: "ClaudeSessionLifecycleError",
						operation: "persistUserMessage",
						sessionId,
						role: "existing-session",
						reason: "missing-session",
					}),
				});
				expect(events[0]?.count).toBe(0);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"rejects an ordinary content event for a raw-only session row",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-raw-content-"));
			const filename = join(dir, "events.db");
			const layer = makePersistenceEffectLayer(filename, "test-project");
			const sessionId = "legacy-raw-content-session";

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* sql`
					INSERT INTO sessions (
						id, provider, provider_sid, title, status, created_at, updated_at
					) VALUES (
						${sessionId}, 'opencode', ${sessionId}, 'Legacy raw seed', 'idle', 1, 1
					)`;

				const result = yield* Effect.result(
					persist.persistEvent(
						canonicalEvent(
							"message.created",
							sessionId,
							{
								messageId: "raw-content-message",
								role: "user",
								sessionId,
							},
							{ provider: "claude" },
						),
					),
				);
				const events = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events WHERE session_id = ${sessionId}`;

				expect(result).toMatchObject({
					_tag: "Failure",
					failure: expect.objectContaining({
						_tag: "ClaudeSessionLifecycleError",
						operation: "persistEvent",
						sessionId,
						role: "existing-session",
						reason: "missing-session",
					}),
				});
				expect(events[0]?.count).toBe(0);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"deletes an existing session but rejects a missing compatibility delete",
		() => {
			const dir = mkdtempSync(
				join(tmpdir(), "conduit-claude-event-lifecycle-"),
			);
			const filename = join(dir, "events.db");
			const layer = makePersistenceEffectLayer(filename, "test-project");

			return Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const eventStore = yield* EventStoreEffectTag;
				const projectionRunner = yield* ProjectionRunnerEffectTag;
				yield* projectionRunner.recover();
				const existingCreation = yield* eventStore.append(
					canonicalEvent(
						"session.created",
						"existing-delete-session",
						{
							sessionId: "existing-delete-session",
							title: "Existing",
							provider: "claude",
						},
						{ provider: "claude" },
					),
				);
				yield* projectionRunner.projectEvent(existingCreation);
				yield* persist.persistEvent(
					canonicalEvent(
						"session.deleted",
						"existing-delete-session",
						{ sessionId: "existing-delete-session" },
						{ provider: "claude" },
					),
				);
				const result = yield* Effect.result(
					persist.persistEvent(
						canonicalEvent(
							"session.deleted",
							"missing-event-session",
							{ sessionId: "missing-event-session" },
							{ provider: "claude" },
						),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				const sessions = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM sessions WHERE id = 'missing-event-session'`;
				const events = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM events WHERE session_id = 'missing-event-session'`;
				const existingSessions = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM sessions WHERE id = 'existing-delete-session'`;
				const existingEvents = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM events WHERE session_id = 'existing-delete-session'`;

				expect(result).toMatchObject({
					_tag: "Failure",
					failure: expect.objectContaining({
						_tag: "ClaudeSessionLifecycleError",
						operation: "persistEvent",
						sessionId: "missing-event-session",
						role: "existing-session",
						reason: "missing-session",
					}),
				});
				expect(sessions[0]?.count).toBe(0);
				expect(events[0]?.count).toBe(0);
				expect(existingSessions[0]?.count).toBe(0);
				expect(existingEvents[0]?.count).toBe(2);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
});
