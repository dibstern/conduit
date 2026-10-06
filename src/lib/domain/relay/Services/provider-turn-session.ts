import { Effect } from "effect";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import { formatErrorDetail } from "../../../errors.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { createEventId } from "../../../persistence/events.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	PendingInteractionServiceTag,
	type PendingQuestion,
} from "./pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import {
	CLAUDE_PROVIDER_ID,
	isClaudeDriver,
	isProviderTurnInterruptProvider,
	OPENCODE_PROVIDER_ID,
} from "./provider-turn-dispatch.js";
import type {
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
import { selectSessionModel } from "./session-model-settings.js";
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
	daemonConfig: ReturnType<typeof loadDaemonConfig>,
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
		if (
			!row ||
			resolveProviderRoutingDriver(daemonConfig, row.provider) ===
				OPENCODE_PROVIDER_ID
		) {
			return input.sessionId;
		}

		const targetProvider = input.model?.providerID ?? providerId;
		const session = yield* sessionManagerService.createSession(row.title, {
			providerId: targetProvider,
		});
		if (input.model && input.modelUserSelected) {
			yield* selectSessionModel(session.id, input.model);
		}
		orchestrationEngine.bindSession(session.id, OPENCODE_PROVIDER_ID);
		wsHandler.setClientSession(input.clientId, session.id);
		yield* Effect.forkDaemon(
			sessionManagerService
				.pushViewerFamilies()
				.pipe(
					Effect.catchAll((err) =>
						Effect.sync(() =>
							log.warn(
								`Failed to push viewed families after OpenCode materialization: ${err}`,
							),
						),
					),
				),
		);
		log.info(
			`client=${input.clientId} materialized OpenCode session ${session.id} from local session ${input.sessionId}`,
		);
		return session.id;
	});

export const prepareTurnSession = (input: ProviderTurnServicePrepareInput) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const orchestrationEngine = yield* OrchestrationEngineTag;
		const providerId =
			(yield* orchestrationEngine.getProviderForSessionEffect(
				input.sessionId,
			)) ??
			(input.model && input.model.providerID === CLAUDE_PROVIDER_ID
				? CLAUDE_PROVIDER_ID
				: OPENCODE_PROVIDER_ID);
		const daemonConfig = loadDaemonConfig(config.configDir);
		const driver = resolveProviderRoutingDriver(daemonConfig, providerId);
		if (driver === undefined) return input.sessionId;
		if (isClaudeDriver(driver)) {
			yield* resolvePendingClaudeQuestions(input);
			return input.sessionId;
		}
		return yield* materializeOpenCodeSession(
			input,
			daemonConfig,
			providerId,
		).pipe(Effect.provideService(OrchestrationEngineTag, orchestrationEngine));
	});

const interruptLegacyTurn = (input: ProviderTurnServiceInterruptInput) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const log = yield* LoggerTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const abortResult = yield* Effect.either(
			Effect.tryPromise(() => client.session.abort(input.sessionId)),
		);
		if (abortResult._tag === "Left") {
			log.warn(
				`client=${input.clientId} session=${input.sessionId} Abort failed:`,
				formatErrorDetail(abortResult.left),
			);
		}
		wsHandler.sendToSession(input.sessionId, {
			type: "done",
			sessionId: input.sessionId,
			code: 1,
		});
	});

export const interruptTurn = (input: ProviderTurnServiceInterruptInput) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const config = yield* ConfigTag;
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
		const driver = resolveProviderRoutingDriver(
			loadDaemonConfig(config.configDir),
			providerId,
		);
		if (driver === undefined) {
			log.warn(
				`client=${input.clientId} session=${input.sessionId} Cannot resolve provider instance for interrupt routing: ${providerId}`,
			);
			wsHandler.sendToSession(input.sessionId, {
				type: "done",
				sessionId: input.sessionId,
				code: 1,
			});
			return;
		}
		if (!isProviderTurnInterruptProvider(driver)) {
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
		}
		wsHandler.sendToSession(input.sessionId, {
			type: "done",
			sessionId: input.sessionId,
			code: 1,
		});
	});
