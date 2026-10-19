import { Effect } from "effect";
import type { Account } from "../../../contracts/account.js";
import { PROVIDER_DRIVERS } from "../../../contracts/provider-instance.js";
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
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
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

const DISCOVERY_PROVIDER_NAMES: Partial<Record<Harness, string>> = {
	claude: "Anthropic - claude",
	cursor: "Cursor",
};

const providerFromCatalog = (
	models: readonly ModelInfo[],
	driver: Harness,
): ProviderInfo => ({
	id: driver,
	name: DISCOVERY_PROVIDER_NAMES[driver] ?? driver,
	configured: true,
	models: models
		.map((model) => {
			const { efforts } = offeredOptions(model);
			return {
				id: model.id,
				name: model.name,
				provider: driver,
				...(efforts.length > 0 ? { variants: [...efforts] } : {}),
				...(model.parameters ? { parameters: model.parameters } : {}),
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

export const publishDiscoveredModels = (
	models: readonly ModelInfo[],
	account: Pick<Account, "id" | "driver">,
) =>
	Effect.gen(function* () {
		const projectSettings = yield* Effect.serviceOption(ProjectSettingsTag);
		if (projectSettings._tag === "None") return;
		const provider = providerFromCatalog(models, account.driver);
		yield* publishProjectSetting({
			_tag: "providerModels",
			accountId: account.id,
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
		const account = yield* (yield* AccountDirectory).resolve(
			instanceId === undefined
				? { _tag: "DriverDefault", driver: harness }
				: { _tag: "Id", id: instanceId },
		);
		if (account.driver !== harness) return [] as ModelInfo[];
		if (PROVIDER_DRIVERS[harness].catalogSource === "discovery") {
			const engine = yield* OrchestrationEngineTag;

			const capsResult = yield* Effect.result(
				engine.dispatchEffect({
					type: "discover",
					providerId: account.id,
					account,
				}),
			);
			if (capsResult._tag === "Failure") {
				yield* publishDiscoveredModels([], account);
				log.warn(
					`Failed to fetch ${account.driver} model catalog: ${formatErrorDetail(capsResult.failure)}`,
				);
				return [] as ModelInfo[];
			}
			const models = capsResult.success.models;
			yield* publishDiscoveredModels(models, account);
			return models;
		}

		const modelService = yield* Effect.serviceOption(OpenCodeModelServiceTag);
		if (modelService._tag === "None") return [] as ModelInfo[];
		const provListResult = yield* Effect.result(
			modelService.value.listProviders({ ...options, instanceId: account.id }),
		);
		if (provListResult._tag === "Failure") {
			log.warn(
				`Failed to fetch OpenCode model catalog: ${formatErrorDetail(provListResult.failure)}`,
			);
			return [] as ModelInfo[];
		}
		yield* refreshHarnessDefaults;
		return provListResult.success.providers.flatMap((provider) =>
			(provider.models ?? []).map((model) => ({
				...model,
				name: model.name || model.id,
				providerId: provider.id || provider.name || "",
			})),
		);
	});
