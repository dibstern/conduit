import { Effect } from "effect";
import {
	PROVIDER_DRIVERS,
	type ProviderDriverTraits,
} from "../../../contracts/provider-instance.js";
import { formatErrorDetail } from "../../../errors.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { createEventId } from "../../../persistence/events.js";
import { STOP_ABORT_WAIT_MS } from "../../../provider/orchestration-command-contracts.js";
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
import { LoggerTag, OrchestrationEngineTag } from "./services.js";
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

/** Commit a Stop, failing when main does not accept it, without waiting on its abort. */
type CommitStop = (
	input: ProviderTurnServiceInterruptInput,
) => Effect.Effect<
	void,
	Effect.Error<ReturnType<ProviderTurnService["beginStop"]>>
>;

const resolvePendingClaudeQuestions = (
	input: ProviderTurnServicePrepareInput,
	commitStop: CommitStop,
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
			// Commit the Stop without waiting on its deadline: the reply is admitted
			// behind it as the reserved next turn (failure catalogue RL-081, 1304-1318).
			// A Stop main does not accept fails the reply before admission; a reply
			// that joins an accepted Stop is admitted behind it.
			yield* commitStop(stop);
		}
	});

export const prepareTurnSession = (
	input: ProviderTurnServicePrepareInput,
	commitStop: CommitStop,
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
			yield* resolvePendingClaudeQuestions(input, commitStop);
		return input.sessionId;
	});

export const prepareStop = (input: ProviderTurnServiceInterruptInput) =>
	Effect.flatMap(OrchestrationEngineTag, (engine) =>
		engine.acceptStopEffect(input),
	);

export const interruptTurn = (
	input: ProviderTurnServiceInterruptInput,
	_snapshot: Effect.Success<ReturnType<typeof prepareStop>>,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		log.info(`client=${input.clientId} session=${input.sessionId} Aborting`);
		yield* clearProcessingTimeout(input.sessionId);
		const engine = yield* OrchestrationEngineTag;
		const interruptResult = yield* Effect.result(
			engine.executeAcceptedStopEffect(input),
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
