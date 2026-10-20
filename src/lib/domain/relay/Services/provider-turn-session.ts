import { Effect } from "effect";
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
import {
	sessionRunOwnersQuery,
	settleSessionRuns,
} from "../../../provider/session-run-settlement.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import {
	PendingInteractionServiceTag,
	type PendingQuestion,
} from "./pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import { CLAUDE_PROVIDER_ID } from "./provider-turn-dispatch.js";
import type {
	ProviderTurnServiceInterruptInput,
	ProviderTurnServicePrepareInput,
} from "./provider-turn-service.js";
import {
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "./services.js";
import { SessionManagerServiceTag } from "./session-manager-service.js";
import { clearProcessingTimeout } from "./session-overrides-state.js";
import { SessionWorkspaceTag } from "./session-workspace.js";

export const completeRecoveredQuestion = (
	question: PendingQuestion,
	result: string | null,
	answers: Record<string, unknown> = {},
) =>
	Effect.gen(function* () {
		let messageId = question.messageId;
		let partId = question.partId ?? question.toolCallId ?? question.requestId;
		if (!messageId) {
			const readQuery = yield* ReadQueryEffectTag;
			const tool = readQuery.getPendingClaudeQuestionTool
				? yield* readQuery.getPendingClaudeQuestionTool(
						question.sessionId,
						question.toolCallId ?? question.requestId,
					)
				: undefined;
			if (!tool)
				return yield* Effect.fail(
					new Error(
						`Pending Claude question tool not found: ${question.requestId}`,
					),
				);
			messageId = tool.message_id;
			partId = tool.id;
		}
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const completedEvent = {
			eventId: createEventId(),
			type: "tool.completed" as const,
			providerId: CLAUDE_PROVIDER_ID,
			sessionId: question.sessionId,
			providerRefs: {
				providerToolUseId: question.toolCallId ?? question.requestId,
			},
			rawSource: { kind: "relay.recovered-question" },
			createdAt: Date.now(),
			data: {
				messageId,
				partId,
				result,
				duration: 0,
			},
		};
		const resolvedEvent = {
			...completedEvent,
			eventId: createEventId(),
			type: "question.resolved" as const,
			providerRefs: {
				...completedEvent.providerRefs,
				...(question.providerProcessId
					? { providerProcessId: question.providerProcessId }
					: {}),
				...(question.providerRequestId
					? { providerRequestId: question.providerRequestId }
					: {}),
			},
			data: { id: question.providerRequestId ?? question.requestId, answers },
		};
		if (question.messageId) {
			// A fresh mapper has not seen the stored tool start. Seed its identity
			// so completion updates the existing card without an Unknown tool.
			yield* ingestion.ingestBatch([
				{
					...completedEvent,
					eventId: createEventId(),
					type: "tool.started",
					data: {
						messageId,
						partId,
						toolName: "AskUserQuestion",
						callId: question.toolCallId ?? question.requestId,
						input: { tool: "AskUserQuestion", questions: question.questions },
					},
				},
				completedEvent,
				resolvedEvent,
			]);
		} else {
			yield* ingestion.ingestBatch([completedEvent, resolvedEvent]);
		}
	});

const resolvePendingClaudeQuestions = (
	input: ProviderTurnServicePrepareInput,
) =>
	Effect.gen(function* () {
		const pendingInteractionService = yield* PendingInteractionServiceTag;
		// A Claude turn blocked on a question never reaches the next message, so
		// replying instead of answering interrupts it and resolves the question.
		// Each path records question.resolved, which takes the card down.
		const pendingQuestions =
			yield* pendingInteractionService.listPendingQuestions(input.sessionId);
		for (const question of pendingQuestions) {
			if (!question.recovered) continue;
			yield* completeRecoveredQuestion(question, null);
			yield* pendingInteractionService.markQuestionResolved(question.requestId);
		}
		if (pendingQuestions.some((question) => !question.recovered)) {
			const stop = {
				clientId: input.clientId,
				sessionId: input.sessionId,
				commandId: `${input.commandId}:interrupt-for-question`,
			};
			yield* interruptTurn(stop, yield* prepareStop(stop));
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
		wsHandler.setClientSession(input.clientId, session.id);
		log.info(
			`client=${input.clientId} materialized OpenCode session ${session.id} from local session ${input.sessionId}`,
		);
		return session.id;
	});

export const prepareTurnSession = (input: ProviderTurnServicePrepareInput) =>
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
			yield* resolvePendingClaudeQuestions(input);
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

const interruptLegacyTurn = (input: ProviderTurnServiceInterruptInput) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const abortResult = yield* Effect.result(
			Effect.gen(function* () {
				const read = yield* ReadQueryEffectTag;
				const row = yield* read.getSession(input.sessionId);
				if (!row)
					return yield* Effect.fail(
						new Error(`Session ${input.sessionId} not found`),
					);
				const directory = yield* (yield* SessionWorkspaceTag).get(
					input.sessionId,
				);
				const client = yield* (yield* OpenCodeInstancesTag).use(
					row.provider,
					directory,
				);
				yield* Effect.tryPromise(() => client.session.abort(input.sessionId));
			}).pipe(Effect.scoped),
		);
		if (abortResult._tag === "Failure") {
			log.warn(
				`client=${input.clientId} session=${input.sessionId} Abort failed:`,
				formatErrorDetail(abortResult.failure),
			);
			return yield* Effect.fail(abortResult.failure);
		}
		return true;
	});

export const prepareStop = (input: ProviderTurnServiceInterruptInput) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		const store = yield* EventStoreEffectTag;
		// Close unused reservations and return handoffs in one transaction,
		// serialized against the claim UPDATE so the drain cannot steal them.
		const owners = yield* commit.write((project) =>
			Effect.gen(function* () {
				const claimed = yield* sessionRunOwnersQuery(sql, input.sessionId, {
					confirmedStop: true,
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
				return claimed.map(({ id }) => ({ runId: id }));
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
			owners,
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
		const providerId = yield* engine.getProviderForSessionEffect(
			input.sessionId,
		);
		const account = providerId
			? yield* (yield* AccountDirectory).resolve({ _tag: "Id", id: providerId })
			: undefined;
		if (!account || PROVIDER_DRIVERS[account.driver].runsOpenCodeServer) {
			if (!(yield* interruptLegacyTurn(input))) return;
		} else {
			if (!PROVIDER_DRIVERS[account.driver].interruptViaEngine) return;
			const [delivery] = yield* (yield* SqlClient.SqlClient)<{
				indeterminate: number;
			}>`
				SELECT EXISTS (SELECT 1 FROM provider_command_outbox command
					JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id
					WHERE command.session_id = ${input.sessionId} AND command.effect_type = 'send_turn'
					AND command.status = 'running' AND command.error_code = 'delivery_indeterminate'
						AND run.id IN ${sql.in(snapshot.owners.map(({ runId }) => runId))}
					AND run.status IN ('pending', 'running')) AS indeterminate`;
			const fullStop = delivery?.indeterminate === 1;
			const interruptResult = yield* Effect.result(
				engine.dispatchEffect({
					type: fullStop ? "end_session" : "interrupt_turn",
					...(!fullStop && snapshot.turnIds.length > 0
						? { turnIds: snapshot.turnIds }
						: {}),
					commandId: input.commandId,
					sessionId: input.sessionId,
				}),
			);
			if (interruptResult._tag === "Failure") {
				log.warn(
					`client=${input.clientId} session=${input.sessionId} engine interrupt_turn failed:`,
					formatErrorDetail(interruptResult.failure),
				);
				return yield* Effect.fail(interruptResult.failure);
			}
			// An ordinary turn interrupt keeps the Claude SDK's pending steer alive.
			if (!fullStop) return;
		}
		const ingestion = yield* ProviderRuntimeIngestionTag;
		yield* settleSessionRuns(
			sql,
			input.sessionId,
			"Stopped by the user",
			(events) => ingestion.ingestBatch(events),
			{ owners: snapshot.owners },
		);
	});
