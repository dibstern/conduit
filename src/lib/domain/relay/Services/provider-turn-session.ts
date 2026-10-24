import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { Account } from "../../../contracts/account.js";
import {
	PROVIDER_DRIVERS,
	type ProviderDriverTraits,
} from "../../../contracts/provider-instance.js";
import { formatErrorDetail } from "../../../errors.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent, createEventId } from "../../../persistence/events.js";
import { ProviderInstanceFailure } from "../../../provider/errors.js";
import {
	ProviderControlPayloadSchema,
	STOP_ABORT_WAIT_MS,
} from "../../../provider/orchestration-command-contracts.js";
import {
	legacyStopOwnersQuery,
	sessionRunOwnersQuery,
} from "../../../provider/session-run-settlement.js";
import { CurrentEventDelivery } from "../../../server/event-delivery.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import {
	PendingInteractionServiceTag,
	type PendingQuestion,
} from "./pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import { CLAUDE_PROVIDER_ID } from "./provider-turn-dispatch.js";
import type {
	ProviderTurnService,
	ProviderTurnServiceInterruptInput,
	ProviderTurnServicePrepareInput,
} from "./provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "./services.js";
import { SessionManagerServiceTag } from "./session-manager-service.js";
import { clearProcessingTimeout } from "./session-overrides-state.js";

export { STOP_ABORT_WAIT_MS };

export const completeRecoveredQuestion = (
	question: PendingQuestion,
	result: string | null,
	answers: Record<string, unknown> = {},
) =>
	Effect.gen(function* () {
		const pending = yield* PendingInteractionServiceTag;
		// Claim retirement before any I/O so racing sends warn only once.
		if (!(yield* pending.markQuestionResolved(question.requestId)))
			return false;
		const readQuery = yield* ReadQueryEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const log = yield* LoggerTag;
		const resolvedEvent = {
			eventId: createEventId(),
			type: "question.resolved" as const,
			providerId: CLAUDE_PROVIDER_ID,
			sessionId: question.sessionId,
			providerRefs: {
				...(question.toolCallId
					? { providerToolUseId: question.toolCallId }
					: {}),
				...(question.providerProcessId
					? { providerProcessId: question.providerProcessId }
					: {}),
				...(question.providerRequestId
					? { providerRequestId: question.providerRequestId }
					: {}),
			},
			rawSource: { kind: "relay.recovered-question" },
			createdAt: Date.now(),
			data: { id: question.providerRequestId ?? question.requestId, answers },
		};
		const completed = yield* Effect.result(
			Effect.gen(function* () {
				// Stored message/part ids can outlive the open tool too.
				const tool =
					question.toolCallId && readQuery.getPendingClaudeQuestionTool
						? yield* readQuery.getPendingClaudeQuestionTool(
								question.sessionId,
								question.toolCallId,
							)
						: undefined;
				if (!tool) return false;
				const completedEvent = {
					...resolvedEvent,
					eventId: createEventId(),
					type: "tool.completed" as const,
					data: {
						messageId: tool.message_id,
						partId: tool.id,
						result,
						duration: 0,
					},
				};
				const events = [completedEvent, resolvedEvent];
				if (question.messageId) {
					// A fresh mapper needs the stored identity before completion.
					yield* ingestion.ingestBatch([
						{
							...completedEvent,
							eventId: createEventId(),
							type: "tool.started",
							data: {
								messageId: tool.message_id,
								partId: tool.id,
								toolName: "AskUserQuestion",
								callId: question.toolCallId,
								input: {
									tool: "AskUserQuestion",
									questions: question.questions,
								},
							},
						},
						...events,
					]);
				} else {
					yield* ingestion.ingestBatch(events);
				}
				return true;
			}),
		);
		if (completed._tag === "Success" && completed.success) return true;
		// Old interaction bookkeeping must never reject a new input. Retire the
		// durable card as well, without recreating or overwriting a closed tool.
		yield* ingestion
			.ingest({
				...resolvedEvent,
				data: { ...resolvedEvent.data, answers: {} },
			})
			.pipe(Effect.ignore);
		log.warn(
			`Recovered Claude question is no longer answerable: session=${question.sessionId} request=${question.requestId} toolCallId=${question.toolCallId ?? "missing"}${completed._tag === "Failure" ? `: ${formatErrorDetail(completed.failure)}` : ""}`,
		);
		return false;
	});

const resolvePendingClaudeQuestions = (
	input: ProviderTurnServicePrepareInput,
	beginStop: ProviderTurnService["beginStop"],
) =>
	Effect.gen(function* () {
		const pendingInteractionService = yield* PendingInteractionServiceTag;
		// A Claude turn blocked on a question never reaches the next message, so
		// replying instead of answering interrupts it and resolves the question.
		// Each path records question.resolved, which takes the card down.
		const pendingQuestions =
			(yield* pendingInteractionService.listPendingQuestions(
				input.sessionId,
			)).filter((question) => question.delivery !== "async");
		for (const question of pendingQuestions) {
			if (!question.recovered) continue;
			yield* completeRecoveredQuestion(question, null);
		}
		if (pendingQuestions.some((question) => !question.recovered)) {
			const stop = {
				clientId: input.clientId,
				sessionId: input.sessionId,
				commandId: `${input.commandId}:interrupt-for-question`,
			};
			yield* yield* beginStop(stop);
		}
	});

const materializeOpenCodeSession = (
	input: ProviderTurnServicePrepareInput,
	account: Account,
	providerId: string,
) =>
	Effect.gen(function* () {
		const orchestrationEngine = yield* OrchestrationEngineTag;
		const log = yield* LoggerTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const readQuery = yield* ReadQueryEffectTag;

		const rowResult = yield* Effect.result(
			readQuery.getSession(input.sessionId),
		);
		if (rowResult._tag === "Failure") {
			log.warn(
				`Could not inspect session provider before OpenCode dispatch for ${input.sessionId}: ${formatErrorDetail(rowResult.failure)}`,
			);
			return input.sessionId;
		}

		const row = rowResult.success;
		if (!row || row.provider === providerId) {
			return input.sessionId;
		}
		const source = yield* (yield* AccountDirectory).resolve({
			_tag: "Id",
			id: row.provider,
		});
		if (PROVIDER_DRIVERS[source.driver].runsOpenCodeServer)
			return input.sessionId;
		const session = yield* sessionManagerService.createSession(row.title, {
			account,
			sourceSessionId: row.id,
		});
		orchestrationEngine.bindSession(session.id, account.id);
		wsHandler.setClientSession(
			input.clientId,
			session.id,
			(yield* ConfigTag).slug,
			yield* CurrentEventDelivery,
		);
		log.info(
			`client=${input.clientId} materialized OpenCode session ${session.id} from local session ${input.sessionId}`,
		);
		return session.id;
	});

export const prepareTurnSession = (
	input: ProviderTurnServicePrepareInput,
	beginStop: ProviderTurnService["beginStop"],
) =>
	Effect.gen(function* () {
		const orchestrationEngine = yield* OrchestrationEngineTag;
		const read = yield* ReadQueryEffectTag;
		const session = yield* read.getSession(input.sessionId);
		const providerId =
			session?.provider ??
			(yield* orchestrationEngine.getProviderForSessionEffect(input.sessionId));
		if (!providerId) return input.sessionId;
		const account = yield* (yield* AccountDirectory).resolve({
			_tag: "Id",
			id: providerId,
		});
		const traits: ProviderDriverTraits = PROVIDER_DRIVERS[account.driver];
		if (
			traits.readOnlySubagents &&
			session?.parent_id &&
			session.side_thread !== 1 &&
			!session.fork_point_event &&
			session.fork_point_message_id == null &&
			session.fork_point_timestamp == null
		)
			return yield* Effect.fail(new Error("Subagent sessions are read-only."));
		if (
			traits.interactionSink === "permission-asking" &&
			input.delivery !== "steer"
		)
			yield* resolvePendingClaudeQuestions(input, beginStop);
		if (traits.runsOpenCodeServer)
			return yield* materializeOpenCodeSession(
				input,
				account,
				providerId ?? account.id,
			).pipe(
				Effect.provideService(OrchestrationEngineTag, orchestrationEngine),
			);
		return input.sessionId;
	});

export const prepareStop = (input: ProviderTurnServiceInterruptInput) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [stored] = yield* sql<{
			payload_json: string;
			provider_id: string;
			requested_at: number;
		}>`SELECT payload_json, provider_id, requested_at
			FROM provider_command_outbox WHERE command_id = ${input.commandId} AND session_id = ${input.sessionId}
			AND effect_type IN ('interrupt_turn', 'end_session')`;
		const replay = stored
			? yield* Effect.try({
					try: () =>
						Schema.decodeSync(
							Schema.fromJsonString(ProviderControlPayloadSchema),
						)(stored.payload_json),
					catch: (cause) =>
						new ProviderInstanceFailure({
							providerId: "conduit",
							operation: "recoverStop",
							cause,
						}),
				})
			: undefined;
		if (
			(replay?.type === "interrupt_turn" || replay?.type === "end_session") &&
			replay.stop
		)
			return replay.stop;
		const deadlineAt = (yield* Clock.currentTimeMillis) + STOP_ABORT_WAIT_MS;
		const commit = yield* makeCommitAndSignal;
		const store = yield* EventStoreEffectTag;
		const providerId =
			stored?.provider_id ??
			(yield* (yield* OrchestrationEngineTag).getProviderForSessionEffect(
				input.sessionId,
			));
		const account = providerId
			? yield* (yield* AccountDirectory).resolve({ _tag: "Id", id: providerId })
			: undefined;
		const keepsPendingSteers = account
			? PROVIDER_DRIVERS[account.driver].keepsPendingSteersOnInterrupt
			: false;
		if (
			stored &&
			(replay?.type === "interrupt_turn" || replay?.type === "end_session")
		) {
			// A predecessor Stop has no snapshot. Recover only its original inputs,
			// without recapturing reservations or changing the immutable payload.
			const turnIds =
				replay.type === "interrupt_turn" ? (replay.turnIds ?? []) : [];
			const owners = yield* legacyStopOwnersQuery(
				sql,
				input.sessionId,
				input.commandId,
			);
			return {
				deadlineAt: stored.requested_at + STOP_ABORT_WAIT_MS,
				owners,
				turnIds,
				runnerBacked:
					account !== undefined &&
					!PROVIDER_DRIVERS[account.driver].runsOpenCodeServer,
				retainedSteers: false,
			};
		}
		// Close unused reservations and return handoffs in one transaction,
		// serialized against the claim UPDATE so the drain cannot steal them.
		const { owners, retainedSteers } = yield* commit.write((project) =>
			Effect.gen(function* () {
				const snapshot = yield* sessionRunOwnersQuery(sql, input.sessionId, {
					confirmedStop: true,
					excludeRetainedSteers: keepsPendingSteers,
				});
				const rows = yield* sql<{
					command_id: string;
					run_id: string;
					provider_id: string;
					status: string;
					sent_sequence: number | null;
				}>`SELECT command.command_id, command.run_id, command.provider_id, command.status,
				(SELECT MAX(sequence) FROM events WHERE session_id = command.session_id
					AND type = 'input.sent' AND json_extract(data, '$.inputId') = command.command_id) AS sent_sequence
				FROM provider_command_outbox command
				WHERE command.session_id = ${input.sessionId} AND command.effect_type = 'send_turn'
					AND command.status IN ('pending', 'retryable_failed')`;
				const events = rows.flatMap((row) => [
					...(row.status === "pending"
						? [
								canonicalEvent(
									"turn.interrupted",
									input.sessionId,
									{
										messageId: "",
										reason: "Stopped before delivery",
										code: "interrupted",
									},
									{
										provider: row.provider_id,
										metadata: { runId: row.run_id },
									},
								),
							]
						: []),
					...(row.sent_sequence === null
						? []
						: [
								canonicalEvent(
									"input.requeued",
									input.sessionId,
									{
										sessionId: input.sessionId,
										inputId: row.command_id,
										sentSequence: row.sent_sequence,
										reason: "failed",
									},
									{ metadata: { runId: row.run_id } },
								),
							]),
				]);
				if (events.length) yield* project(yield* store.appendBatch(events));
				// These attempts already ended through their native terminal. Return
				// their retry schedule to the inbox, as recommit would withdraw it.
				yield* sql`DELETE FROM provider_command_outbox WHERE session_id = ${input.sessionId}
					AND effect_type = 'send_turn' AND status = 'retryable_failed'`;
				return snapshot;
			}),
		);

		const identities =
			owners.length === 0
				? []
				: yield* sql<{ input_id: string | null }>`
			SELECT COALESCE(json_extract(command.payload_json, '$.continuation.cutOffMessageId'),
				json_extract(command.payload_json, '$.inputId'), command.command_id) AS input_id
			FROM provider_command_outbox command JOIN provider_runs requested
				ON requested.id = command.run_id AND requested.session_id = command.session_id
			WHERE command.session_id = ${input.sessionId} AND command.effect_type = 'send_turn'
				AND command.status = 'running' AND COALESCE(requested.joined_into, requested.id)
				IN ${sql.in(owners.map(({ runId }) => runId))}
			UNION SELECT COALESCE(message.input_id, turn.user_message_id) AS input_id
			FROM turns turn LEFT JOIN messages message
				ON message.id = turn.user_message_id AND message.session_id = turn.session_id
			WHERE turn.session_id = ${input.sessionId}
				AND turn.run_id IN ${sql.in(owners.map(({ runId }) => runId))}`;
		return {
			deadlineAt,
			runnerBacked:
				account !== undefined &&
				!PROVIDER_DRIVERS[account.driver].runsOpenCodeServer,
			owners,
			retainedSteers,
			turnIds: [
				...new Set(
					identities.flatMap(({ input_id }) => (input_id ? [input_id] : [])),
				),
			],
		};
	});

export const interruptTurn = (
	input: ProviderTurnServiceInterruptInput,
	snapshot: Effect.Success<ReturnType<typeof prepareStop>>,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		log.info(`client=${input.clientId} session=${input.sessionId} Aborting`);
		yield* clearProcessingTimeout(input.sessionId);
		const sql = yield* SqlClient.SqlClient;

		const engine = yield* OrchestrationEngineTag;
		const [stored] = yield* sql<{
			payload_json: string;
		}>`SELECT payload_json FROM provider_command_outbox
			WHERE command_id = ${input.commandId} AND session_id = ${input.sessionId}
			AND effect_type IN ('interrupt_turn', 'end_session')`;
		if (stored) {
			const payload = yield* Effect.try({
				try: () =>
					Schema.decodeSync(
						Schema.fromJsonString(ProviderControlPayloadSchema),
					)(stored.payload_json),
				catch: (cause) =>
					new ProviderInstanceFailure({
						providerId: "conduit",
						operation: "recoverStop",
						cause,
					}),
			});
			yield* engine.dispatchEffect({ ...payload, commandId: input.commandId });
			return;
		}
		const providerId = yield* engine.getProviderForSessionEffect(
			input.sessionId,
		);
		const account = providerId
			? yield* (yield* AccountDirectory).resolve({ _tag: "Id", id: providerId })
			: undefined;
		const usesOpenCode =
			!account || PROVIDER_DRIVERS[account.driver].runsOpenCodeServer;
		if (
			account &&
			!usesOpenCode &&
			!PROVIDER_DRIVERS[account.driver].interruptViaEngine
		)
			return;
		const fullStop =
			!usesOpenCode &&
			(yield* sql<{
				indeterminate: number;
			}>`
				SELECT EXISTS (SELECT 1 FROM provider_command_outbox command
					JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id
					WHERE command.session_id = ${input.sessionId} AND command.effect_type = 'send_turn'
					AND command.status = 'running' AND command.error_code = 'delivery_indeterminate'
						AND run.id IN ${sql.in(snapshot.owners.map(({ runId }) => runId))}
					AND run.status IN ('pending', 'running')) AS indeterminate`)[0]
				?.indeterminate === 1;
		const interruptResult = yield* Effect.result(
			engine.dispatchEffect({
				type: fullStop ? "end_session" : "interrupt_turn",
				...(!fullStop ? { turnIds: snapshot.turnIds } : {}),
				commandId: input.commandId,
				sessionId: input.sessionId,
				stop: snapshot,
			}),
		);
		const processGone =
			interruptResult._tag === "Failure" &&
			interruptResult.failure._tag === "ProviderInstanceFailure" &&
			interruptResult.failure.code === "provider_process_gone";
		if (interruptResult._tag === "Failure" && !processGone) {
			log.warn(
				`client=${input.clientId} session=${input.sessionId} engine interrupt_turn failed:`,
				formatErrorDetail(interruptResult.failure),
			);
			return yield* Effect.fail(interruptResult.failure);
		}
		// Acknowledgement confirms delivery. Terminals and the runner's
		// confirmed-exit path own settlement, including a full Stop.
	});
