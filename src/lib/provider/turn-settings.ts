import { Brand, Data, Result } from "effect";
import {
	isKnownDriverKind,
	type KnownProviderDriverKind,
	PROVIDER_DRIVERS,
} from "../contracts/provider-instance.js";
import type { ModelInfo as WireModelInfo } from "../contracts/ws-rpc.js";
import type { RelaySettings } from "../relay/relay-settings.js";
import {
	claudeApiModelId,
	isSameModelIdentity,
} from "./claude/claude-api-model-id.js";
import type {
	ContextWindowOption,
	ModelInfo,
	ModelSelection,
} from "./types.js";

export type Harness = KnownProviderDriverKind;

export type ModelParameters = NonNullable<WireModelInfo["parameters"]>;
export type ParameterChoiceKey = string & Brand.Brand<"ParameterChoiceKey">;
export type ParamValue = { readonly id: string; readonly value: string };
export type ResolvedChoice =
	| { readonly _tag: "Default"; readonly values: readonly ParamValue[] }
	| {
			readonly _tag: "Chosen";
			readonly key: ParameterChoiceKey;
			readonly values: readonly ParamValue[];
	  };

const parameterChoiceKey = Brand.nominal<ParameterChoiceKey>();

export class ModelParametersUnavailable extends Data.TaggedError(
	"ModelParametersUnavailable",
)<{
	readonly modelId: string;
	readonly choice: string;
	readonly reason: "not-offered";
	readonly offered: readonly string[];
}> {
	override get message(): string {
		return `${this._tag}: parameter choice ${JSON.stringify(this.choice)} is not offered by model ${this.modelId}`;
	}
}

/** One interpretation of stored choices for both wire and provider catalogs. */
export function modelParameterChoices(model: {
	readonly id: string;
	readonly parameters?: WireModelInfo["parameters"];
	readonly variants?: WireModelInfo["variants"] | ModelInfo["variants"];
}): {
	offered(): readonly ParameterChoiceKey[];
	resolve(
		choice: string,
	): Result.Result<ResolvedChoice, ModelParametersUnavailable>;
	cheapest(): ResolvedChoice;
	withValue(
		choice: string,
		rowId: string,
		value: string,
	): ParameterChoiceKey | undefined;
} {
	const parameters = model.parameters;
	const offered = (
		parameters
			? parameters.combinations.map(({ variant }) => variant)
			: Array.isArray(model.variants)
				? model.variants
				: Object.keys(model.variants ?? {})
	).map(parameterChoiceKey);
	const valuesFor = (
		values: Readonly<Record<string, string>> | undefined,
	): readonly ParamValue[] =>
		Object.entries(values ?? {}).map(([id, value]) => ({ id, value }));
	const defaultChoice: ResolvedChoice = {
		_tag: "Default",
		values: valuesFor(
			parameters?.combinations.find((entry) => entry.isDefault)?.values,
		),
	};
	const resolve = (
		choice: string,
	): Result.Result<ResolvedChoice, ModelParametersUnavailable> => {
		if (choice === "") return Result.succeed(defaultChoice);
		const key = offered.find((key) => key === choice);
		if (key === undefined)
			return Result.fail(
				new ModelParametersUnavailable({
					modelId: model.id,
					choice,
					reason: "not-offered",
					offered,
				}),
			);
		return Result.succeed({
			_tag: "Chosen",
			key,
			values: valuesFor(
				parameters?.combinations.find((entry) => entry.variant === key)?.values,
			),
		});
	};
	return {
		offered: () => offered,
		resolve,
		cheapest() {
			// Cursor and Codex captures pin each row's values as cheapest-first.
			const cheapest = parameters?.combinations.find(({ values }) =>
				parameters.rows.every((row) => values[row.id] === row.values[0]?.value),
			);
			return cheapest
				? {
						_tag: "Chosen",
						key: parameterChoiceKey(cheapest.variant),
						values: valuesFor(cheapest.values),
					}
				: defaultChoice;
		},
		withValue(choice, rowId, value) {
			const resolved = resolve(choice);
			if (Result.isFailure(resolved)) return undefined;
			const values = {
				...Object.fromEntries(
					resolved.success.values.map(({ id, value }) => [id, value]),
				),
				[rowId]: value,
			};
			const matches = parameters?.combinations.filter((entry) =>
				Object.entries(values).every(
					([id, value]) => entry.values[id] === value,
				),
			);
			const combination =
				matches?.find(
					(entry) =>
						Object.keys(entry.values).length === Object.keys(values).length,
				) ?? matches?.[0];
			return combination ? parameterChoiceKey(combination.variant) : undefined;
		},
	};
}

/** Model namespaces identify a harness, independently of account bindings. */
export function harnessForModelProvider(providerId: string): Harness {
	return isKnownDriverKind(providerId) &&
		PROVIDER_DRIVERS[providerId].catalogSource === "discovery"
		? providerId
		: "opencode";
}

export interface TurnPick {
	harness: Harness;
	model: ModelSelection;
	effort: string;
	contextWindow: string;
}

/** Catalog identity and offered choices; empty choices use model defaults. */
export interface TurnSettings extends TurnPick {}

export class PickRequired extends Data.TaggedError("PickRequired") {
	override get message(): string {
		return "PickRequired: a session model pick is required";
	}
}

/** Creation and legacy backfill defaults. Stored session picks stay unchanged. */
export function harnessDefaultPick(
	harness: Harness,
	settings: RelaySettings,
	nativeDefaultModel?: string,
): TurnPick | undefined {
	const stored = settings.harnessDefaults?.[harness];
	let model = stored && {
		providerId: stored.providerId,
		modelId: stored.modelId,
	};
	const parse = (value: string | undefined): ModelSelection | undefined => {
		const separator = value?.indexOf("/") ?? -1;
		return value && separator > 0
			? {
					providerId: value.slice(0, separator),
					modelId: value.slice(separator + 1),
				}
			: undefined;
	};
	if (!model) {
		const legacy = parse(settings.defaultModel);
		if (legacy && harnessForModelProvider(legacy.providerId) === harness)
			model = legacy;
		else if (PROVIDER_DRIVERS[harness].runsOpenCodeServer)
			model = parse(nativeDefaultModel);
	}
	if (!model) return undefined;
	return {
		harness,
		model,
		effort:
			settings.defaultVariants?.[`${model.providerId}/${model.modelId}`] ?? "",
		contextWindow: stored?.contextWindow ?? "",
	};
}

export class ModelNotInCatalog extends Data.TaggedError("ModelNotInCatalog")<{
	readonly harness: Harness;
	readonly providerId: string;
	readonly modelId: string;
}> {
	override get message(): string {
		return `${this._tag}: model ${this.providerId}/${this.modelId} is not in the ${this.harness} catalog`;
	}
}

export class ContextWindowNotOffered extends Data.TaggedError(
	"ContextWindowNotOffered",
)<{
	readonly modelId: string;
	readonly contextWindow: string;
	readonly offered: readonly string[];
}> {
	override get message(): string {
		return `${this._tag}: contextWindow ${JSON.stringify(this.contextWindow)} is not offered by model ${this.modelId}`;
	}
}

export type PickRejection =
	| PickRequired
	| ModelNotInCatalog
	| ModelParametersUnavailable
	| ContextWindowNotOffered;

export function isPickRejection(error: unknown): error is PickRejection {
	return (
		error instanceof PickRequired ||
		error instanceof ModelNotInCatalog ||
		error instanceof ModelParametersUnavailable ||
		error instanceof ContextWindowNotOffered
	);
}

export function offeredOptions(model: ModelInfo): {
	efforts: readonly string[];
	contextWindows: readonly ContextWindowOption[];
} {
	return {
		efforts: modelParameterChoices(model).offered(),
		contextWindows: model.contextWindowOptions ?? [],
	};
}

export function findCatalogModel(
	harness: Harness,
	model: ModelSelection,
	catalog: readonly ModelInfo[],
): ModelInfo | undefined {
	if (harnessForModelProvider(model.providerId) !== harness) return undefined;
	const candidates = catalog.filter(
		(entry) =>
			entry.providerId === model.providerId &&
			harnessForModelProvider(entry.providerId) === harness,
	);
	return (
		candidates.find(
			(entry) =>
				entry.id === model.modelId ||
				entry.routingOptions?.some((option) => option.value === model.modelId),
		) ??
		(PROVIDER_DRIVERS[harness].modelIdFormat === "context-window-suffix"
			? candidates.find((entry) => isSameModelIdentity(entry.id, model.modelId))
			: undefined)
	);
}

/** An unavailable catalog preserves a complete pick; a known catalog validates it. */
export function resolveTurnSettings(
	pick: TurnPick,
	catalog: readonly ModelInfo[] | undefined,
): Result.Result<TurnSettings, PickRejection> {
	if (harnessForModelProvider(pick.model.providerId) !== pick.harness) {
		return Result.fail(
			new ModelNotInCatalog({ harness: pick.harness, ...pick.model }),
		);
	}
	if (catalog === undefined) return Result.succeed(pick);
	const model = findCatalogModel(pick.harness, pick.model, catalog);
	if (!model) {
		return Result.fail(
			new ModelNotInCatalog({ harness: pick.harness, ...pick.model }),
		);
	}
	const isRoutingOption = model.routingOptions?.some(
		(option) => option.value === pick.model.modelId,
	);
	// A "[1m]" id matched to its base model asks for the 1m window, which the
	// base must then offer; an explicit window still wins.
	const askedFor1m =
		PROVIDER_DRIVERS[pick.harness].modelIdFormat === "context-window-suffix" &&
		!isRoutingOption &&
		model.id !== pick.model.modelId &&
		model.id === claudeApiModelId(pick.model.modelId, "200k");
	const contextWindow = pick.contextWindow || (askedFor1m ? "1m" : "");
	const modelId = isRoutingOption ? pick.model.modelId : model.id;
	const { contextWindows } = offeredOptions(model);
	const choice = modelParameterChoices(model).resolve(pick.effort);
	if (Result.isFailure(choice)) return Result.fail(choice.failure);
	const offeredWindows = contextWindows.map((option) => option.value);
	if (contextWindow !== "" && !offeredWindows.includes(contextWindow)) {
		return Result.fail(
			new ContextWindowNotOffered({
				modelId,
				contextWindow,
				offered: offeredWindows,
			}),
		);
	}
	return Result.succeed({
		harness: pick.harness,
		model: { providerId: model.providerId, modelId },
		effort: pick.effort,
		contextWindow,
	});
}

interface ListedOption {
	readonly value: string;
	readonly label: string;
	readonly isDefault?: boolean | undefined;
}

const copyOptions = (options: readonly ListedOption[]): ContextWindowOption[] =>
	options.map(({ value, label, isDefault }) =>
		isDefault === undefined ? { value, label } : { value, label, isDefault },
	);

/** Rebuilds a resolver catalog from the browser-facing provider list. */
export const catalogFromProviderList = (
	providers: readonly {
		readonly id: string;
		readonly models: readonly {
			readonly id: string;
			readonly name: string;
			readonly variants?: readonly string[] | undefined;
			readonly parameters?: ModelInfo["parameters"];
			readonly contextWindowOptions?: readonly ListedOption[] | undefined;
			readonly routingOptions?: readonly ListedOption[] | undefined;
		}[];
	}[],
): ModelInfo[] =>
	providers.flatMap((provider) =>
		provider.models.map((model) => ({
			id: model.id,
			name: model.name,
			providerId: provider.id,
			variants: Object.fromEntries(
				modelParameterChoices(model)
					.offered()
					.map((effort) => [effort, {}]),
			),
			...(model.parameters ? { parameters: model.parameters } : {}),
			...(model.contextWindowOptions
				? { contextWindowOptions: copyOptions(model.contextWindowOptions) }
				: {}),
			...(model.routingOptions
				? { routingOptions: copyOptions(model.routingOptions) }
				: {}),
		})),
	);
