// ─── Permission & Question Handlers ──────────────────────────────────────────
//
// Questions use a bridge-less design: the frontend receives the question's
// `que_` ID via the `ask_user` WebSocket message and sends it back with the
// answer. The handler calls the OpenCode REST API directly — no in-memory
// bridge state is needed, so questions survive relay restarts.

import { Effect } from "effect";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	PermissionBridgeTag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import { SessionManagerServiceTag } from "../effect/session-manager-service.js";
import { RelayError } from "../errors.js";
import { fixupConfigFile } from "../instance/opencode-config-fixup.js";
import type { PermissionDecision } from "../provider/types.js";
import type { PayloadMap } from "./payloads.js";

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
		const overrides = yield* SessionOverridesTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		overrides.startProcessingTimeout(sessionId, () => {
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
		});
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
	payload: PayloadMap["permission_response"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const permissionBridge = yield* PermissionBridgeTag;

		const { requestId, decision, persistScope, persistPattern } = payload;
		const sessionId = wsHandler.getClientSession(clientId) ?? "?";
		const result = permissionBridge.onPermissionResponse(requestId, decision);

		if (result) {
			log.info(
				`client=${clientId} session=${sessionId} ${result.toolName}: ${result.mapped}`,
			);

			// Route through OrchestrationEngine for Claude sessions
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "Some") {
				const engine = engineOption.value;
				const providerId = engine.getProviderForSession(sessionId);
				if (providerId === "claude") {
					const dispatchResult = yield* Effect.either(
						Effect.tryPromise(() =>
							engine.dispatch({
								type: "resolve_permission",
								sessionId,
								requestId,
								decision: result.mapped as PermissionDecision,
							}),
						),
					);
					if (dispatchResult._tag === "Left") {
						log.warn(
							`client=${clientId} session=${sessionId} engine resolve_permission failed: ${dispatchResult.left}`,
						);
					}
				}
			}

			// Also call the OpenCode REST API (harmless no-op for Claude sessions)
			yield* Effect.either(
				Effect.tryPromise(() =>
					client.permission.reply(sessionId, requestId, result.mapped),
				),
			);

			wsHandler.broadcast({
				type: "permission_resolved",
				sessionId,
				requestId,
				decision: result.mapped,
			});

			// Persist to opencode.jsonc when the user chose "Always Allow"
			if (decision === "allow_always" && persistScope) {
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
	payload: PayloadMap["ask_user_response"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

		const { toolId, answers } = payload;
		const sessionId = wsHandler.getClientSession(clientId) ?? "";

		const formatted = formatAnswers(answers);

		log.info(
			`client=${clientId} session=${sessionId} answering: ${toolId} payload=${JSON.stringify({ id: toolId, answers: formatted })}`,
		);

		// Route through OrchestrationEngine for Claude sessions
		const engineHandled = yield* Effect.gen(function* () {
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "None" || !sessionId) return false;
			const engine = engineOption.value;
			const providerId = engine.getProviderForSession(sessionId);
			if (providerId !== "claude") return false;

			const dispatchResult = yield* Effect.either(
				Effect.tryPromise(() =>
					engine.dispatch({
						type: "resolve_question",
						sessionId,
						requestId: toolId,
						answers: answers as Record<string, unknown>,
					}),
				),
			);
			if (dispatchResult._tag === "Left") {
				log.warn(
					`client=${clientId} session=${sessionId} engine resolve_question failed: ${dispatchResult.left}`,
				);
				return false;
			}
			wsHandler.broadcast({
				type: "ask_user_resolved",
				toolId,
				sessionId,
			});
			if (sessionId) {
				yield* sessionManagerService.decrementPendingQuestionCount(sessionId);
			}
			yield* restartProcessingTimeout(sessionId);
			return true;
		});

		if (engineHandled) return;

		// OpenCode REST API path with fallback (preserving recovery logic)
		const replyResult = yield* Effect.either(
			Effect.tryPromise(() => client.question.reply(toolId, formatted)),
		);
		if (replyResult._tag === "Right") {
			wsHandler.broadcast({
				type: "ask_user_resolved",
				toolId,
				sessionId,
			});
			if (sessionId) {
				yield* sessionManagerService.decrementPendingQuestionCount(sessionId);
			}
			yield* restartProcessingTimeout(sessionId);
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
				if (pendingQuestions.length > 0) {
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
					const queId = pendingQuestions[0]!.id;
					log.info(
						`client=${clientId} session=${sessionId} API fallback: ${toolId} → ${queId}`,
					);
					yield* Effect.tryPromise(() =>
						client.question.reply(queId, formatted),
					);
					wsHandler.broadcast({
						type: "ask_user_resolved",
						toolId: queId,
						sessionId,
					});
					if (sessionId) {
						yield* sessionManagerService.decrementPendingQuestionCount(
							sessionId,
						);
					}
					yield* restartProcessingTimeout(sessionId);
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
	payload: PayloadMap["question_reject"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const { toolId } = payload;
		if (!toolId) return;

		const sessionManagerService = yield* SessionManagerServiceTag;
		const sessionId = wsHandler.getClientSession(clientId) ?? "";

		log.info(`client=${clientId} session=${sessionId} rejecting: ${toolId}`);

		// Route through OrchestrationEngine for Claude sessions
		const engineHandled = yield* Effect.gen(function* () {
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "None" || !sessionId) return false;
			const engine = engineOption.value;
			const providerId = engine.getProviderForSession(sessionId);
			if (providerId !== "claude") return false;

			const dispatchResult = yield* Effect.either(
				Effect.tryPromise(() =>
					engine.dispatch({
						type: "resolve_question",
						sessionId,
						requestId: toolId,
						answers: {},
					}),
				),
			);
			if (dispatchResult._tag === "Left") {
				log.warn(
					`client=${clientId} session=${sessionId} engine resolve_question (reject) failed: ${dispatchResult.left}`,
				);
				return false;
			}
			wsHandler.broadcast({
				type: "ask_user_resolved",
				toolId,
				sessionId,
			});
			if (sessionId) {
				yield* sessionManagerService.decrementPendingQuestionCount(sessionId);
			}
			yield* restartProcessingTimeout(sessionId);
			return true;
		});

		if (engineHandled) return;

		// OpenCode REST API path with fallback (preserving recovery logic)
		const rejectResult = yield* Effect.either(
			Effect.tryPromise(() => client.question.reject(toolId)),
		);
		if (rejectResult._tag === "Right") {
			wsHandler.broadcast({
				type: "ask_user_resolved",
				toolId,
				sessionId,
			});
			if (sessionId) {
				yield* sessionManagerService.decrementPendingQuestionCount(sessionId);
			}
			yield* restartProcessingTimeout(sessionId);
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
					wsHandler.broadcast({
						type: "ask_user_resolved",
						toolId: queId,
						sessionId,
					});
					if (sessionId) {
						yield* sessionManagerService.decrementPendingQuestionCount(
							sessionId,
						);
					}
					yield* restartProcessingTimeout(sessionId);
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
