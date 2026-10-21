import { Effect } from "effect";
import type { Account } from "../../../contracts/account.js";
import {
	PROVIDER_DRIVERS,
	type ProviderDriverTraits,
} from "../../../contracts/provider-instance.js";
import { formatErrorDetail } from "../../../errors.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { createEventId } from "../../../persistence/events.js";
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
			(yield* pendingInteractionService.listPendingQuestions(
				input.sessionId,
			)).filter((question) => question.delivery !== "async");
		for (const question of pendingQuestions) {
			if (!question.recovered) continue;
			yield* completeRecoveredQuestion(question, null);
			yield* pendingInteractionService.markQuestionResolved(question.requestId);
		}
		if (pendingQuestions.some((question) => !question.recovered)) {
			yield* interruptTurn({
				clientId: input.clientId,
				sessionId: input.sessionId,
				commandId: `${input.commandId}:interrupt-for-question`,
			});
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
	});

export const interruptTurn = (
	input: ProviderTurnServiceInterruptInput,
	turnIds?: readonly string[],
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		log.info(`client=${input.clientId} session=${input.sessionId} Aborting`);
		yield* clearProcessingTimeout(input.sessionId);

		const engine = yield* OrchestrationEngineTag;
		const providerId = yield* engine.getProviderForSessionEffect(
			input.sessionId,
		);
		if (!providerId) {
			yield* interruptLegacyTurn(input);
			return;
		}
		const account = yield* (yield* AccountDirectory).resolve({
			_tag: "Id",
			id: providerId,
		});
		if (PROVIDER_DRIVERS[account.driver].runsOpenCodeServer) {
			yield* interruptLegacyTurn(input);
			return;
		}
		if (!PROVIDER_DRIVERS[account.driver].interruptViaEngine) return;

		const interruptResult = yield* Effect.result(
			engine.dispatchEffect({
				type: "interrupt_turn",
				commandId: input.commandId,
				sessionId: input.sessionId,
				...(turnIds ? { turnIds } : {}),
			}),
		);
		if (interruptResult._tag === "Failure") {
			log.warn(
				`client=${input.clientId} session=${input.sessionId} engine interrupt_turn failed:`,
				formatErrorDetail(interruptResult.failure),
			);
			yield* Effect.fail(interruptResult.failure);
		}
	});
