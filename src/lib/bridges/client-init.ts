// Handles the initial handshake when a browser client connects via WebSocket.
// Sends session info, model info,
// agent list, provider/model list, and PTY replay to the new client.
//
// Extracted from relay-stack.ts's `client_connected` handler so the logic is
// independently testable and relay-stack stays slim.

import { Effect } from "effect";
import { mapQuestionFields } from "../bridges/question-bridge.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import type { OpenCodeProviderList } from "../domain/relay/Services/services.js";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import type { ModelOverride } from "../domain/relay/Services/session-overrides-state.js";
import {
	getContextWindow,
	getDefaultContextWindow,
	getDefaultModel,
	getDefaultPermissionMode,
	getDefaultVariant,
	getModel,
	getPermissionMode,
	getVariant,
	hasActiveProcessingTimeout,
	setDefaultModel,
} from "../domain/relay/Services/session-overrides-state.js";
import { OpenCodeTerminalServiceTag } from "../domain/relay/Services/terminal-service.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import type { ProviderCapabilities } from "../provider/types.js";
import { busySessionIds } from "../session-busy.js";
import { findContextWindowOptions } from "../shared-types.js";
import type { OpenCodeInstance, ProviderInfo } from "../types.js";

function toConfiguredOpenCodeProviders(
	providerResult: OpenCodeProviderList,
): ProviderInfo[] {
	const connectedSet = new Set(providerResult.connected);
	return providerResult.providers
		.map((p) => ({
			id: p.id || p.name || "",
			name: p.name || p.id || "",
			configured: connectedSet.has(p.id) || connectedSet.has(p.name),
			models: (p.models ?? []).map((m) => ({
				id: m.id,
				name: m.name || m.id,
				provider: p.id || p.name || "",
				...(m.limit && { limit: m.limit }),
				...(m.variants &&
					Object.keys(m.variants).length > 0 && {
						variants: Object.keys(m.variants),
					}),
			})),
		}))
		.filter((p) => p.configured);
}

function addClaudeProvider(
	providers: ProviderInfo[],
	capabilities: ProviderCapabilities,
): boolean {
	if (capabilities.models.length === 0) return false;
	for (const p of providers) {
		if (p.id === "anthropic") {
			p.name = "Anthropic - opencode";
		}
	}
	providers.push({
		id: "claude",
		name: "Anthropic - claude",
		configured: true,
		models: capabilities.models.map((m) => ({
			id: m.id,
			name: m.name,
			provider: "claude",
			...(m.limit ? { limit: m.limit } : {}),
			...(m.variants && Object.keys(m.variants).length > 0
				? { variants: Object.keys(m.variants) }
				: {}),
			...(m.contextWindowOptions && m.contextWindowOptions.length > 0
				? {
						contextWindowOptions: m.contextWindowOptions.map((option) => ({
							value: option.value,
							label: option.label,
							...(option.isDefault != null
								? { isDefault: option.isDefault }
								: {}),
						})),
					}
				: {}),
		})),
	});
	return true;
}

export interface ClientInitEffectOptions {
	readonly skipDefaultSession?: boolean;
	readonly getInstances?: () =>
		| ReadonlyArray<Readonly<OpenCodeInstance>>
		| PromiseLike<ReadonlyArray<Readonly<OpenCodeInstance>>>;
	readonly getCachedUpdate?: () => string | null | PromiseLike<string | null>;
}

const sendInitErrorEffect = (clientId: string, err: unknown, prefix: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		log.warn(`${prefix}: ${formatErrorDetail(err)}`);
		wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "INIT_FAILED", prefix).toSystemError(),
		);
	});

const switchClientToSessionForInitEffect = (
	clientId: string,
	sessionId: string,
) =>
	Effect.gen(function* () {
		if (!sessionId) return;

		const wsHandler = yield* WebSocketHandlerTag;
		const statusPoller = yield* StatusPollerTag;
		const hasActiveTimeout = yield* hasActiveProcessingTimeout(sessionId);

		wsHandler.setClientSession(clientId, sessionId);

		const sessionService = yield* SessionManagerServiceTag;
		const family = yield* sessionService.getSessionFamily(sessionId);
		wsHandler.sendTo(clientId, family);
		// The poller is cold until its first poll and never starts without
		// OpenCode, so the persisted family (children included) also counts.
		const isProcessing =
			busySessionIds(
				new Map(family.sessions.map((session) => [session.id, session])),
			).has(sessionId) ||
			(yield* statusPoller.isProcessing(sessionId)) ||
			hasActiveTimeout;
		wsHandler.sendTo(clientId, {
			type: "status",
			sessionId,
			status: isProcessing ? "processing" : "idle",
		});
		return family;
	});

const resolveAndReplaySessionEffect = (
	clientId: string,
	requestedSessionId: string | undefined,
	options: ClientInitEffectOptions,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionService = yield* SessionManagerServiceTag;
		const modelService = yield* OpenCodeModelServiceTag;
		const log = yield* LoggerTag;

		// An unknown requested id selects no session, never the default: the
		// frontend's route resolve owns the not-found banner. A failed check is
		// not a missing session, so the id is trusted and the frontend's resolve
		// surfaces the failure.
		const validatedRequestedSessionId = requestedSessionId
			? yield* sessionService.sessionExists(requestedSessionId).pipe(
					Effect.match({
						onFailure: (err) => {
							log.warn(
								`Could not verify requested session ${requestedSessionId}: ${formatErrorDetail(err)}`,
							);
							return requestedSessionId;
						},
						onSuccess: (exists) => {
							if (exists) return requestedSessionId;
							log.info(
								`Requested session ${requestedSessionId} not found; no session selected`,
							);
							return undefined;
						},
					}),
				)
			: undefined;

		const activeIdResult = requestedSessionId
			? ({ _tag: "Right", right: validatedRequestedSessionId } as const)
			: options.skipDefaultSession
				? ({ _tag: "Right", right: undefined } as const)
				: yield* Effect.either(sessionService.getDefaultSessionId());
		const activeId =
			activeIdResult._tag === "Right" ? activeIdResult.right : undefined;
		if (activeIdResult._tag === "Left") {
			yield* sendInitErrorEffect(
				clientId,
				activeIdResult.left,
				"Failed to load default session",
			);
		}

		const familyIds = new Set<string>(activeId ? [activeId] : []);
		let activeSessionModel: ModelOverride | undefined;
		if (activeId) {
			const family = yield* switchClientToSessionForInitEffect(
				clientId,
				activeId,
			);
			for (const session of family?.sessions ?? []) familyIds.add(session.id);

			const sessionInfoResult = yield* Effect.either(
				modelService.getSession(activeId),
			);
			if (sessionInfoResult._tag === "Right") {
				const session = sessionInfoResult.right;
				if (session.modelID) {
					activeSessionModel = {
						modelID: session.modelID,
						providerID: session.providerID ?? "",
					};
					wsHandler.sendTo(clientId, {
						type: "model_info",
						sessionId: activeId,
						model: session.modelID,
						provider: session.providerID ?? "",
					});
				} else {
					const fallbackModel = yield* getModel(activeId);
					if (fallbackModel) {
						wsHandler.sendTo(clientId, {
							type: "model_info",
							sessionId: activeId,
							model: fallbackModel.modelID,
							provider: fallbackModel.providerID,
						});
					}
				}
			} else {
				yield* Effect.sync(() =>
					log.warn(
						`Failed to load session info for ${activeId}: ${sessionInfoResult.left}`,
					),
				);
				const fallbackModel = yield* getModel(activeId);
				if (fallbackModel) {
					wsHandler.sendTo(clientId, {
						type: "model_info",
						sessionId: activeId,
						model: fallbackModel.modelID,
						provider: fallbackModel.providerID,
					});
				}
			}
		}

		return {
			activeId,
			validatedRequestedSessionId,
			familyIds,
			activeSessionModel,
		};
	});

const pushViewedFamiliesForInitEffect = (clientId: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionService = yield* SessionManagerServiceTag;
		yield* sessionService.pushViewerFamilies().pipe(
			Effect.catchAll((err) =>
				sendInitErrorEffect(clientId, err, "Failed to push viewed families"),
			),
			Effect.ensuring(
				Effect.sync(() => wsHandler.markClientBootstrapped(clientId)),
			),
		);
	});

const replayPendingPermissionsEffect = (clientId: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const client = yield* OpenCodeAPITag;
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const log = yield* LoggerTag;

		const servicePending = yield* pendingInteractions.listPendingPermissions();
		const sentPermissionIds = new Set<string>();
		for (const { timestamp: _, ...perm } of servicePending) {
			// Spread, not a field list: a reload must rebuild the same card the
			// live prompt showed (title, description, reason).
			wsHandler.sendTo(clientId, { type: "permission_request", ...perm });
			sentPermissionIds.add(perm.requestId);
		}

		const apiPermissionsResult = yield* Effect.either(
			Effect.gen(function* () {
				const apiPermissions = yield* Effect.tryPromise(() =>
					client.permission.list(),
				);
				const newPerms = apiPermissions.filter(
					(p) => !sentPermissionIds.has(p.id),
				);
				if (newPerms.length === 0) return;

				const recoveryInput = newPerms.map((p) => {
					const raw = p as {
						id: string;
						permission: string;
						sessionID?: string;
						patterns?: string[];
						metadata?: Record<string, unknown>;
						always?: string[];
					};
					return {
						id: raw.id,
						permission: raw.permission,
						...(raw.sessionID != null && { sessionId: raw.sessionID }),
						...(raw.patterns != null && { patterns: raw.patterns }),
						...(raw.metadata != null && { metadata: raw.metadata }),
						...(raw.always != null && { always: raw.always }),
					};
				});
				const recovered =
					yield* pendingInteractions.recoverPendingPermissions(recoveryInput);
				for (const perm of recovered) {
					wsHandler.sendTo(clientId, {
						type: "permission_request",
						sessionId: perm.sessionId,
						requestId: perm.requestId,
						toolName: perm.toolName,
						toolInput: perm.toolInput,
					});
				}
			}),
		);
		if (apiPermissionsResult._tag === "Left") {
			log.warn(
				`Failed to fetch pending permissions from API: ${formatErrorDetail(apiPermissionsResult.left)}`,
			);
		}
	});

const replayPendingQuestionsEffect = (
	clientId: string,
	activeId: string | undefined,
	familyIds: ReadonlySet<string>,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const client = yield* OpenCodeAPITag;
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const log = yield* LoggerTag;

		const questionReplayResult = yield* Effect.either(
			Effect.gen(function* () {
				const sentQuestionIds = new Set<string>();
				const servicePendingQuestions =
					yield* pendingInteractions.listPendingQuestions();
				for (const pq of servicePendingQuestions) {
					if (pq.sessionId && activeId && !familyIds.has(pq.sessionId))
						continue;
					wsHandler.sendTo(clientId, {
						type: "ask_user",
						sessionId: pq.sessionId || activeId || "",
						toolId: pq.requestId,
						questions: pq.questions.map((q) => ({
							question: q.question,
							header: q.header ?? "",
							options: (q.options ?? []) as Array<{
								label: string;
								description?: string;
							}>,
							multiSelect: q.multiSelect ?? false,
						})),
						...(pq.toolCallId ? { toolUseId: pq.toolCallId } : {}),
						...(pq.providerId ? { providerId: pq.providerId } : {}),
					});
					sentQuestionIds.add(pq.requestId);
				}
				const pendingQuestions = yield* Effect.tryPromise(() =>
					client.question.list(),
				);
				log.debug(
					`client=${clientId} listPendingQuestions returned ${pendingQuestions.length} question(s)${pendingQuestions.length > 0 ? `: ${JSON.stringify(pendingQuestions.map((q) => ({ id: q.id, hasQuestions: !!q["questions"], hasTool: !!q["tool"] })))}` : ""}`,
				);
				for (const pq of pendingQuestions) {
					if (sentQuestionIds.has(pq.id)) continue;
					const qSessionId = pq["sessionID"] as string | undefined;
					if (qSessionId && activeId && !familyIds.has(qSessionId)) continue;

					const rawQuestions = pq["questions"] as
						| Array<{
								question?: string;
								header?: string;
								options?: Array<{ label?: string; description?: string }>;
								multiple?: boolean;
								custom?: boolean;
						  }>
						| undefined;
					if (!Array.isArray(rawQuestions)) {
						log.debug(
							`client=${clientId} skipping question ${pq.id}: questions field is not an array (${typeof pq["questions"]})`,
						);
						continue;
					}
					const questions = mapQuestionFields(rawQuestions);
					const tool = pq["tool"] as { callID?: string } | undefined;
					const toolCallId = tool?.callID;
					log.debug(
						`client=${clientId} sending ask_user: toolId=${pq.id} toolUseId=${toolCallId ?? "none"} questionCount=${questions.length}`,
					);
					wsHandler.sendTo(clientId, {
						type: "ask_user",
						sessionId: qSessionId ?? activeId ?? "",
						toolId: pq.id,
						questions,
						providerId: "opencode",
						...(toolCallId ? { toolUseId: toolCallId } : {}),
					});
				}
			}),
		);
		if (questionReplayResult._tag === "Left") {
			log.warn(
				`Failed to replay pending questions: ${formatErrorDetail(questionReplayResult.left)}`,
			);
		}
	});

const sendAgentListEffect = (clientId: string, activeId: string | undefined) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const agentService = yield* AgentServiceTag;

		const agentResult = yield* Effect.either(agentService.listAgents(activeId));
		if (agentResult._tag === "Right") {
			wsHandler.sendTo(clientId, {
				type: "agent_list",
				providerScope: agentResult.right.providerScope,
				agents: [...agentResult.right.agents],
				...(agentResult.right.activeAgentId
					? { activeAgentId: agentResult.right.activeAgentId }
					: {}),
			});
		} else {
			yield* sendInitErrorEffect(
				clientId,
				agentResult.left,
				"Failed to list agents",
			);
		}
	});

const sendProvidersAndSettingsEffect = (
	clientId: string,
	activeId: string | undefined,
	activeSessionModel: ModelOverride | undefined,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const modelService = yield* OpenCodeModelServiceTag;
		const engine = yield* OrchestrationEngineTag;
		const log = yield* LoggerTag;

		const providerResult = yield* Effect.either(
			Effect.gen(function* () {
				const openCodeProviderResult = yield* Effect.either(
					modelService.listProviders(),
				);
				const providers =
					openCodeProviderResult._tag === "Right"
						? toConfiguredOpenCodeProviders(openCodeProviderResult.right)
						: [];
				if (openCodeProviderResult._tag === "Right") {
					wsHandler.sendTo(clientId, { type: "model_list", providers });
				} else {
					log.warn(
						`OpenCode provider discovery failed during client init: ${formatErrorDetail(openCodeProviderResult.left)}`,
					);
				}

				const claudeCapsResult = yield* Effect.either(
					engine.dispatchEffect({
						type: "discover",
						providerId: "claude",
					}),
				);
				if (
					claudeCapsResult._tag === "Right" &&
					addClaudeProvider(providers, claudeCapsResult.right)
				) {
					wsHandler.sendTo(clientId, { type: "model_list", providers });
				}
				if (
					openCodeProviderResult._tag === "Left" &&
					(claudeCapsResult._tag === "Left" || providers.length === 0)
				) {
					return yield* Effect.fail(openCodeProviderResult.left);
				}

				const currentVariant = activeId
					? yield* getVariant(activeId)
					: yield* getDefaultVariant();
				const activeModelOverride = activeId
					? yield* getModel(activeId)
					: yield* getDefaultModel();
				const activeModel = activeId
					? (activeModelOverride ?? activeSessionModel)
					: activeModelOverride;
				const activeModelId = activeModel?.modelID;
				let availableVariants: string[] = [];
				if (activeModelId) {
					for (const p of providers) {
						const model = p.models.find(
							(m: { id: string; variants?: string[] }) =>
								m.id === activeModelId,
						);
						if (model?.variants) {
							availableVariants = model.variants;
							break;
						}
					}
				}
				wsHandler.sendTo(clientId, {
					type: "variant_info",
					variant: currentVariant,
					variants: availableVariants,
				});
				wsHandler.sendTo(clientId, {
					type: "context_window_info",
					contextWindow: activeId
						? yield* getContextWindow(activeId)
						: yield* getDefaultContextWindow(),
					options: findContextWindowOptions(providers, activeModelId),
				});
				wsHandler.sendTo(clientId, {
					type: "permission_mode_info",
					// No session yet: report the mode one would start in, not "ask".
					// getPermissionMode already falls back to the default itself.
					mode: activeId
						? yield* getPermissionMode(activeId)
						: yield* getDefaultPermissionMode(),
				});

				const defaultModel = yield* getDefaultModel();
				if (defaultModel) {
					wsHandler.sendTo(clientId, {
						type: "default_model_info",
						model: defaultModel.modelID,
						provider: defaultModel.providerID,
						variant: yield* getDefaultVariant(),
					});
				}
				wsHandler.sendTo(clientId, {
					type: "default_permission_mode_info",
					mode: yield* getDefaultPermissionMode(),
				});

				if (!defaultModel && openCodeProviderResult._tag === "Right") {
					for (const providerId of openCodeProviderResult.right.connected) {
						const defaultModelId =
							openCodeProviderResult.right.defaults[providerId];
						if (defaultModelId) {
							yield* setDefaultModel({
								providerID: providerId,
								modelID: defaultModelId,
							});
							wsHandler.broadcast({
								type: "model_info",
								model: defaultModelId,
								provider: providerId,
							});
							log.info(
								`Auto-selected default: ${defaultModelId} (${providerId})`,
							);
							break;
						}
					}
				} else if (
					!defaultModel &&
					providers.some((provider) => provider.id === "claude")
				) {
					const defaultClaudeModel = providers
						.find((provider) => provider.id === "claude")
						?.models.at(0);
					if (defaultClaudeModel) {
						yield* setDefaultModel({
							providerID: "claude",
							modelID: defaultClaudeModel.id,
						});
						wsHandler.broadcast({
							type: "model_info",
							model: defaultClaudeModel.id,
							provider: "claude",
						});
						log.info(
							`Auto-selected default: ${defaultClaudeModel.id} (claude)`,
						);
					}
				} else if (
					defaultModel &&
					providers.some((provider) => provider.id === defaultModel.providerID)
				) {
					wsHandler.sendTo(clientId, {
						type: "model_info",
						model: defaultModel.modelID,
						provider: defaultModel.providerID,
					});
					log.info(
						`Default: ${defaultModel.modelID} (${defaultModel.providerID})`,
					);
				}
			}),
		);
		if (providerResult._tag === "Left") {
			yield* sendInitErrorEffect(
				clientId,
				providerResult.left,
				"Failed to list providers",
			);
		}
	});

const replayTerminalsInstancesAndUpdateEffect = (
	clientId: string,
	options: ClientInitEffectOptions,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const terminal = yield* OpenCodeTerminalServiceTag;

		yield* terminal
			.replay(clientId)
			.pipe(
				Effect.catchAll((err) =>
					sendInitErrorEffect(clientId, err, "Failed to replay terminals"),
				),
			);

		if (options.getInstances) {
			const instances = yield* Effect.tryPromise({
				try: () => Promise.resolve(options.getInstances?.() ?? []),
				catch: (cause) => cause,
			}).pipe(
				Effect.catchAll((err) =>
					sendInitErrorEffect(clientId, err, "Failed to list instances").pipe(
						Effect.as([] as ReadonlyArray<Readonly<OpenCodeInstance>>),
					),
				),
			);
			wsHandler.sendTo(clientId, { type: "instance_list", instances });
		}

		if (options.getCachedUpdate) {
			const version = yield* Effect.tryPromise({
				try: () => Promise.resolve(options.getCachedUpdate?.() ?? null),
				catch: (cause) => cause,
			}).pipe(
				Effect.catchAll((err) =>
					sendInitErrorEffect(clientId, err, "Failed to replay update").pipe(
						Effect.as(null),
					),
				),
			);
			if (version) {
				wsHandler.sendTo(clientId, { type: "update_available", version });
			}
		}
	});

/**
 * Effect-owned production client bootstrap. This is the canonical relay path.
 */
export const handleClientConnectedEffect = (
	clientId: string,
	requestedSessionId?: string,
	options: ClientInitEffectOptions = {},
) =>
	Effect.gen(function* () {
		const { activeId, familyIds, activeSessionModel } =
			yield* resolveAndReplaySessionEffect(
				clientId,
				requestedSessionId,
				options,
			);
		yield* pushViewedFamiliesForInitEffect(clientId);
		yield* replayPendingPermissionsEffect(clientId);
		yield* replayPendingQuestionsEffect(clientId, activeId, familyIds);
		yield* sendAgentListEffect(clientId, activeId);
		yield* sendProvidersAndSettingsEffect(
			clientId,
			activeId,
			activeSessionModel,
		);
		yield* replayTerminalsInstancesAndUpdateEffect(clientId, options);
	});
