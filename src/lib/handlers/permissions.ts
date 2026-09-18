import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
// ─── Permission & Question Handlers ──────────────────────────────────────────
//
// Questions use a bridge-less design: the frontend receives the question's
// `que_` ID via the `ask_user` WebSocket message and sends it back with the
// answer. The handler calls the OpenCode REST API directly — no in-memory
// bridge state is needed, so questions survive relay restarts.

import { SqlClient } from "@effect/sql";
import { Data, Effect, Option } from "effect";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import {
	PROCESSING_TIMEOUT_DURATION,
	setDefaultPermissionMode,
	startProcessingTimeout,
} from "../domain/relay/Services/session-overrides-state.js";
import { RelayError } from "../errors.js";
import { fixupConfigFile } from "../instance/opencode-config-fixup.js";
import { makeCommitAndSignal } from "../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../persistence/events.js";
import { saveRelaySettings } from "../relay/relay-settings.js";
import type {
	PermissionId,
	ProviderPermissionUpdateDestination,
	SessionPermissionMode,
} from "../shared-types.js";

class RelaySettingsSaveError extends Data.TaggedError(
	"RelaySettingsSaveError",
)<{ readonly cause: unknown }> {}

export const setDefaultPermissionModeForRelay = (input: {
	readonly clientId: string;
	readonly mode: SessionPermissionMode;
}) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		yield* Effect.try({
			try: () =>
				saveRelaySettings(
					{ defaultPermissionMode: input.mode },
					config.configDir,
				),
			catch: (cause) => new RelaySettingsSaveError({ cause }),
		});
		yield* setDefaultPermissionMode(input.mode);
		wsHandler.broadcast({
			type: "default_permission_mode_info",
			mode: input.mode,
		});
		log.info(
			`client=${input.clientId} Set default permission mode to: ${input.mode}`,
		);
		return input.mode;
	});

interface PermissionResponsePayload {
	readonly requestId: PermissionId;
	readonly commandId?: string;
	readonly decision: string;
	readonly persistScope?: "tool" | "pattern";
	readonly persistPattern?: string;
	readonly permissionDestination?: ProviderPermissionUpdateDestination;
}

interface AskUserResponsePayload {
	readonly toolId: string;
	readonly commandId?: string;
	readonly answers: Record<string, string>;
}

interface QuestionRejectPayload {
	readonly toolId: string;
	readonly commandId?: string;
}

/**
 * Convert browser answer format `Record<string, string>` to OpenCode's
 * `string[][]` format.  Each numeric key maps to one question; the value
 * is a single selected label (or comma-separated labels for multi-select).
 */
function formatAnswers(rawAnswers: Record<string, string>): string[][] {
	const formatted: string[][] = [];
	const keys = Object.keys(rawAnswers)
		.map(Number)
		.filter((n) => !Number.isNaN(n))
		.sort((a, b) => a - b);
	for (const key of keys) {
		const val = rawAnswers[String(key)] ?? "";
		formatted.push(val ? [val] : []);
	}
	return formatted;
}

/**
 * Restart the inactivity timeout after a question/permission response.
 * After a question is answered or rejected, the model resumes processing.
 * (The timeout was cleared when the question was asked — see event-pipeline.ts.)
 */
const restartProcessingTimeout = (sessionId: string) =>
	Effect.gen(function* () {
		if (!sessionId) return;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		yield* startProcessingTimeout(sessionId, PROCESSING_TIMEOUT_DURATION, () =>
			Effect.sync(() => {
				log.warn(
					`session=${sessionId} Processing timeout (120s) after question answered — broadcasting done`,
				);
				wsHandler.sendToSession(
					sessionId,
					new RelayError(
						"No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
						{ code: "PROCESSING_TIMEOUT" },
					).toMessage(sessionId),
				);
				wsHandler.sendToSession(sessionId, {
					type: "done",
					sessionId,
					code: 1,
				});
			}),
		);
	});

/**
 * Persist that a question stopped being pending, and say so out loud if it
 * cannot be.
 *
 * The badge counts unresolved questions out of the read model, so a resolution
 * that only goes out over the socket clears the card in front of the user and
 * leaves the count behind: reload, and the session is asking again, forever.
 * Appending the canonical event is what makes the answer survive — the approval
 * projector flips `pending_approvals` to resolved, stamps `sessions.version`
 * with the version it projected at, and the seam publishes that advance after
 * COMMIT, which is how a subscriber learns the badge moved.
 *
 * Only the OpenCode REST paths come through here. A question owned by the
 * provider runtime is resolved through its event sink, which emits
 * `question.resolved` itself; appending a second one would be a duplicate
 * event, not a second fact.
 *
 * The services are options for the same reason as `recordSessionViewed`:
 * handler tests and the CLI's degenerate stacks run without persistence. An
 * unwired store is reported, never skipped in silence.
 */
const recordQuestionResolved = (
	sessionId: string,
	questionId: string,
	answers: Record<string, unknown>,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		if (!sessionId) {
			log.warn(
				`question ${questionId} resolved without a session id — nothing to clear the badge on`,
			);
			return;
		}

		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		const eventStore = yield* Effect.serviceOption(EventStoreEffectTag);
		const projectionRunner = yield* Effect.serviceOption(
			ProjectionRunnerEffectTag,
		);
		if (
			Option.isNone(sql) ||
			Option.isNone(eventStore) ||
			Option.isNone(projectionRunner)
		) {
			log.warn(
				`question ${questionId} resolution not recorded: no read model is wired to write it to`,
			);
			return;
		}

		const written = yield* Effect.gen(function* () {
			const commitAndSignal = yield* makeCommitAndSignal;
			yield* commitAndSignal([
				canonicalEvent("question.resolved", sessionId, {
					id: questionId,
					answers,
				}),
			]);
		}).pipe(
			Effect.provideService(SqlClient.SqlClient, sql.value),
			Effect.provideService(EventStoreEffectTag, eventStore.value),
			Effect.provideService(ProjectionRunnerEffectTag, projectionRunner.value),
			Effect.either,
		);
		if (written._tag === "Left") {
			log.error(
				`question ${questionId} resolution not recorded for session=${sessionId}`,
				written.left,
			);
		}
	});

/**
 * Tell everyone a question is answered: the browsers watching it, the read
 * model that counts it, and the inactivity timer that stopped while it waited.
 *
 * One helper because the three have to happen together. Every exit that skipped
 * the middle one is how the badge came to outlive the question.
 */
const announceQuestionResolved = (
	sessionId: string,
	questionId: string,
	answers: Record<string, unknown>,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		wsHandler.broadcast({
			type: "ask_user_resolved",
			toolId: questionId,
			sessionId,
		});
		yield* recordQuestionResolved(sessionId, questionId, answers);
		yield* restartProcessingTimeout(sessionId);
	});

/** Persist permission rule to opencode.jsonc. */
const persistPermissionRule = (
	toolName: string,
	scope: "tool" | "pattern",
	pattern?: string,
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;

		const persistResult = yield* Effect.either(
			Effect.gen(function* () {
				const configData = yield* Effect.tryPromise(() => client.config.get());
				const rawPermission = configData["permission"];

				let currentPermission: Record<string, unknown>;
				if (typeof rawPermission === "string") {
					currentPermission = { "*": rawPermission };
				} else if (
					rawPermission &&
					typeof rawPermission === "object" &&
					!Array.isArray(rawPermission)
				) {
					currentPermission = {
						...(rawPermission as Record<string, unknown>),
					};
				} else {
					currentPermission = {};
				}

				if (scope === "tool") {
					currentPermission[toolName] = "allow";
				} else if (scope === "pattern" && pattern) {
					const currentRule = currentPermission[toolName];
					const ruleObject =
						typeof currentRule === "object" &&
						currentRule !== null &&
						!Array.isArray(currentRule)
							? { ...(currentRule as Record<string, unknown>) }
							: {};
					ruleObject[pattern] = "allow";
					currentPermission[toolName] = ruleObject;
				} else {
					return;
				}

				yield* Effect.tryPromise(() =>
					client.config.update({ permission: currentPermission }),
				);
				yield* Effect.tryPromise(() => fixupConfigFile(config.projectDir, log));
				log.info(`Persisted: ${toolName} ${scope}=${pattern ?? "*"}`);
			}),
		);
		if (persistResult._tag === "Left") {
			log.warn(`Config persist failed: ${persistResult.left}`);
		}
	});

export const handlePermissionResponse = (
	clientId: string,
	payload: PermissionResponsePayload,
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const pendingInteractions = yield* PendingInteractionServiceTag;

		const {
			requestId,
			decision,
			persistScope,
			persistPattern,
			permissionDestination,
		} = payload;
		const visibleSessionId = wsHandler.getClientSession(clientId) ?? "";
		const resultOption =
			yield* pendingInteractions.resolvePermissionFromBrowser(
				requestId,
				decision,
				permissionDestination != null ? { permissionDestination } : undefined,
			);
		const result = Option.getOrUndefined(resultOption);

		if (result) {
			const sessionId = result.sessionId || visibleSessionId || "?";
			log.info(
				`client=${clientId} session=${sessionId} ${result.toolName}: ${result.mapped}`,
			);

			let isClaudeSession = false;
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "Some") {
				const engine = engineOption.value;
				const providerId = engine.getProviderForSession(sessionId);
				if (providerId === "claude") {
					isClaudeSession = true;
				}
			}

			if (!isClaudeSession) {
				yield* Effect.either(
					Effect.tryPromise(() =>
						client.permission.reply(sessionId, requestId, result.mapped),
					),
				);
			}

			wsHandler.broadcast({
				type: "permission_resolved",
				sessionId,
				requestId,
				decision: result.mapped,
			});

			// Persist to opencode.jsonc when the user chose "Always Allow"
			if (decision === "allow_always" && persistScope && !isClaudeSession) {
				yield* persistPermissionRule(
					result.toolName,
					persistScope,
					persistPattern,
				);
			}
		}
	});

export const handleAskUserResponse = (
	clientId: string,
	payload: AskUserResponsePayload,
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const { toolId, answers } = payload;
		const sessionId = wsHandler.getClientSession(clientId) ?? "";

		const formatted = formatAnswers(answers);

		log.info(
			`client=${clientId} session=${sessionId} answering: ${toolId} payload=${JSON.stringify({ id: toolId, answers: formatted })}`,
		);

		const pendingInteractionsOption = yield* Effect.serviceOption(
			PendingInteractionServiceTag,
		);
		if (pendingInteractionsOption._tag === "Some") {
			const resolvedOption =
				yield* pendingInteractionsOption.value.resolveQuestionFromBrowser(
					toolId,
					answers as Record<string, unknown>,
				);
			const resolved = Option.getOrUndefined(resolvedOption);
			if (resolved) {
				const questionSessionId = resolved.sessionId || sessionId;
				const engineOption = yield* Effect.serviceOption(
					OrchestrationEngineTag,
				);
				if (engineOption._tag === "Some") {
					const providerId =
						engineOption.value.getProviderForSession(questionSessionId);
					if (providerId !== "claude") {
						log.warn(
							`client=${clientId} session=${questionSessionId} service-owned question ${toolId} resolved for provider=${providerId ?? "unknown"}`,
						);
					}
				}
				wsHandler.broadcast({
					type: "ask_user_resolved",
					toolId,
					sessionId: questionSessionId,
				});
				yield* restartProcessingTimeout(questionSessionId);
				return;
			}
		}

		// OpenCode REST API path with fallback (preserving recovery logic)
		const replyResult = yield* Effect.either(
			Effect.tryPromise(() => client.question.reply(toolId, formatted)),
		);
		if (replyResult._tag === "Right") {
			yield* announceQuestionResolved(sessionId, toolId, answers);
			return;
		}

		log.warn(
			`client=${clientId} session=${sessionId} replyQuestion failed for ${toolId}: ${replyResult.left}`,
		);

		// Fallback: query pending questions and reply to the first match
		const fallbackResult = yield* Effect.either(
			Effect.gen(function* () {
				const pendingQuestions = yield* Effect.tryPromise(() =>
					client.question.list(),
				);
				const question =
					pendingQuestions.find(
						(question) => question["sessionID"] === sessionId,
					) ??
					pendingQuestions.find(
						(question) => question["sessionID"] === undefined,
					);
				if (question) {
					const queId = question.id;
					log.info(
						`client=${clientId} session=${sessionId} API fallback: ${toolId} → ${queId}`,
					);
					yield* Effect.tryPromise(() =>
						client.question.reply(queId, formatted),
					);
					yield* announceQuestionResolved(sessionId, queId, answers);
					return true;
				}
				return false;
			}),
		);

		if (fallbackResult._tag === "Right" && fallbackResult.right) return;

		if (fallbackResult._tag === "Left") {
			log.warn(
				`client=${clientId} session=${sessionId} API fallback also failed: ${fallbackResult.left}`,
			);
		}

		log.warn(
			`client=${clientId} session=${sessionId} answer DROPPED (no pending question found): ${toolId}`,
		);

		wsHandler.sendTo(clientId, {
			type: "ask_user_error",
			sessionId,
			toolId,
			message:
				"This question was asked in a terminal session and can't be answered from the browser. Answer it in the terminal, or send a follow-up message to continue.",
		});
	});

export const handleQuestionReject = (
	clientId: string,
	payload: QuestionRejectPayload,
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const { toolId } = payload;
		if (!toolId) return;

		const sessionId = wsHandler.getClientSession(clientId) ?? "";

		log.info(`client=${clientId} session=${sessionId} rejecting: ${toolId}`);

		const pendingInteractionsOption = yield* Effect.serviceOption(
			PendingInteractionServiceTag,
		);
		if (pendingInteractionsOption._tag === "Some") {
			const pendingQuestions =
				yield* pendingInteractionsOption.value.listPendingQuestions();
			const pendingQuestion = pendingQuestions.find(
				(question) => question.requestId === toolId,
			);
			if (pendingQuestion) {
				const questionSessionId = pendingQuestion.sessionId || sessionId;
				const engineOption = yield* Effect.serviceOption(
					OrchestrationEngineTag,
				);
				const providerId =
					engineOption._tag === "Some"
						? engineOption.value.getProviderForSession(questionSessionId)
						: undefined;
				if (providerId === "claude") {
					log.warn(
						`client=${clientId} session=${questionSessionId} refused to skip Claude question ${toolId}`,
					);
					wsHandler.sendTo(clientId, {
						type: "ask_user_error",
						sessionId: questionSessionId,
						toolId,
						message:
							"Claude questions require an answer before the turn can continue.",
					});
					return;
				}
			}

			const resolvedOption =
				yield* pendingInteractionsOption.value.resolveQuestionFromBrowser(
					toolId,
					{},
				);
			const resolved = Option.getOrUndefined(resolvedOption);
			if (resolved) {
				const questionSessionId = resolved.sessionId || sessionId;
				const engineOption = yield* Effect.serviceOption(
					OrchestrationEngineTag,
				);
				if (engineOption._tag === "Some") {
					const providerId =
						engineOption.value.getProviderForSession(questionSessionId);
					if (providerId !== "claude") {
						log.warn(
							`client=${clientId} session=${questionSessionId} service-owned question reject ${toolId} resolved for provider=${providerId ?? "unknown"}`,
						);
					}
				}
				wsHandler.broadcast({
					type: "ask_user_resolved",
					toolId,
					sessionId: questionSessionId,
				});
				yield* restartProcessingTimeout(questionSessionId);
				return;
			}
		}

		// OpenCode REST API path with fallback (preserving recovery logic)
		const rejectResult = yield* Effect.either(
			Effect.tryPromise(() => client.question.reject(toolId)),
		);
		if (rejectResult._tag === "Right") {
			yield* announceQuestionResolved(sessionId, toolId, {});
			return;
		}

		log.warn(
			`client=${clientId} session=${sessionId} rejectQuestion failed for ${toolId}: ${rejectResult.left}`,
		);

		// Fallback: query pending questions
		const fallbackResult = yield* Effect.either(
			Effect.gen(function* () {
				const pendingQuestions = yield* Effect.tryPromise(() =>
					client.question.list(),
				);
				if (pendingQuestions.length > 0) {
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
					const queId = pendingQuestions[0]!.id;
					log.info(
						`client=${clientId} session=${sessionId} reject fallback: ${toolId} → ${queId}`,
					);
					yield* Effect.tryPromise(() => client.question.reject(queId));
					yield* announceQuestionResolved(sessionId, queId, {});
					return true;
				}
				return false;
			}),
		);

		if (fallbackResult._tag === "Right" && fallbackResult.right) return;

		if (fallbackResult._tag === "Left") {
			log.warn(
				`client=${clientId} session=${sessionId} reject fallback also failed: ${fallbackResult.left}`,
			);
		}

		// Notify the frontend so the QuestionCard can show an error
		wsHandler.sendTo(clientId, {
			type: "ask_user_error",
			sessionId,
			toolId,
			message:
				"This question was asked in a terminal session and can't be skipped from the browser. Answer it in the terminal, or send a follow-up message to continue.",
		});
	});
