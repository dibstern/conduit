import { Effect } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import {
	type Harness,
	offeredOptions,
} from "../../../provider/turn-settings.js";
import type {
	ContextWindowOption,
	ModelInfo,
} from "../../../provider/types.js";
import type { ProviderInfo } from "../../../shared-types.js";
import {
	ProjectSettingsTag,
	publishProjectSetting,
	refreshHarnessDefaults,
} from "./project-settings.js";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
} from "./services.js";

export const cloneContextWindowOptions = (
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

export const publishClaudeModels = (models: readonly ModelInfo[]) =>
	Effect.gen(function* () {
		const projectSettings = yield* Effect.serviceOption(ProjectSettingsTag);
		if (projectSettings._tag === "None") return;
		const provider = claudeProviderFromCatalog(models);
		yield* publishProjectSetting({
			_tag: "providerModels",
			providers: models.length > 0 ? [provider] : [],
		}).pipe(Effect.provideService(ProjectSettingsTag, projectSettings.value));
		yield* refreshHarnessDefaults;
	});

/** Catalog discovery for interactive picks; turn dispatch uses cached catalogs. */
export const loadModelCatalog = (
	harness: Harness,
	instanceId: string = harness,
	options?: { readonly startIfStopped?: boolean },
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		if (harness === "claude") {
			const engine = yield* OrchestrationEngineTag;

			const capsResult = yield* Effect.either(
				engine.dispatchEffect({
					type: "discover",
					providerId: instanceId,
				}),
			);
			if (capsResult._tag === "Left") {
				log.warn(
					`Failed to fetch Claude model catalog: ${formatErrorDetail(capsResult.left)}`,
				);
				return [] as ModelInfo[];
			}
			const models = capsResult.right.models;
			yield* publishClaudeModels(models);
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
