// Handles the initial handshake when a browser client connects via WebSocket.
// Sends session info, model info,
// agent list, provider/model list, and PTY replay to the new client.
//
// Extracted from relay-stack.ts's `client_connected` handler so the logic is
// independently testable and relay-stack stays slim.

import { Effect, Option } from "effect";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import type { OpenCodeProviderList } from "../domain/relay/Services/services.js";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
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
import { formatErrorDetail, RelayError } from "../errors.js";
import type { ProviderCapabilities } from "../provider/types.js";
import { busySessionIds } from "../session-busy.js";
import { findCatalogModel } from "../shared-types.js";
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
): void {
	if (capabilities.models.length === 0) return;
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
}

export interface ClientInitEffectOptions {
	readonly skipDefaultSession?: boolean;
	readonly getInstances?: () =>
		| ReadonlyArray<Readonly<OpenCodeInstance>>
		| PromiseLike<ReadonlyArray<Readonly<OpenCodeInstance>>>;
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
		const hasActiveTimeout = yield* hasActiveProcessingTimeout(sessionId);

		wsHandler.setClientSession(clientId, sessionId);

		const sessionService = yield* SessionManagerServiceTag;
		const family = yield* sessionService.getSessionFamily(sessionId);
		wsHandler.sendTo(clientId, family);
		// The persisted family (children included) is the live status. The
		// poller only holds a copy up to one poll old, which would leave a
		// just-stopped session reading busy after a reload.
		const isProcessing =
			busySessionIds(
				new Map(family.sessions.map((session) => [session.id, session])),
			).has(sessionId) || hasActiveTimeout;
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
		if (activeId) {
			const family = yield* switchClientToSessionForInitEffect(
				clientId,
				activeId,
			);
			for (const session of family?.sessions ?? []) familyIds.add(session.id);

			const sessionModel = yield* getModel(activeId);
			if (sessionModel) {
				wsHandler.sendTo(clientId, {
					type: "model_info",
					sessionId: activeId,
					model: sessionModel.modelID,
					provider: sessionModel.providerID,
				});
			}
		}

		return {
			activeId,
			validatedRequestedSessionId,
			familyIds,
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
		const pendingInteractions = yield* PendingInteractionServiceTag;

		const servicePending = yield* pendingInteractions.listPendingPermissions();
		for (const { timestamp: _, ...perm } of servicePending) {
			// Spread, not a field list: a reload must rebuild the same card the
			// live prompt showed (title, description, reason).
			wsHandler.sendTo(clientId, { type: "permission_request", ...perm });
		}
	});

const replayPendingQuestionsEffect = (
	clientId: string,
	activeId: string | undefined,
	familyIds: ReadonlySet<string>,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const log = yield* LoggerTag;

		const questionReplayResult = yield* Effect.either(
			Effect.gen(function* () {
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
				}
			}),
		);
		if (questionReplayResult._tag === "Left") {
			log.warn(
				`Failed to replay pending questions: ${formatErrorDetail(questionReplayResult.left)}`,
			);
		}
	});

const sendProvidersAndSettingsEffect = (
	clientId: string,
	activeId: string | undefined,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const modelService = yield* OpenCodeModelServiceTag;
		const engine = yield* OrchestrationEngineTag;
		const log = yield* LoggerTag;

		const providerResult = yield* Effect.either(
			Effect.gen(function* () {
				// Attach never contacts OpenCode: use the cached catalog, if any.
				// The model picker refreshes it through GetModels.
				const openCodeCatalog = yield* modelService.cachedProviders();
				const providers = Option.match(openCodeCatalog, {
					onNone: () => [],
					onSome: toConfiguredOpenCodeProviders,
				});

				const claudeCapsResult = yield* Effect.either(
					engine.dispatchEffect({
						type: "discover",
						providerId: "claude",
					}),
				);
				if (claudeCapsResult._tag === "Right") {
					addClaudeProvider(providers, claudeCapsResult.right);
				}
				if (claudeCapsResult._tag === "Left" && providers.length === 0) {
					return yield* Effect.fail(claudeCapsResult.left);
				}

				const currentVariant = activeId
					? yield* getVariant(activeId)
					: yield* getDefaultVariant();
				const activeModel = activeId
					? yield* getModel(activeId)
					: yield* getDefaultModel();
				// After a restart this snapshot is all an open tab gets, and a
				// session restored from `opus[1m]` must still find today's `opus`.
				const catalogModel = findCatalogModel(providers, activeModel);
				wsHandler.sendTo(clientId, {
					type: "variant_info",
					variant: currentVariant,
					variants: catalogModel?.variants ?? [],
				});
				wsHandler.sendTo(clientId, {
					type: "context_window_info",
					contextWindow: activeId
						? yield* getContextWindow(activeId)
						: yield* getDefaultContextWindow(),
					options: catalogModel?.contextWindowOptions ?? [],
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

				if (!defaultModel && Option.isSome(openCodeCatalog)) {
					for (const providerId of openCodeCatalog.value.connected) {
						const defaultModelId = openCodeCatalog.value.defaults[providerId];
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

const replayInstancesEffect = (
	clientId: string,
	options: ClientInitEffectOptions,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;

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
		const { activeId, familyIds } = yield* resolveAndReplaySessionEffect(
			clientId,
			requestedSessionId,
			options,
		);
		yield* pushViewedFamiliesForInitEffect(clientId);
		yield* replayPendingPermissionsEffect(clientId);
		yield* replayPendingQuestionsEffect(clientId, activeId, familyIds);
		yield* sendProvidersAndSettingsEffect(clientId, activeId);
		yield* replayInstancesEffect(clientId, options);
	});
