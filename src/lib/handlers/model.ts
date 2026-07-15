// ─── Model Handlers ──────────────────────────────────────────────────────────

import { Data, Effect } from "effect";
import type { GetModelsResponse } from "../contracts/ws-rpc.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import {
	getContextWindow,
	getDefaultContextWindow,
	getDefaultModel,
	getDefaultVariant,
	getModel,
	getVariant,
	type ModelOverride,
	type OverridesStateTag,
	setDefaultModel,
	setDefaultVariant,
	setModel,
	setVariant,
} from "../domain/relay/Services/session-overrides-state.js";
import { formatErrorDetail } from "../errors.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../relay/relay-settings.js";
import type { ContextWindowOption, ProviderInfo } from "../shared-types.js";

class RelaySettingsSaveError extends Data.TaggedError(
	"RelaySettingsSaveError",
)<{
	readonly cause: unknown;
}> {}

const saveRelaySettingsEffect = (
	settings: Parameters<typeof saveRelaySettings>[0],
	configDir?: string,
) =>
	Effect.try({
		try: () => saveRelaySettings(settings, configDir),
		catch: (cause) => new RelaySettingsSaveError({ cause }),
	});

/**
 * Determines if a provider ID refers to the in-process Claude SDK provider.
 * (not OpenCode's "anthropic" provider which proxies to Anthropic via
 * OpenCode's own REST API). Only the literal "claude" provider ID
 * routes through the ClaudeProviderInstance — all other providers (including
 * "anthropic") route through OpenCodeProviderInstance.
 */
export function isClaudeProvider(providerId: string): boolean {
	return providerId === "claude";
}

/** Helper: resolve session from WebSocketHandler context. */
const resolveSessionFromContext = (clientId: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		return wsHandler.getClientSession(clientId);
	});

function findContextWindowOptions(
	providers: ReadonlyArray<{
		models: ReadonlyArray<{
			id: string;
			contextWindowOptions?: readonly ContextWindowOption[];
		}>;
	}>,
	modelId: string | undefined,
): readonly ContextWindowOption[] {
	if (!modelId) return [];
	for (const provider of providers) {
		const model = provider.models.find((m) => m.id === modelId);
		if (model?.contextWindowOptions) return model.contextWindowOptions;
	}
	return [];
}

const cloneContextWindowOptions = (
	options:
		| readonly {
				readonly value: string;
				readonly label: string;
				readonly isDefault?: boolean | undefined;
		  }[]
		| undefined,
): ContextWindowOption[] | undefined =>
	options?.map((option) =>
		option.isDefault == null
			? { value: option.value, label: option.label }
			: {
					value: option.value,
					label: option.label,
					isDefault: option.isDefault,
				},
	);

const loadVariantsForModel = (activeModel: ModelOverride | undefined) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		if (!activeModel) return [] as string[];

		if (isClaudeProvider(activeModel.providerID)) {
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "None") return [] as string[];

			const capsResult = yield* Effect.either(
				engineOption.value.dispatchEffect({
					type: "discover",
					providerId: "claude",
				}),
			);
			if (capsResult._tag === "Left") {
				log.warn(
					`Failed to fetch Claude variant list: ${capsResult.left instanceof Error ? capsResult.left.message : capsResult.left}`,
				);
				return [] as string[];
			}

			const model = capsResult.right.models.find(
				(m) => m.id === activeModel.modelID,
			);
			return model?.variants ? Object.keys(model.variants) : [];
		}

		const modelService = yield* OpenCodeModelServiceTag;
		const provListResult = yield* Effect.either(modelService.listProviders());
		if (provListResult._tag === "Left") {
			log.warn(
				`Failed to fetch variant list: ${provListResult.left instanceof Error ? provListResult.left.message : provListResult.left}`,
			);
			return [] as string[];
		}

		for (const provider of provListResult.right.providers) {
			const model = (provider.models ?? []).find(
				(candidate) => candidate.id === activeModel.modelID,
			);
			if (model?.variants) return Object.keys(model.variants);
		}

		return [] as string[];
	});

const shouldBindOpenCodeSessionOnModelSwitch = (sessionId: string) =>
	Effect.gen(function* () {
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		if (readQueryOption._tag === "None") return true;

		const rowResult = yield* Effect.either(
			readQueryOption.value.getSession(sessionId),
		);
		if (rowResult._tag === "Left") return true;

		const row = rowResult.right;
		return !row || row.provider === "opencode";
	});

// ─── Bedrock geo-routing grouping ────────────────────────────────────────────
// OpenCode's amazon-bedrock catalog lists each model once per inference-profile
// scope (bare id, us., eu., apac., global.). Collapse them into one entry with
// routingOptions (value = full model id). Global is the default: it is the only
// scope AWS guarantees is invokable from any commercial source region.

const GEO_PREFIX_PATTERN = /^(global|us|eu|apac|jp|au|us-gov)\.(.+)$/;
const IN_REGION_SCOPE = "in-region";
const GEO_SCOPE_ORDER = [
	"global",
	"us",
	"eu",
	"apac",
	"jp",
	"au",
	"us-gov",
	IN_REGION_SCOPE,
];
const GEO_SCOPE_LABELS: Record<string, string> = {
	global: "Global",
	us: "US",
	eu: "EU",
	apac: "APAC",
	jp: "JP",
	au: "AU",
	"us-gov": "US Gov",
	[IN_REGION_SCOPE]: "In-region",
};

export function groupGeoRoutingModels<T extends { id: string; name: string }>(
	models: ReadonlyArray<T>,
): Array<T & { routingOptions?: ContextWindowOption[] }> {
	const groups = new Map<string, Array<{ scope: string; model: T }>>();
	for (const model of models) {
		const match = model.id.match(GEO_PREFIX_PATTERN);
		const scope = match?.[1] ?? IN_REGION_SCOPE;
		const baseId = match?.[2] ?? model.id;
		const entries = groups.get(baseId) ?? [];
		entries.push({ scope, model });
		groups.set(baseId, entries);
	}

	const result: Array<T & { routingOptions?: ContextWindowOption[] }> = [];
	for (const entries of groups.values()) {
		const first = entries[0];
		if (!first) continue;
		if (entries.length === 1) {
			result.push(first.model);
			continue;
		}
		entries.sort(
			(a, b) =>
				GEO_SCOPE_ORDER.indexOf(a.scope) - GEO_SCOPE_ORDER.indexOf(b.scope),
		);
		const defaultEntry =
			entries.find((e) => e.scope === "global") ??
			entries.find((e) => e.scope === IN_REGION_SCOPE) ??
			first;
		const bareName = entries.find((e) => e.scope === IN_REGION_SCOPE)?.model
			.name;
		result.push({
			...defaultEntry.model,
			name: bareName ?? defaultEntry.model.name.replace(/\s*\([^)]*\)$/, ""),
			routingOptions: entries.map((e) => ({
				value: e.model.id,
				label: GEO_SCOPE_LABELS[e.scope] ?? e.scope,
				...(e === defaultEntry ? { isDefault: true } : {}),
			})),
		});
	}
	return result;
}

const toSharedProviders = (
	providers: GetModelsResponse["providers"],
): ProviderInfo[] =>
	providers.map((provider) => ({
		id: provider.id,
		name: provider.name,
		configured: provider.configured,
		models: provider.models.map((model) => ({
			id: model.id,
			name: model.name,
			provider: model.provider,
			...(model.cost
				? {
						cost: {
							...(model.cost.input != null ? { input: model.cost.input } : {}),
							...(model.cost.output != null
								? { output: model.cost.output }
								: {}),
						},
					}
				: {}),
			...(model.limit
				? {
						limit: {
							...(model.limit.context != null
								? { context: model.limit.context }
								: {}),
							...(model.limit.output != null
								? { output: model.limit.output }
								: {}),
						},
					}
				: {}),
			...(model.variants ? { variants: [...model.variants] } : {}),
			...(model.contextWindowOptions
				? {
						contextWindowOptions:
							cloneContextWindowOptions(model.contextWindowOptions) ?? [],
					}
				: {}),
			...(model.routingOptions
				? {
						routingOptions:
							cloneContextWindowOptions(model.routingOptions) ?? [],
					}
				: {}),
		})),
	}));

export const getModelsResponse = (
	input: {
		readonly projectSlug?: string;
		readonly clientId?: string;
		readonly sessionId?: string;
	} = {},
): Effect.Effect<
	GetModelsResponse,
	unknown,
	| LoggerTag
	| OpenCodeModelServiceTag
	| OrchestrationEngineTag
	| OverridesStateTag
	| WebSocketHandlerTag
> =>
	Effect.gen(function* () {
		const modelService = yield* OpenCodeModelServiceTag;
		const log = yield* LoggerTag;
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);

		const activeId =
			input.sessionId ??
			(input.clientId
				? yield* resolveSessionFromContext(input.clientId)
				: undefined);
		const fallbackModel = activeId
			? yield* getModel(activeId)
			: yield* getDefaultModel();
		const activeProviderId =
			activeId &&
			engineOption._tag === "Some" &&
			typeof engineOption.value.getProviderForSession === "function"
				? engineOption.value.getProviderForSession(activeId)
				: undefined;
		const activeSessionUsesClaude =
			activeId != null &&
			isClaudeProvider(activeProviderId ?? fallbackModel?.providerID ?? "");

		const providers: ProviderInfo[] = [];
		let openCodeDiscoveryFailed = false;
		let openCodeFailure: unknown;
		const openCodeProviderResult = yield* Effect.either(
			modelService.listProviders(),
		);
		if (openCodeProviderResult._tag === "Right") {
			const connectedSet = new Set(openCodeProviderResult.right.connected);
			providers.push(
				...openCodeProviderResult.right.providers
					.map((p) => {
						const providerId = p.id || p.name || "";
						const models = (p.models ?? []).map((m) => ({
							id: m.id,
							name: m.name || m.id,
							provider: providerId,
							...(m.limit && { limit: { ...m.limit } }),
							...(m.variants &&
								Object.keys(m.variants).length > 0 && {
									variants: Object.keys(m.variants),
								}),
						}));
						return {
							id: providerId,
							name: p.name || p.id || "",
							configured: connectedSet.has(p.id) || connectedSet.has(p.name),
							models:
								providerId === "amazon-bedrock"
									? groupGeoRoutingModels(models)
									: models,
						};
					})
					.filter((p) => p.configured),
			);
		} else {
			openCodeDiscoveryFailed = true;
			openCodeFailure = openCodeProviderResult.left;
			log.warn(
				`OpenCode provider discovery failed during model refresh: ${formatErrorDetail(openCodeProviderResult.left)}`,
			);
		}

		// Merge Claude in-process models when the orchestration engine is available.
		let claudeDiscoveryFailed = false;
		if (engineOption._tag === "Some") {
			const engineResult = yield* Effect.either(
				engineOption.value.dispatchEffect({
					type: "discover",
					providerId: "claude",
				}),
			);
			if (
				engineResult._tag === "Right" &&
				engineResult.right.models.length > 0
			) {
				for (const p of providers) {
					if (p.id === "anthropic") {
						p.name = "Anthropic - opencode";
					}
				}
				providers.push({
					id: "claude",
					name: "Anthropic - claude",
					configured: true,
					models: engineResult.right.models.map((m) => ({
						id: m.id,
						name: m.name,
						provider: "claude",
						...(m.limit ? { limit: { ...m.limit } } : {}),
						...(m.variants && Object.keys(m.variants).length > 0
							? { variants: Object.keys(m.variants) }
							: {}),
						...(m.contextWindowOptions && m.contextWindowOptions.length > 0
							? {
									contextWindowOptions:
										cloneContextWindowOptions(m.contextWindowOptions) ?? [],
								}
							: {}),
					})),
				});
			}
			if (engineResult._tag === "Left") {
				claudeDiscoveryFailed = true;
			}
		} else {
			claudeDiscoveryFailed = true;
		}
		if (
			openCodeDiscoveryFailed &&
			claudeDiscoveryFailed &&
			providers.length === 0
		) {
			return yield* Effect.fail(openCodeFailure);
		}

		// Provider catalogs arrive in arbitrary order; sort for the picker.
		for (const provider of providers) {
			provider.models.sort((a, b) =>
				a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
			);
		}

		// Send model_info: prefer session's model, fall back to relay-side selection
		let sessionModel: ModelOverride | undefined;
		if (activeId && !activeSessionUsesClaude) {
			const sessionResult = yield* Effect.either(
				modelService.getSession(activeId),
			);
			if (sessionResult._tag === "Right" && sessionResult.right.modelID) {
				sessionModel = {
					modelID: sessionResult.right.modelID,
					providerID: sessionResult.right.providerID ?? "",
				};
			} else if (sessionResult._tag === "Left") {
				log.warn(
					`client=${input.clientId ?? "rpc"} session=${activeId ?? "?"} Failed to get session model info: ${formatErrorDetail(sessionResult.left)}`,
				);
			}
		}
		const activeModel = sessionModel ?? fallbackModel;

		// Send variant_info for the current model so clients get refreshed state
		const currentVariant = activeId
			? yield* getVariant(activeId)
			: yield* getDefaultVariant();
		let variantList: string[] = [];
		if (activeModel) {
			for (const p of providers) {
				const m = p.models.find(
					(mod) =>
						mod.id === activeModel.modelID ||
						mod.routingOptions?.some(
							(option) => option.value === activeModel.modelID,
						),
				);
				if (m?.variants) {
					variantList = [...m.variants];
					break;
				}
			}
		}
		const currentContextWindow = activeId
			? yield* getContextWindow(activeId)
			: yield* getDefaultContextWindow();

		return {
			projectSlug: input.projectSlug ?? "",
			providers,
			...(activeModel
				? {
						active: {
							model: activeModel.modelID,
							provider: activeModel.providerID,
						},
					}
				: {}),
			variant: {
				variant: currentVariant,
				variants: variantList,
			},
			contextWindow: {
				contextWindow: currentContextWindow,
				options: findContextWindowOptions(providers, activeModel?.modelID),
			},
		};
	});

export const sendModelsStateToClient = (
	clientId: string,
	sessionId?: string,
): Effect.Effect<
	void,
	unknown,
	| LoggerTag
	| OpenCodeModelServiceTag
	| OrchestrationEngineTag
	| OverridesStateTag
	| WebSocketHandlerTag
> =>
	Effect.gen(function* () {
		const response = yield* getModelsResponse({
			clientId,
			...(sessionId ? { sessionId } : {}),
		});
		const wsHandler = yield* WebSocketHandlerTag;

		wsHandler.sendTo(clientId, {
			type: "model_list",
			providers: toSharedProviders(response.providers),
		});
		if (response.active) {
			wsHandler.sendTo(clientId, {
				type: "model_info",
				model: response.active.model,
				provider: response.active.provider,
			});
		}
		wsHandler.sendTo(clientId, {
			type: "variant_info",
			...(response.variant?.variant != null
				? { variant: response.variant.variant }
				: {}),
			...(response.variant?.variants
				? { variants: [...response.variant.variants] }
				: {}),
		});
		wsHandler.sendTo(clientId, {
			type: "context_window_info",
			contextWindow: response.contextWindow?.contextWindow ?? "",
			options: cloneContextWindowOptions(response.contextWindow?.options) ?? [],
		});
	});

export interface SwitchModelInput {
	readonly clientId: string;
	readonly sessionId?: string | undefined;
	readonly modelId: string;
	readonly providerId: string;
}

export const switchModelForSession = (input: SwitchModelInput) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		const { modelId, providerId } = input;
		const sessionId = input.sessionId;
		if (sessionId) {
			yield* setModel(sessionId, {
				providerID: providerId,
				modelID: modelId,
			});
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "Some") {
				const providerInstanceId = isClaudeProvider(providerId)
					? "claude"
					: "opencode";
				if (providerInstanceId === "claude") {
					engineOption.value.bindSession(sessionId, providerInstanceId);
				} else if (yield* shouldBindOpenCodeSessionOnModelSwitch(sessionId)) {
					engineOption.value.bindSession(sessionId, providerInstanceId);
				} else {
					engineOption.value.unbindSession(sessionId);
				}
			}
		} else {
			log.warn(
				`client=${input.clientId} model switch with no session; sending client-local state only`,
			);
		}

		const modelMessage = {
			type: "model_info" as const,
			model: modelId,
			provider: providerId,
		};
		if (sessionId) {
			wsHandler.sendToSession(sessionId, modelMessage);
		} else {
			wsHandler.sendTo(input.clientId, modelMessage);
		}

		log.info(
			`client=${input.clientId} session=${sessionId ?? "?"} Switched to: ${modelId} (${providerId})`,
		);

		const availableVariants = yield* loadVariantsForModel({
			providerID: providerId,
			modelID: modelId,
		});
		const modelKey = `${providerId}/${modelId}`;
		const settings = loadRelaySettings(config.configDir);
		const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
		const validVariant =
			persistedVariant && availableVariants.includes(persistedVariant)
				? persistedVariant
				: "";

		if (sessionId) {
			yield* setVariant(sessionId, validVariant);
		}

		const variantMessage = {
			type: "variant_info" as const,
			variant: validVariant,
			variants: availableVariants,
		};
		if (sessionId) {
			wsHandler.sendToSession(sessionId, variantMessage);
		} else {
			wsHandler.sendTo(input.clientId, variantMessage);
		}

		return { model: modelMessage, variant: variantMessage };
	});

export interface SetDefaultModelInput {
	readonly clientId: string;
	readonly provider: string;
	readonly model: string;
}

export const setDefaultModelForRelay = (input: SetDefaultModelInput) =>
	Effect.gen(function* () {
		const modelService = yield* OpenCodeModelServiceTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		const { provider, model } = input;

		const modelSpec = `${provider}/${model}`;
		const override = { providerID: provider, modelID: model };
		yield* setDefaultModel(override);
		yield* saveRelaySettingsEffect(
			{ defaultModel: modelSpec },
			config.configDir,
		);

		// Also persist to OpenCode's project config
		const updateResult = yield* Effect.either(
			modelService.persistDefaultModel(provider, model),
		);
		if (updateResult._tag === "Left") {
			log.warn("Failed to persist default model to OpenCode config");
		}

		const modelMessage = { type: "model_info" as const, model, provider };
		const defaultModelMessage = {
			type: "default_model_info" as const,
			model,
			provider,
		};
		wsHandler.broadcast(modelMessage);
		wsHandler.broadcast(defaultModelMessage);
		log.info(`client=${input.clientId} Set default: ${model} (${provider})`);

		const availableVariants = yield* loadVariantsForModel({
			providerID: provider,
			modelID: model,
		});
		const settings = loadRelaySettings(config.configDir);
		const modelKey = `${provider}/${model}`;
		const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
		const validVariant =
			persistedVariant && availableVariants.includes(persistedVariant)
				? persistedVariant
				: "";
		yield* setDefaultVariant(validVariant);
		const variantMessage = {
			type: "variant_info",
			variant: validVariant,
			variants: availableVariants,
		} as const;
		wsHandler.broadcast(variantMessage);

		return {
			model: modelMessage,
			defaultModel: defaultModelMessage,
			variant: variantMessage,
		};
	});

export interface SwitchVariantInput {
	readonly clientId: string;
	readonly sessionId?: string | undefined;
	readonly variant: string;
}

export const switchVariantForSession = (input: SwitchVariantInput) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		const { variant } = input;
		const sessionId = input.sessionId;
		if (sessionId) {
			yield* setVariant(sessionId, variant);
		} else {
			yield* setDefaultVariant(variant);
		}

		// Resolve active model
		const activeModel = sessionId
			? yield* getModel(sessionId)
			: yield* getDefaultModel();

		// Persist variant preference
		if (activeModel) {
			const modelKey = `${activeModel.providerID}/${activeModel.modelID}`;
			yield* saveRelaySettingsEffect(
				{ defaultVariants: { [modelKey]: variant } },
				config.configDir,
			);
		}

		const availableVariants = yield* loadVariantsForModel(activeModel);
		const message = {
			type: "variant_info" as const,
			variant,
			variants: availableVariants,
		};
		if (sessionId) {
			wsHandler.sendToSession(sessionId, message);
		} else {
			wsHandler.sendTo(input.clientId, message);
		}
		log.info(
			`client=${input.clientId} session=${sessionId ?? "?"} Switched variant to: ${variant || "default"}`,
		);
		return message;
	});
