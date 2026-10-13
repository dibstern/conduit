import {
	type Cause,
	Data,
	Effect,
	Either,
	FiberMap,
	Option,
	Ref,
} from "effect";
import type { AccountId } from "../contracts/account.js";
import type { AccountUnroutable } from "../contracts/limit-recovery.js";
import type { KnownProviderDriverKind } from "../contracts/provider-instance.js";
import type { GetModelsResponse } from "../contracts/ws-rpc.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import {
	ProjectSettingsTag,
	publishGlobalProjectSetting,
	publishProjectSetting,
	refreshHarnessDefaults,
} from "../domain/relay/Services/project-settings.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import {
	selectSessionContextWindow,
	selectSessionModel,
	selectSessionVariant,
} from "../domain/relay/Services/session-model-settings.js";
import {
	getContextWindow,
	getDefaultContextWindow,
	getDefaultModel,
	getDefaultPermissionMode,
	getDefaultVariant,
	getModel,
	getPermissionMode,
	getVariant,
	type ModelOverride,
	OverridesStateTag,
} from "../domain/relay/Services/session-overrides-state.js";
import { formatErrorDetail } from "../errors.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { isSameModelIdentity } from "../provider/claude/claude-api-model-id.js";
import { ProviderRegistryTag } from "../provider/provider-registry.js";
import {
	catalogFromProviderList,
	findCatalogModel,
	type Harness,
	harnessForModelProvider,
	offeredOptions,
	resolveTurnSettings,
} from "../provider/turn-settings.js";
import type { ContextWindowOption, ModelInfo } from "../provider/types.js";
import {
	loadRelaySettings,
	parseDefaultModel,
	saveRelaySettings,
} from "../relay/relay-settings.js";
import type { ProviderInfo } from "../shared-types.js";

export class RelaySettingsSaveError extends Data.TaggedError(
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

/** Helper: resolve session from WebSocketHandler context. */
const resolveSessionFromContext = (clientId: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		return wsHandler.getClientSession(clientId);
	});

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

const claudeProviderFromCatalog = (
	models: readonly ModelInfo[],
): ProviderInfo => ({
	id: "claude",
	name: "Anthropic - claude",
	configured: true,
	models: models
		.map((model) => {
			const { efforts } = offeredOptions(model);
			return {
				id: model.id,
				name: model.name,
				provider: "claude",
				...(efforts.length > 0 ? { variants: [...efforts] } : {}),
				...(model.limit ? { limit: { ...model.limit } } : {}),
				...(model.contextWindowOptions?.length
					? {
							contextWindowOptions:
								cloneContextWindowOptions(model.contextWindowOptions) ?? [],
						}
					: {}),
				...(model.routingOptions?.length
					? {
							routingOptions:
								cloneContextWindowOptions(model.routingOptions) ?? [],
						}
					: {}),
			};
		})
		.sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		),
});

const publishClaudeModels = (
	models: readonly ModelInfo[],
	accountId: AccountId,
) =>
	Effect.gen(function* () {
		const projectSettings = yield* Effect.serviceOption(ProjectSettingsTag);
		if (projectSettings._tag === "None") return;
		const provider = claudeProviderFromCatalog(models);
		yield* publishProjectSetting({
			_tag: "providerModels",
			accountId,
			providers: models.length > 0 ? [provider] : [],
		}).pipe(Effect.provideService(ProjectSettingsTag, projectSettings.value));
		yield* refreshHarnessDefaults;
	});

/** Catalog discovery for interactive picks; turn dispatch uses cached catalogs. */
export const loadModelCatalog = (
	harness: Harness,
	instanceId?: string,
	options?: { readonly startIfStopped?: boolean },
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		if (harness === "claude") {
			const engine = yield* OrchestrationEngineTag;
			const directory = yield* AccountDirectory;
			const account = yield* directory.resolve(
				instanceId === undefined
					? { _tag: "DriverDefault", driver: harness }
					: { _tag: "Id", id: instanceId },
			);

			const capsResult = yield* Effect.either(
				engine.dispatchEffect({
					type: "discover",
					providerId: account.id,
					account,
				}),
			);
			if (capsResult._tag === "Left") {
				log.warn(
					`Failed to fetch Claude model catalog: ${formatErrorDetail(capsResult.left)}`,
				);
				return [] as ModelInfo[];
			}
			const models = capsResult.right.models;
			yield* publishClaudeModels(models, account.id);
			return models;
		}

		const modelService = yield* Effect.serviceOption(OpenCodeModelServiceTag);
		if (modelService._tag === "None") return [] as ModelInfo[];
		const provListResult = yield* Effect.either(
			modelService.value.listProviders(options),
		);
		if (provListResult._tag === "Left") {
			log.warn(
				`Failed to fetch OpenCode model catalog: ${formatErrorDetail(provListResult.left)}`,
			);
			return [] as ModelInfo[];
		}
		yield* refreshHarnessDefaults;
		return provListResult.right.providers.flatMap((provider) =>
			(provider.models ?? []).map((model) => ({
				...model,
				name: model.name || model.id,
				providerId: provider.id || provider.name || "",
			})),
		);
	});

const loadVariantsForModel = (
	activeModel: ModelOverride | undefined,
	catalog?: readonly ModelInfo[],
) =>
	Effect.gen(function* () {
		if (!activeModel) return [];
		const harness = harnessForModelProvider(activeModel.providerID);
		const model = findCatalogModel(
			harness,
			{ providerId: activeModel.providerID, modelId: activeModel.modelID },
			catalog ?? (yield* loadModelCatalog(harness)),
		);
		return model ? [...offeredOptions(model).efforts] : [];
	});

/** The efforts `model` offers, and the one last saved for it if still offered. */
export const savedVariantFor = (
	model: ModelOverride,
	catalog?: readonly ModelInfo[],
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const variants = yield* loadVariantsForModel(model, catalog);
		const saved =
			loadRelaySettings(config.configDir).defaultVariants?.[
				`${model.providerID}/${model.modelID}`
			] ?? "";
		return { variant: variants.includes(saved) ? saved : "", variants };
	});

const shouldBindOpenCodeSessionOnModelSwitch = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;

		const rowResult = yield* Effect.either(readQuery.getSession(sessionId));
		if (rowResult._tag === "Left") return true;

		const row = rowResult.right;
		return !row || row.provider === "opencode";
	});

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

export const getModelsResponse = (
	input: {
		readonly projectSlug?: string;
		readonly clientId?: string;
		readonly sessionId?: string;
		readonly instanceId?: string;
	} = {},
): Effect.Effect<
	GetModelsResponse,
	Cause.UnknownException | AccountUnroutable,
	| LoggerTag
	| ConfigTag
	| OpenCodeModelServiceTag
	| OrchestrationEngineTag
	| ReadQueryEffectTag
	| OverridesStateTag
	| WebSocketHandlerTag
	| ProjectSettingsTag
	| AccountDirectory
> =>
	Effect.gen(function* () {
		const modelService = yield* OpenCodeModelServiceTag;
		const log = yield* LoggerTag;
		const engine = yield* OrchestrationEngineTag;
		const directory = yield* AccountDirectory;
		const activeId =
			input.sessionId ??
			(input.clientId
				? yield* resolveSessionFromContext(input.clientId)
				: undefined);
		const activeProviderId = activeId
			? yield* engine.getProviderForSessionEffect(activeId)
			: undefined;
		const listedId = input.instanceId ?? activeProviderId;
		const account =
			listedId === undefined
				? undefined
				: yield* directory.resolve({ _tag: "Id", id: listedId });
		const instanceId = input.instanceId === undefined ? undefined : account?.id;
		const instanceDriver =
			input.instanceId === undefined ? undefined : account?.driver;
		const activeDriver =
			activeProviderId === undefined
				? undefined
				: input.instanceId === undefined ||
						input.instanceId === activeProviderId
					? account?.driver
					: (yield* directory.resolve({ _tag: "Id", id: activeProviderId }))
							.driver;
		const claudeAccount =
			instanceDriver === "opencode"
				? undefined
				: account?.driver === "claude"
					? account
					: Option.getOrUndefined(yield* directory.defaultFor("claude"));
		const { modelDiscovery } = yield* ProjectSettingsTag;
		if (claudeAccount !== undefined)
			yield* engine
				.dispatchEffect({
					type: "discover",
					providerId: "claude",
					account: claudeAccount,
				})
				.pipe(
					Effect.flatMap((capabilities) =>
						publishClaudeModels(capabilities.models, claudeAccount.id),
					),
					Effect.catchAll((error) =>
						Effect.sync(() =>
							log.warn(
								`Claude provider discovery failed during model refresh: ${formatErrorDetail(error)}`,
							),
						),
					),
					Effect.asVoid,
					(effect) =>
						FiberMap.run(modelDiscovery, claudeAccount.id, effect, {
							onlyIfMissing: true,
						}),
				);

		const providers: ProviderInfo[] = [];
		if (instanceDriver === undefined || instanceDriver === "opencode") {
			const openCodeProviderResult = yield* Effect.either(
				modelService.listProviders(),
			);
			if (openCodeProviderResult._tag === "Right") {
				yield* refreshHarnessDefaults;
				const nativeDefaultModel = parseDefaultModel(
					openCodeProviderResult.right.nativeDefaultModel,
				);
				const { globalSync } = yield* ProjectSettingsTag;
				yield* globalSync.withPermits(1)(
					Effect.gen(function* () {
						const state = yield* Ref.get(yield* OverridesStateTag);
						if (
							state.nativeDefaultModel?.providerID ===
								nativeDefaultModel?.providerID &&
							state.nativeDefaultModel?.modelID === nativeDefaultModel?.modelID
						)
							return;
						yield* Ref.update(yield* OverridesStateTag, (current) => ({
							...current,
							nativeDefaultModel,
						}));
						if (state.defaultModel === undefined)
							yield* publishProjectSetting({
								_tag: "defaultModel",
								...(nativeDefaultModel
									? {
											model: nativeDefaultModel.modelID,
											provider: nativeDefaultModel.providerID,
										}
									: {}),
								variant: state.defaultVariant,
							});
					}),
				);
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
								...(offeredOptions({ ...m, providerId }).efforts.length > 0 && {
									variants: [...offeredOptions({ ...m, providerId }).efforts],
								}),
							}));
							return {
								id: providerId,
								...(instanceId === undefined ? {} : { instanceId }),
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
				log.warn(
					`OpenCode provider discovery failed during model refresh: ${formatErrorDetail(openCodeProviderResult.left)}`,
				);
			}
		}

		// Provider catalogs arrive in arbitrary order; sort for the picker.
		for (const provider of providers) {
			provider.models.sort((a, b) =>
				a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
			);
		}

		// OpenCode owns its native turn default; only its catalog inherits it.
		const fallbackModel = activeId
			? ((yield* getModel(activeId)) ??
				(activeDriver === "opencode" ? yield* getDefaultModel() : undefined))
			: yield* getDefaultModel();
		const modelDriver = harnessForModelProvider(
			fallbackModel?.providerID ?? "",
		);
		const selectedDriver: KnownProviderDriverKind = activeDriver ?? modelDriver;
		// A model runs only on its own harness. A session or instance on the
		// other harness runs that harness's own default, so it has no model here.
		const selectedModelMatchesInstance = [instanceDriver, activeDriver].every(
			(driver) => driver === undefined || driver === modelDriver,
		);
		const selectedModel = selectedModelMatchesInstance
			? fallbackModel
			: undefined;
		const catalogues = yield* Ref.get((yield* ProjectSettingsTag).live);
		const claudeCatalog = claudeAccount
			? (catalogues[`providerModels:${claudeAccount.id}`] ??
				catalogues.providerModels)
			: catalogues.providerModels;
		const catalog = catalogFromProviderList(
			selectedDriver === "claude"
				? (claudeCatalog?.providers ?? [])
				: providers,
		);
		const catalogModel = selectedModel
			? findCatalogModel(
					harnessForModelProvider(selectedDriver),
					{
						providerId: selectedModel.providerID,
						modelId: selectedModel.modelID,
					},
					catalog,
				)
			: undefined;
		const options = catalogModel
			? offeredOptions(catalogModel)
			: { efforts: [], contextWindows: [] };
		const currentContextWindow = activeId
			? yield* getContextWindow(activeId)
			: yield* getDefaultContextWindow();
		const normalized = selectedModel
			? resolveTurnSettings(
					{
						harness: harnessForModelProvider(selectedDriver),
						model: {
							providerId: selectedModel.providerID,
							modelId: selectedModel.modelID,
						},
						effort: "",
						contextWindow: currentContextWindow,
					},
					catalog,
				)
			: undefined;
		const activeModel =
			normalized && Either.isRight(normalized)
				? {
						providerID: normalized.right.model.providerId,
						modelID: normalized.right.model.modelId,
					}
				: selectedModel;

		// Send variant_info for the current model so clients get refreshed state
		const currentVariant = activeId
			? yield* getVariant(activeId)
			: yield* getDefaultVariant();
		const variantList = [...options.efforts];
		let modelExecution: GetModelsResponse["modelExecution"];
		if (activeId) {
			const readQuery = yield* ReadQueryEffectTag;
			const executionResult = yield* Effect.either(
				readQuery.getLatestTurnModelExecution(activeId),
			);
			if (executionResult._tag === "Left") {
				log.warn(
					`Failed to read latest model execution for session ${activeId}: ${formatErrorDetail(executionResult.left)}`,
				);
			} else if (executionResult.right) {
				const row = executionResult.right;
				modelExecution = {
					...(row.requested_model === null
						? {}
						: { requestedModel: row.requested_model }),
					...(row.expected_model === null
						? {}
						: {
								expectedModel: row.expected_model,
								drifted: !isSameModelIdentity(
									row.actual_model,
									row.expected_model,
								),
							}),
					actualModel: row.actual_model,
				};
			}
		}

		return {
			projectSlug: input.projectSlug ?? "",
			...(instanceId === undefined ? {} : { instanceId }),
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
				// An effort belongs to its model, so no model means no effort.
				variant: selectedModel ? currentVariant : "",
				variants: variantList,
			},
			contextWindow: {
				contextWindow:
					normalized && Either.isRight(normalized)
						? normalized.right.contextWindow
						: currentContextWindow,
				options: cloneContextWindowOptions(options.contextWindows) ?? [],
			},
			// No session yet: the mode a new session would start in.
			permissionMode: activeId
				? yield* getPermissionMode(activeId)
				: yield* getDefaultPermissionMode(),
			...(modelExecution === undefined ? {} : { modelExecution }),
		};
	});

export interface SwitchModelInput {
	readonly clientId: string;
	readonly sessionId?: string | undefined;
	readonly modelId: string;
	readonly providerId: string;
}

/**
 * Push the session's current model / context window / effort onto the live
 * provider query so a picker change applies now instead of at the next turn.
 *
 * Reads all three from the overrides map rather than taking the one that
 * changed: the provider compares against what the query already has, so a
 * partial set would read as "cleared" and reset the other two to their
 * defaults. Best-effort -- on failure the provider stays latched out-of-sync
 * and the next turn re-applies, which is the pre-existing behaviour.
 */
export const applyLiveSessionSettings = (sessionId: string) =>
	Effect.gen(function* () {
		const registry = yield* ProviderRegistryTag;
		const instance = registry.getInstance("claude");
		if (!instance?.applyLiveSettingsEffect) return;

		const model = yield* getModel(sessionId);
		const variant = yield* getVariant(sessionId);
		const contextWindow = yield* getContextWindow(sessionId);
		if (model && harnessForModelProvider(model.providerID) !== "claude") return;

		const result = yield* Effect.either(
			instance.applyLiveSettingsEffect(sessionId, {
				modelId: model?.modelID,
				contextWindow,
				variant,
			}),
		);
		if (result._tag === "Left") {
			const log = yield* LoggerTag;
			log.warn(
				`session=${sessionId} Live settings apply failed; next turn will re-sync`,
				result.left,
			);
		}
	});

export const switchModelForSession = (input: SwitchModelInput) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;

		const { modelId, providerId } = input;
		const sessionId = input.sessionId;
		const harness = harnessForModelProvider(providerId);
		const catalog = yield* loadModelCatalog(harness);
		const resolved = resolveTurnSettings(
			{
				harness,
				model: { providerId, modelId },
				effort: "",
				contextWindow: "",
			},
			catalog,
		);
		if (Either.isLeft(resolved)) return yield* resolved.left;
		const model = {
			providerID: resolved.right.model.providerId,
			modelID: resolved.right.model.modelId,
		};
		const { variant: validVariant, variants: availableVariants } =
			yield* savedVariantFor(model, catalog);
		if (sessionId) {
			const currentContext = yield* getContextWindow(sessionId);
			const catalogModel = findCatalogModel(
				harness,
				resolved.right.model,
				catalog,
			);
			const contextWindow =
				catalogModel &&
				offeredOptions(catalogModel).contextWindows.some(
					(option) => option.value === currentContext,
				)
					? currentContext
					: resolved.right.contextWindow;
			yield* selectSessionModel(sessionId, model);
			if (contextWindow !== currentContext) {
				yield* selectSessionContextWindow(sessionId, contextWindow);
			}
			yield* selectSessionVariant(sessionId, validVariant);
			const engine = yield* OrchestrationEngineTag;
			const providerInstanceId = harness;
			if (providerInstanceId === "claude") {
				engine.bindSession(sessionId, providerInstanceId);
			} else if (yield* shouldBindOpenCodeSessionOnModelSwitch(sessionId)) {
				engine.bindSession(sessionId, providerInstanceId);
			} else {
				engine.unbindSession(sessionId);
			}
			yield* applyLiveSessionSettings(sessionId);
		}

		log.info(
			`client=${input.clientId} session=${sessionId ?? "?"} Switched to: ${modelId} (${providerId})`,
		);

		return {
			model: model.modelID,
			provider: model.providerID,
			variant: validVariant,
			variants: availableVariants,
		};
	});

export interface SetDefaultModelInput {
	readonly clientId: string;
	readonly provider: string;
	readonly model: string;
}

export const setDefaultModelForRelay = (input: SetDefaultModelInput) =>
	Effect.gen(function* () {
		const modelService = yield* OpenCodeModelServiceTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		const { provider, model } = input;
		const harness = harnessForModelProvider(provider);
		const catalog = yield* loadModelCatalog(harness, undefined, {
			startIfStopped: true,
		});
		const resolved = resolveTurnSettings(
			{
				harness,
				model: { providerId: provider, modelId: model },
				effort: "",
				contextWindow: "",
			},
			catalog,
		);
		if (Either.isLeft(resolved)) return yield* resolved.left;

		const modelSpec = `${provider}/${model}`;
		const override = { providerID: provider, modelID: model };
		yield* saveRelaySettingsEffect(
			{
				defaultModel: modelSpec,
				harnessDefaults: {
					[harness]: { ...resolved.right.model, contextWindow: "" },
				},
			},
			config.configDir,
		);
		yield* publishGlobalProjectSetting("defaultModel");

		// Mirror the default into OpenCode's project config, except Claude-harness
		// ids: OpenCode can't resolve them, so every prompt sent without a model
		// would fail with "Model not found".
		if (harnessForModelProvider(provider) === "opencode") {
			const updateResult = yield* Effect.either(
				modelService.persistDefaultModel(provider, model),
			);
			if (updateResult._tag === "Left") {
				log.warn("Failed to persist default model to OpenCode config");
			}
		}

		const { variant: validVariant, variants: availableVariants } =
			yield* savedVariantFor(override, catalog);
		log.info(`client=${input.clientId} Set default: ${model} (${provider})`);

		return {
			model,
			provider,
			variant: validVariant,
			variants: availableVariants,
		};
	});

export const setHarnessDefaultForRelay = (input: {
	readonly harness: Harness;
	readonly providerId: string;
	readonly modelId: string;
	readonly effort?: string | undefined;
	readonly contextWindow: string;
}) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const catalog = yield* loadModelCatalog(input.harness, undefined, {
			startIfStopped: true,
		});
		const requestedEffort =
			input.effort ??
			(yield* savedVariantFor(
				{ providerID: input.providerId, modelID: input.modelId },
				catalog,
			)).variant;
		const resolved = resolveTurnSettings(
			{
				harness: input.harness,
				model: { providerId: input.providerId, modelId: input.modelId },
				effort: requestedEffort,
				contextWindow: input.contextWindow,
			},
			catalog,
		);
		if (Either.isLeft(resolved)) return yield* resolved.left;
		const { model, effort, contextWindow } = resolved.right;
		yield* saveRelaySettingsEffect(
			{
				harnessDefaults: { [input.harness]: { ...model, contextWindow } },
				defaultVariants: { [`${model.providerId}/${model.modelId}`]: effort },
			},
			config.configDir,
		);
		yield* publishGlobalProjectSetting("harnessDefaults");
		return { pick: { ...model, effort, contextWindow }, status: "ok" } as const;
	});

export interface SwitchVariantInput {
	readonly clientId: string;
	readonly sessionId?: string | undefined;
	readonly variant: string;
}

export const switchVariantForSession = (
	input: SwitchVariantInput,
	modelCatalog?: readonly ModelInfo[],
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		const { variant } = input;
		const sessionId = input.sessionId;
		// Resolve active model
		const activeModel = sessionId
			? ((yield* getModel(sessionId)) ?? (yield* getDefaultModel()))
			: parseDefaultModel(loadRelaySettings(config.configDir).defaultModel);
		const harness = harnessForModelProvider(activeModel?.providerID ?? "");
		const catalog = modelCatalog ?? (yield* loadModelCatalog(harness));
		const resolved = resolveTurnSettings(
			{
				harness,
				model: {
					providerId: activeModel?.providerID ?? "",
					modelId: activeModel?.modelID ?? "",
				},
				effort: variant,
				contextWindow: "",
			},
			catalog,
		);
		if (Either.isLeft(resolved)) return yield* resolved.left;
		if (sessionId) {
			yield* selectSessionVariant(sessionId, resolved.right.effort);
			yield* applyLiveSessionSettings(sessionId);
		}

		// Persist variant preference
		if (activeModel) {
			const modelKey = `${activeModel.providerID}/${activeModel.modelID}`;
			yield* saveRelaySettingsEffect(
				{ defaultVariants: { [modelKey]: variant } },
				config.configDir,
			);
		}

		// A session's saved preference also changes the global default variant
		// when it uses the current default model.
		if (
			!sessionId ||
			(activeModel &&
				loadRelaySettings(config.configDir).defaultModel ===
					`${activeModel.providerID}/${activeModel.modelID}`)
		) {
			yield* publishGlobalProjectSetting("defaultModel");
		}
		const availableVariants = yield* loadVariantsForModel(activeModel, catalog);
		log.info(
			`client=${input.clientId} session=${sessionId ?? "?"} Switched variant to: ${variant || "default"}`,
		);
		return { variant, variants: availableVariants };
	});
