import { Effect } from "effect";
import type { Account } from "../../../contracts/account.js";
import { formatErrorDetail } from "../../../errors.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { createEventId } from "../../../persistence/events.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	PendingInteractionServiceTag,
	type PendingQuestion,
} from "./pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import {
	CLAUDE_PROVIDER_ID,
	isProviderTurnInterruptProvider,
} from "./provider-turn-dispatch.js";
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
			data: { id: question.requestId, answers },
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

		const rowResult = yield* Effect.either(
			readQuery.getSession(input.sessionId),
		);
		if (rowResult._tag === "Left") {
			log.warn(
				`Could not inspect session provider before OpenCode dispatch for ${input.sessionId}: ${formatErrorDetail(rowResult.left)}`,
			);
			return input.sessionId;
		}

		const row = rowResult.right;
		if (!row || row.provider === providerId) {
			return input.sessionId;
		}
		const source = yield* (yield* AccountDirectory).resolve({
			_tag: "Id",
			id: row.provider,
		});
		if (source.driver === "opencode") return input.sessionId;
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
		if (account.driver === "claude") {
			if (input.delivery !== "steer")
				yield* resolvePendingClaudeQuestions(input);
			return input.sessionId;
		}
		return yield* materializeOpenCodeSession(
			input,
			account,
			providerId ?? account.id,
		).pipe(Effect.provideService(OrchestrationEngineTag, orchestrationEngine));
	});

const interruptLegacyTurn = (input: ProviderTurnServiceInterruptInput) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const log = yield* LoggerTag;
		const abortResult = yield* Effect.either(
			Effect.tryPromise(() => client.session.abort(input.sessionId)),
		);
		if (abortResult._tag === "Left") {
			log.warn(
				`client=${input.clientId} session=${input.sessionId} Abort failed:`,
				formatErrorDetail(abortResult.left),
			);
		}
	});

export const interruptTurn = (input: ProviderTurnServiceInterruptInput) =>
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
		if (!isProviderTurnInterruptProvider(account.driver)) {
			yield* interruptLegacyTurn(input);
			return;
		}

		const interruptResult = yield* Effect.either(
			engine.dispatchEffect({
				type: "interrupt_turn",
				commandId: input.commandId,
				sessionId: input.sessionId,
			}),
		);
		if (interruptResult._tag === "Left") {
			log.warn(
				`client=${input.clientId} session=${input.sessionId} engine interrupt_turn failed:`,
				formatErrorDetail(interruptResult.left),
			);
			yield* Effect.fail(interruptResult.left);
		}
	});
