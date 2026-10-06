// Handles the initial handshake when a browser client connects via WebSocket.
// Sends session info, model info,
// agent list, provider/model list, and PTY replay to the new client.
//
// Extracted from relay-stack.ts's `client_connected` handler so the logic is
// independently testable and relay-stack stays slim.

import { Effect, Option } from "effect";
import { publishProjectSetting } from "../domain/relay/Services/project-settings.js";
import type { OpenCodeProviderList } from "../domain/relay/Services/services.js";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	getDefaultModel,
	getDefaultVariant,
	setDefaultModel,
} from "../domain/relay/Services/session-overrides-state.js";
import { formatErrorDetail } from "../errors.js";
import type { ProviderCapabilities } from "../provider/types.js";
import type { ProviderInfo } from "../types.js";

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
}

// Init failures are background-task errors (fork 3.2): log only, the
// browser renders whatever init did deliver.
const logInitErrorEffect = (err: unknown, prefix: string) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		log.warn(`${prefix}: ${formatErrorDetail(err)}`);
	});

const switchClientToSessionForInitEffect = (
	clientId: string,
	sessionId: string,
) =>
	Effect.gen(function* () {
		if (!sessionId) return;

		const wsHandler = yield* WebSocketHandlerTag;

		wsHandler.setClientSession(clientId, sessionId);

		const sessionService = yield* SessionManagerServiceTag;
		const family = yield* sessionService.getSessionFamily(sessionId);
		wsHandler.sendTo(clientId, family);
		return family;
	});

const resolveAndReplaySessionEffect = (
	clientId: string,
	requestedSessionId: string | undefined,
	options: ClientInitEffectOptions,
) =>
	Effect.gen(function* () {
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
			yield* logInitErrorEffect(
				activeIdResult.left,
				"Failed to load default session",
			);
		}

		if (activeId) {
			yield* switchClientToSessionForInitEffect(clientId, activeId);
		}

		return {
			activeId,
			validatedRequestedSessionId,
		};
	});

const pushViewedFamiliesForInitEffect = (clientId: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionService = yield* SessionManagerServiceTag;
		yield* sessionService.pushViewerFamilies().pipe(
			Effect.catchAll((err) =>
				logInitErrorEffect(err, "Failed to push viewed families"),
			),
			Effect.ensuring(
				Effect.sync(() => wsHandler.markClientBootstrapped(clientId)),
			),
		);
	});

const sendProvidersAndSettingsEffect = (clientId: string) =>
	Effect.gen(function* () {
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

				// The session's model, effort, context window and approval mode
				// reach the tab on its shell row and the GetModels response;
				// defaults ride SubscribeProjectSettings.
				const defaultModel = yield* getDefaultModel();
				if (!defaultModel && Option.isSome(openCodeCatalog)) {
					for (const providerId of openCodeCatalog.value.connected) {
						const defaultModelId = openCodeCatalog.value.defaults[providerId];
						if (defaultModelId) {
							yield* setDefaultModel({
								providerID: providerId,
								modelID: defaultModelId,
							});
							yield* publishProjectSetting({
								_tag: "defaultModel",
								model: defaultModelId,
								provider: providerId,
								variant: yield* getDefaultVariant(),
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
						yield* publishProjectSetting({
							_tag: "defaultModel",
							model: defaultClaudeModel.id,
							provider: "claude",
							variant: yield* getDefaultVariant(),
						});
						log.info(
							`Auto-selected default: ${defaultClaudeModel.id} (claude)`,
						);
					}
				} else if (
					defaultModel &&
					providers.some((provider) => provider.id === defaultModel.providerID)
				) {
					log.info(
						`Default: ${defaultModel.modelID} (${defaultModel.providerID})`,
					);
				}
			}),
		);
		if (providerResult._tag === "Left") {
			yield* logInitErrorEffect(
				providerResult.left,
				"Failed to list providers",
			);
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
		yield* resolveAndReplaySessionEffect(clientId, requestedSessionId, options);
		yield* pushViewedFamiliesForInitEffect(clientId);
		yield* sendProvidersAndSettingsEffect(clientId);
	});
