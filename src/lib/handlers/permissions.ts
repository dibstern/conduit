import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
//
// Browser ids name Conduit's persisted prompts. OpenCode answers use the
// provider reference on that row, so questions survive relay restarts.

import { SqlClient } from "@effect/sql";
import { Data, Effect, Option } from "effect";
import {
	getProviderDriver,
	MANAGED_OPENCODE_ACCOUNT_ID,
	PROVIDER_DRIVERS,
} from "../contracts/provider-instance.js";
import { WsRpcError } from "../contracts/ws-rpc.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import { publishGlobalProjectSetting } from "../domain/relay/Services/project-settings.js";
import { ProviderTurnServiceTag } from "../domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import {
	PROCESSING_TIMEOUT_DURATION,
	startProcessingTimeout,
} from "../domain/relay/Services/session-overrides-state.js";
import { makeFailTurn } from "../domain/relay/Services/turn-failure.js";
import { fixupConfigFile } from "../instance/opencode-config-fixup.js";
import { makeCommitAndSignal } from "../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import { retirePendingPrompts } from "../persistence/effect/retire-pending-prompts.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	createCommandId,
} from "../persistence/events.js";
import { ProviderRegistryTag } from "../provider/provider-registry.js";
import { saveRelaySettings } from "../relay/relay-settings.js";
import type {
	PermissionId,
	ProviderPermissionUpdateDestination,
	SessionPermissionMode,
} from "../shared-types.js";
import { sendMessageToSession } from "./prompt.js";

class RelaySettingsSaveError extends Data.TaggedError(
	"RelaySettingsSaveError",
)<{ readonly cause: unknown }> {}

export const setDefaultPermissionModeForRelay = (input: {
	readonly clientId: string;
	readonly mode: SessionPermissionMode;
}) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;

		yield* Effect.try({
			try: () =>
				saveRelaySettings(
					{ defaultPermissionMode: input.mode },
					config.configDir,
				),
			catch: (cause) => new RelaySettingsSaveError({ cause }),
		});
		yield* publishGlobalProjectSetting("defaultPermissionMode");
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

interface StoredPromptReference {
	readonly id: string;
	readonly session_id: string;
	readonly type: "permission" | "question";
	readonly status: "pending" | "resolved";
	readonly tool_name: string | null;
	readonly provider_process_id: string | null;
	readonly provider_request_id: string | null;
}

const readPromptReference = (
	id: string,
	type: "permission" | "question",
	sessionId?: string,
) =>
	Effect.gen(function* () {
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		if (Option.isNone(sql)) return undefined;
		const [stored] = yield* sql.value<StoredPromptReference>`
			SELECT id, session_id, type, status, tool_name,
				provider_process_id, provider_request_id
			FROM pending_approvals WHERE id = ${id} AND type = ${type}`;
		if (stored?.status === "resolved") {
			const [expired] = yield* sql.value`
				SELECT 1 FROM events WHERE session_id = ${stored.session_id}
					AND type = ${`${type}.resolved`}
					AND json_extract(data, '$.id') = ${stored.id}
					AND json_extract(metadata, '$.source') = 'provider-process-expired'
				LIMIT 1`;
			if (expired)
				return yield* new WsRpcError({
					message:
						"This prompt expired because its provider process is no longer running.",
				});
		}
		if (!stored && sessionId) {
			const [referenced] = yield* sql.value<{ id: string }>`
				SELECT id FROM pending_approvals
				WHERE session_id = ${sessionId} AND type = ${type} AND status = 'pending'
					AND (provider_process_id IS NOT NULL OR provider_request_id IS NOT NULL)
				LIMIT 1`;
			if (referenced)
				return yield* new WsRpcError({
					message:
						"This prompt is no longer available. Refresh the session before answering.",
				});
		}
		return stored;
	});

const expirePrompt = (prompt: StoredPromptReference) =>
	Effect.gen(function* () {
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		const eventStore = yield* Effect.serviceOption(EventStoreEffectTag);
		const projector = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
		if (
			Option.isNone(sql) ||
			Option.isNone(eventStore) ||
			Option.isNone(projector)
		)
			return yield* new WsRpcError({
				message:
					"Could not expire this prompt because persistence is unavailable.",
			});
		yield* retirePendingPrompts([
			{
				id: prompt.id,
				sessionId: prompt.session_id,
				type: prompt.type,
			},
		]).pipe(
			Effect.provideService(SqlClient.SqlClient, sql.value),
			Effect.provideService(EventStoreEffectTag, eventStore.value),
			Effect.provideService(ProjectionRunnerEffectTag, projector.value),
		);
		const log = yield* LoggerTag;
		log.info(
			`Expired ${prompt.type} ${prompt.id} from provider process ${prompt.provider_process_id}`,
		);
		return yield* new WsRpcError({
			message:
				"This prompt expired because its provider process is no longer running.",
		});
	});

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
		const log = yield* LoggerTag;
		const failTurn = yield* makeFailTurn;

		yield* startProcessingTimeout(sessionId, PROCESSING_TIMEOUT_DURATION, () =>
			Effect.suspend(() => {
				log.warn(
					`session=${sessionId} Processing timeout (120s) after question answered — failing the turn`,
				);
				return failTurn(
					sessionId,
					"No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
					"PROCESSING_TIMEOUT",
				);
			}),
		);
	});

/**
 * Persist that an approval stopped being pending, and say so out loud if it
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
 * The OpenCode REST paths come through here, so does a recovered question
 * skipped with no turn left to record it, and so does an OpenCode permission
 * the relay timed out. A live approval owned by the provider runtime is
 * resolved through its event sink, which records the resolution itself;
 * appending a second one would be a duplicate event, not a second fact.
 *
 * The services are options because handler tests and the CLI's degenerate
 * stacks run without persistence. An unwired store is reported, never skipped
 * in silence.
 */
export const recordApprovalResolved = (
	resolution: Extract<
		CanonicalEvent,
		{ type: "question.resolved" | "permission.resolved" }
	>,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const { sessionId } = resolution;
		const what = `${resolution.type.split(".")[0]} ${resolution.data.id}`;
		if (!sessionId) {
			log.warn(
				`${what} resolved without a session id — nothing to clear the badge on`,
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
				`${what} resolution not recorded: no read model is wired to write it to`,
			);
			return;
		}

		const written = yield* Effect.gen(function* () {
			const commitAndSignal = yield* makeCommitAndSignal;
			yield* commitAndSignal([resolution]);
		}).pipe(
			Effect.provideService(SqlClient.SqlClient, sql.value),
			Effect.provideService(EventStoreEffectTag, eventStore.value),
			Effect.provideService(ProjectionRunnerEffectTag, projectionRunner.value),
			Effect.either,
		);
		if (written._tag === "Left") {
			log.error(
				`${what} resolution not recorded for session=${sessionId}`,
				written.left,
			);
		}
	});

/**
 * Tell everyone a question is answered: the read model that counts it (and
 * whose approvals subscription takes the card off every browser), and the
 * inactivity timer that stopped while it waited.
 *
 * One helper because the two have to happen together. Every exit that skipped
 * the record is how the badge came to outlive the question.
 */
const announceQuestionResolved = (
	sessionId: string,
	questionId: string,
	answers: Record<string, unknown>,
) =>
	Effect.gen(function* () {
		yield* recordApprovalResolved(
			canonicalEvent("question.resolved", sessionId, {
				id: questionId,
				answers,
			}),
		);
		yield* restartProcessingTimeout(sessionId);
	});

/**
 * An OpenCode permission the relay timed out with no turn awaiting it: recorded
 * as rejected, which takes its card down. OpenCode itself is not told.
 */
export const recordPermissionTimedOut = (entry: {
	readonly id: string;
	readonly sessionId: string;
}) =>
	recordApprovalResolved(
		canonicalEvent("permission.resolved", entry.sessionId, {
			id: entry.id,
			decision: "reject",
		}),
	);

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
		const stored = yield* readPromptReference(requestId, "permission");
		if (stored?.status === "resolved") return;
		if (stored?.provider_process_id?.startsWith("opencode:")) {
			yield* resolveOpenCodeQuestionTarget(stored.session_id, stored);
		}
		const resultOption =
			yield* pendingInteractions.resolvePermissionFromBrowser(
				requestId,
				decision,
				permissionDestination != null ? { permissionDestination } : undefined,
			);
		if (
			Option.isNone(resultOption) &&
			stored?.provider_process_id &&
			!stored.provider_process_id.startsWith("opencode:")
		)
			return yield* expirePrompt(stored);
		const mapped =
			decision === "allow"
				? ("once" as const)
				: decision === "allow_always"
					? ("always" as const)
					: decision === "deny"
						? ("reject" as const)
						: undefined;
		const result =
			Option.getOrUndefined(resultOption) ??
			(stored && mapped
				? {
						sessionId: stored.session_id,
						toolName: stored.tool_name ?? "",
						mapped,
					}
				: undefined);

		if (result) {
			const sessionId = result.sessionId || visibleSessionId || "?";
			log.info(
				`client=${clientId} session=${sessionId} ${result.toolName}: ${result.mapped}`,
			);

			const engine = yield* OrchestrationEngineTag;
			const bindingId = yield* engine.getProviderForSessionEffect(sessionId);
			const traits = getProviderDriver(bindingId) ?? PROVIDER_DRIVERS.opencode;

			// The adapter owns the reply: it scopes "always" to the session.
			const opencode = traits.runsOpenCodeServer
				? (yield* ProviderRegistryTag).getInstance("opencode")
				: undefined;
			if (opencode) {
				const replied = yield* Effect.either(
					opencode.resolvePermissionEffect(
						sessionId,
						stored?.provider_request_id ?? requestId,
						result.mapped,
						stored?.provider_process_id ?? undefined,
					),
				);
				if (replied._tag === "Left" && stored?.provider_process_id) {
					yield* resolveOpenCodeQuestionTarget(sessionId, stored);
					return yield* Effect.fail(replied.left);
				}
				if (replied._tag === "Right" && stored) {
					yield* recordApprovalResolved(
						canonicalEvent("permission.resolved", sessionId, {
							id: stored.id,
							decision: result.mapped,
						}),
					);
				}
			}

			// Persist to opencode.jsonc when the user chose "Always Allow"
			if (
				decision === "allow_always" &&
				persistScope &&
				traits.runsOpenCodeServer
			) {
				yield* persistPermissionRule(
					result.toolName,
					persistScope,
					persistPattern,
				);
			}
		}
	}).pipe(Effect.scoped);

const resolveOpenCodeQuestionTarget = (
	sessionId: string,
	prompt?: StoredPromptReference,
) =>
	Effect.gen(function* () {
		const providerProcessId = prompt?.provider_process_id;
		const defaultClient = yield* OpenCodeAPITag;
		const engine = yield* Effect.serviceOption(OrchestrationEngineTag);
		const instances = yield* Effect.serviceOption(OpenCodeInstancesTag);
		if (engine._tag === "None" || instances._tag === "None") {
			if (
				providerProcessId &&
				defaultClient.promptProcessId !== providerProcessId
			)
				return yield* expirePrompt(prompt);
			return { client: defaultClient, directory: undefined };
		}
		const instanceId =
			yield* engine.value.getProviderForSessionEffect(sessionId);
		const selectedId = instanceId ?? MANAGED_OPENCODE_ACCOUNT_ID;
		const running = providerProcessId
			? yield* instances.value.ifRunning(selectedId)
			: Option.some(yield* instances.value.use(selectedId));
		if (
			Option.isNone(running) ||
			(providerProcessId && running.value.promptProcessId !== providerProcessId)
		)
			return yield* prompt
				? expirePrompt(prompt)
				: Effect.fail(
						new WsRpcError({
							message: "The provider process is no longer running.",
						}),
					);
		const client = running.value;
		const session = yield* Effect.tryPromise(() =>
			client.session.get(sessionId),
		);
		return { client, directory: session.directory };
	});

export const handleAskUserResponse = (
	clientId: string,
	payload: AskUserResponsePayload,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const { toolId, answers } = payload;
		const stored = yield* readPromptReference(
			toolId,
			"question",
			wsHandler.getClientSession(clientId),
		);
		if (stored?.status === "resolved") return;
		const sessionId =
			stored?.session_id ?? wsHandler.getClientSession(clientId) ?? "";
		const providerRequestId = stored?.provider_request_id ?? toolId;

		const formatted = formatAnswers(answers);

		log.info(
			`client=${clientId} session=${sessionId} answering: ${toolId} payload=${JSON.stringify({ id: toolId, answers: formatted })}`,
		);

		const pendingInteractionsOption = yield* Effect.serviceOption(
			PendingInteractionServiceTag,
		);
		if (pendingInteractionsOption._tag === "Some") {
			if (
				stored?.provider_process_id &&
				!stored.provider_process_id.startsWith("opencode:")
			) {
				const pendingQuestions =
					yield* pendingInteractionsOption.value.listPendingQuestions();
				if (
					pendingQuestions.some(
						(question) => question.requestId === toolId && question.recovered,
					)
				)
					return yield* expirePrompt(stored);
			}
			const resolvedOption =
				yield* pendingInteractionsOption.value.resolveQuestionFromBrowser(
					toolId,
					answers as Record<string, unknown>,
				);
			const resolved = Option.getOrUndefined(resolvedOption);
			if (resolved) {
				const questionSessionId = resolved.sessionId || sessionId;
				if (resolved.question.recovered) {
					const answerText = resolved.question.questions
						.map(
							(question, index) =>
								`Answer to your question "${question.question}": ${answers[String(index)] ?? ""}`,
						)
						.join("\n");
					const turnsOption = yield* Effect.serviceOption(
						ProviderTurnServiceTag,
					);
					const turns = Option.getOrUndefined(turnsOption);
					if (!turns?.completeRecoveredQuestion) {
						yield* pendingInteractionsOption.value.recoverPendingQuestions([
							resolved.question,
						]);
						return yield* Effect.fail(
							new Error("Recovered question turn service unavailable"),
						);
					}
					const completed = yield* Effect.either(
						turns.completeRecoveredQuestion(
							resolved.question,
							answerText,
							answers,
						),
					);
					if (completed._tag === "Left") {
						yield* pendingInteractionsOption.value.recoverPendingQuestions([
							resolved.question,
						]);
						return yield* Effect.fail(completed.left);
					}
					yield* sendMessageToSession({
						clientId,
						sessionId: questionSessionId,
						text: answerText,
						commandId: payload.commandId ?? createCommandId(),
					});
				}
				const engineOption = yield* Effect.serviceOption(
					OrchestrationEngineTag,
				);
				if (engineOption._tag === "Some") {
					const providerId =
						yield* engineOption.value.getProviderForSessionEffect(
							questionSessionId,
						);
					if (
						(getProviderDriver(providerId) ?? PROVIDER_DRIVERS.opencode)
							.interactionSink !== "permission-asking"
					) {
						log.warn(
							`client=${clientId} session=${questionSessionId} service-owned question ${toolId} resolved for provider=${providerId ?? "unknown"}`,
						);
					}
				}
				// Not announceQuestionResolved: the event sink or the recovered turn
				// records this resolution, not the handler.
				yield* restartProcessingTimeout(questionSessionId);
				return;
			}
		}

		if (
			stored?.provider_process_id &&
			!stored.provider_process_id.startsWith("opencode:")
		)
			return yield* expirePrompt(stored);
		// OpenCode REST API path with fallback for legacy prompt rows.
		const { client, directory } = yield* resolveOpenCodeQuestionTarget(
			sessionId,
			stored,
		);
		const replyResult = yield* Effect.either(
			Effect.tryPromise(() =>
				client.question.reply(providerRequestId, formatted, directory),
			),
		);
		if (replyResult._tag === "Right") {
			yield* announceQuestionResolved(sessionId, toolId, answers);
			return;
		}
		if (stored?.provider_request_id) {
			if (stored.provider_process_id)
				yield* resolveOpenCodeQuestionTarget(sessionId, stored);
			return yield* new WsRpcError({
				message: `OpenCode could not answer this question: ${String(replyResult.left)}`,
			});
		}

		log.warn(
			`client=${clientId} session=${sessionId} replyQuestion failed for ${toolId}: ${replyResult.left}`,
		);

		// Fallback: query pending questions and reply to the first match
		const fallbackResult = yield* Effect.either(
			Effect.gen(function* () {
				const pendingQuestions = yield* Effect.tryPromise(() =>
					client.question.list(directory),
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
						client.question.reply(queId, formatted, directory),
					);
					yield* announceQuestionResolved(
						sessionId,
						stored?.id ?? queId,
						answers,
					);
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

		return yield* new WsRpcError({
			message:
				"This question was asked in a terminal session and can't be answered from the browser. Answer it in the terminal, or send a follow-up message to continue.",
		});
	}).pipe(Effect.scoped);

export const handleQuestionReject = (
	clientId: string,
	payload: QuestionRejectPayload,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const { toolId } = payload;
		if (!toolId) return;

		const stored = yield* readPromptReference(
			toolId,
			"question",
			wsHandler.getClientSession(clientId),
		);
		if (stored?.status === "resolved") return;
		const sessionId =
			stored?.session_id ?? wsHandler.getClientSession(clientId) ?? "";
		const providerRequestId = stored?.provider_request_id ?? toolId;

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
			if (
				stored?.provider_process_id &&
				!stored.provider_process_id.startsWith("opencode:") &&
				pendingQuestion?.recovered
			)
				return yield* expirePrompt(stored);
			if (pendingQuestion) {
				const questionSessionId = pendingQuestion.sessionId || sessionId;
				const engineOption = yield* Effect.serviceOption(
					OrchestrationEngineTag,
				);
				const providerId =
					engineOption._tag === "Some"
						? yield* engineOption.value.getProviderForSessionEffect(
								questionSessionId,
							)
						: undefined;
				if (
					getProviderDriver(providerId)?.interactionSink === "permission-asking"
				) {
					log.warn(
						`client=${clientId} session=${questionSessionId} refused to skip Claude question ${toolId}`,
					);
					return yield* new WsRpcError({
						message:
							"Claude questions require an answer before the turn can continue.",
					});
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
						yield* engineOption.value.getProviderForSessionEffect(
							questionSessionId,
						);
					if (
						(getProviderDriver(providerId) ?? PROVIDER_DRIVERS.opencode)
							.interactionSink !== "permission-asking"
					) {
						log.warn(
							`client=${clientId} session=${questionSessionId} service-owned question reject ${toolId} resolved for provider=${providerId ?? "unknown"}`,
						);
					}
				}
				// A live question's event sink records the resolution; a recovered
				// one has no sink left, so it is recorded here.
				if (resolved.question.recovered) {
					yield* announceQuestionResolved(questionSessionId, toolId, {});
				} else {
					yield* restartProcessingTimeout(questionSessionId);
				}
				return;
			}
		}

		if (
			stored?.provider_process_id &&
			!stored.provider_process_id.startsWith("opencode:")
		)
			return yield* expirePrompt(stored);
		// OpenCode REST API path with fallback for legacy prompt rows.
		const { client, directory } = yield* resolveOpenCodeQuestionTarget(
			sessionId,
			stored,
		);
		const rejectResult = yield* Effect.either(
			Effect.tryPromise(() =>
				client.question.reject(providerRequestId, directory),
			),
		);
		if (rejectResult._tag === "Right") {
			yield* announceQuestionResolved(sessionId, toolId, {});
			return;
		}
		if (stored?.provider_request_id) {
			if (stored.provider_process_id)
				yield* resolveOpenCodeQuestionTarget(sessionId, stored);
			return yield* new WsRpcError({
				message: `OpenCode could not reject this question: ${String(rejectResult.left)}`,
			});
		}

		log.warn(
			`client=${clientId} session=${sessionId} rejectQuestion failed for ${toolId}: ${rejectResult.left}`,
		);

		// Fallback: query pending questions
		const fallbackResult = yield* Effect.either(
			Effect.gen(function* () {
				const pendingQuestions = yield* Effect.tryPromise(() =>
					client.question.list(directory),
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
						`client=${clientId} session=${sessionId} reject fallback: ${toolId} → ${queId}`,
					);
					yield* Effect.tryPromise(() =>
						client.question.reject(queId, directory),
					);
					yield* announceQuestionResolved(sessionId, stored?.id ?? queId, {});
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

		// Fail the RPC so the QuestionCard can show why.
		return yield* new WsRpcError({
			message:
				"This question was asked in a terminal session and can't be skipped from the browser. Answer it in the terminal, or send a follow-up message to continue.",
		});
	}).pipe(Effect.scoped);
