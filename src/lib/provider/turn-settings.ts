import { Data, Either } from "effect";
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

export type Harness = "claude" | "opencode";

/** Model namespaces identify a harness, independently of account bindings. */
export function harnessForModelProvider(providerId: string): Harness {
	return providerId === "claude" ? "claude" : "opencode";
}

export interface TurnPick {
	harness: Harness;
	model: ModelSelection;
	effort: string;
	contextWindow: string;
}

/** Catalog identity and offered choices; empty choices use model defaults. */
export interface TurnSettings extends TurnPick {}

/** Read-time seeding only. A foreign stored pick stays visible for rejection. */
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
		else if (harness === "opencode") model = parse(nativeDefaultModel);
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

export class EffortNotOffered extends Data.TaggedError("EffortNotOffered")<{
	readonly modelId: string;
	readonly effort: string;
	readonly offered: readonly string[];
}> {
	override get message(): string {
		return `${this._tag}: effort ${JSON.stringify(this.effort)} is not offered by model ${this.modelId}`;
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
	| ModelNotInCatalog
	| EffortNotOffered
	| ContextWindowNotOffered;

export function isPickRejection(error: unknown): error is PickRejection {
	return (
		error instanceof ModelNotInCatalog ||
		error instanceof EffortNotOffered ||
		error instanceof ContextWindowNotOffered
	);
}

export function offeredOptions(model: ModelInfo): {
	efforts: readonly string[];
	contextWindows: readonly ContextWindowOption[];
} {
	return {
		efforts: Object.keys(model.variants ?? {}),
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
		(harness === "claude"
			? candidates.find((entry) => isSameModelIdentity(entry.id, model.modelId))
			: undefined)
	);
}

export function resolveTurnSettings(
	pick: TurnPick,
	catalog: readonly ModelInfo[],
): Either.Either<TurnSettings, PickRejection> {
	const model = findCatalogModel(pick.harness, pick.model, catalog);
	if (!model) {
		return Either.left(
			new ModelNotInCatalog({ harness: pick.harness, ...pick.model }),
		);
	}
	const isRoutingOption = model.routingOptions?.some(
		(option) => option.value === pick.model.modelId,
	);
	// A "[1m]" id matched to its base model asks for the 1m window, which the
	// base must then offer; an explicit window still wins.
	const askedFor1m =
		pick.harness === "claude" &&
		!isRoutingOption &&
		model.id !== pick.model.modelId &&
		model.id === claudeApiModelId(pick.model.modelId, "200k");
	const contextWindow = pick.contextWindow || (askedFor1m ? "1m" : "");
	const modelId = isRoutingOption ? pick.model.modelId : model.id;
	const { efforts, contextWindows } = offeredOptions(model);
	if (pick.effort !== "" && !efforts.includes(pick.effort)) {
		return Either.left(
			new EffortNotOffered({ modelId, effort: pick.effort, offered: efforts }),
		);
	}
	const offeredWindows = contextWindows.map((option) => option.value);
	if (contextWindow !== "" && !offeredWindows.includes(contextWindow)) {
		return Either.left(
			new ContextWindowNotOffered({
				modelId,
				contextWindow,
				offered: offeredWindows,
			}),
		);
	}
	return Either.right({
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
				(model.variants ?? []).map((effort) => [effort, {}]),
			),
			...(model.contextWindowOptions
				? { contextWindowOptions: copyOptions(model.contextWindowOptions) }
				: {}),
			...(model.routingOptions
				? { routingOptions: copyOptions(model.routingOptions) }
				: {}),
		})),
	);
