import { formatModelName } from "../../stores/discovery.svelte.js";
import type { Immutable, ModelCost, ModelInfo } from "../../types.js";
import { resolveModelParameters } from "./model-parameters.js";
import type { ModelSelectionTarget } from "./model-selection-target.js";

/** Shared reactive presentation for the panel and its trigger. */
export function createModelSelectionState(
	getTarget: () => ModelSelectionTarget,
) {
	const target = $derived(getTarget());
	const activeModelId = $derived(target.pick.modelId);
	const activeProviderId = $derived(target.pick.providerId);
	const activeModel = $derived(target.activeModel);
	const parameters = $derived(activeModel?.parameters);
	const parameterState = $derived(
		resolveModelParameters(parameters, target.pick.effort),
	);
	const defaultCombination = $derived(parameterState.defaultCombination);
	function selectParameter(id: string, value: string) {
		const next = parameterState.parameterCombination(id, value);
		if (next && !target.pending.effort) target.selectEffort(next.variant);
	}
	const parameterRows = $derived(
		parameterState.rows.map((row) => ({
			...row,
			options: row.options.map((option) => ({
				...option,
				disabled: target.pending.effort || option.disabled,
			})),
		})),
	);
	const parameterEffort = $derived(
		parameterRows.find((row) => row.kind === "effort"),
	);
	const parameterContext = $derived(
		parameterRows.find((row) => row.kind === "context"),
	);
	const parameterToggles = $derived(
		parameterRows.filter(
			(row) => row.kind === "thinking" || row.kind === "fast",
		),
	);
	const parameterEffortWord = $derived.by(() => {
		if (parameters && parameterState.variantUnavailable)
			return target.pick.effort ?? "";
		const thinking = parameterRows.find((row) => row.kind === "thinking");
		const fast =
			parameterRows.find((row) => row.kind === "fast")?.value === "true";
		const label =
			parameterEffort?.label ??
			(thinking
				? thinking.value === "true"
					? "Thinking"
					: "No thinking"
				: "");
		return label
			? `${label}${fast ? " · Fast" : ""}`
			: fast
				? "Fast"
				: "Standard";
	});
	const contextOptions = $derived(target.contextWindowOptions);
	const selectedContext = $derived(target.pick.contextWindow);
	const contextSegments = $derived(
		parameterContext?.options ??
			contextOptions.map((option) => ({
				value: option.value,
				label: option.label,
				testId: `picker-context-option-${option.value}`,
				disabled: target.pending.contextWindow,
			})),
	);
	const effortSegments = $derived(
		parameterEffort?.options ??
			(parameters
				? []
				: target.effortOptions.map((variant) => ({
						value: variant,
						label: variant || "Default",
						testId: `picker-effort-option-${variant}`,
						disabled: target.pending.effort,
					}))),
	);

	/** Display name for the trigger button, with date suffix stripped.
	 *  Grouped models (Bedrock geo routing) append the active scope label. */
	const displayName = $derived.by(() => {
		if (target.inventory.loading) return "Loading…";
		if (activeModel) {
			const base = stripDateSuffix(formatModelName(activeModel));
			const scope = activeModel.routingOptions?.find(
				(option) => option.value === activeModelId,
			);
			return scope ? `${base} · ${scope.label}` : base;
		}
		if (activeModelId) {
			return stripDateSuffix(activeModelId);
		}
		return target.loading ? "Loading…" : "Select model";
	});

	return {
		get activeModelId() {
			return activeModelId;
		},
		get activeProviderId() {
			return activeProviderId;
		},
		get activeModel() {
			return activeModel;
		},
		get parameters() {
			return parameters;
		},
		get defaultCombination() {
			return defaultCombination;
		},
		get parameterContext() {
			return parameterContext;
		},
		get parameterRows() {
			return parameterRows;
		},
		get variantUnavailable() {
			return parameterState.variantUnavailable;
		},
		get parameterEffortWord() {
			return parameterEffortWord;
		},
		get contextOptions() {
			return contextOptions;
		},
		get selectedContext() {
			return selectedContext;
		},
		get contextSegments() {
			return contextSegments;
		},
		get effortSegments() {
			return effortSegments;
		},
		get parameterEffort() {
			return parameterEffort;
		},
		get parameterToggles() {
			return parameterToggles;
		},
		get displayName() {
			return displayName;
		},
		selectParameter,
	};
}

/** Strip date suffixes like -20250514 from model names. */
export function stripDateSuffix(name: string): string {
	return name.replace(/-\d{8}$/, "");
}

export function modelContextLabel(
	model: Immutable<ModelInfo> | undefined,
): string {
	if (model?.contextWindowOptions?.length) {
		return model.contextWindowOptions.map((option) => option.label).join(" / ");
	}
	const limit = model?.limit?.context;
	if (!limit) return "";
	return limit >= 1_000_000
		? `${limit / 1_000_000}M`
		: `${Math.round(limit / 1_000)}K`;
}

/** Format cost for display as per 1K tokens. */
export function formatCost(cost?: ModelCost): string {
	if (!cost) return "";
	const parts: string[] = [];
	if (cost.input != null) {
		parts.push(`$${formatCostValue(cost.input * 1000)}/1K in`);
	}
	if (cost.output != null) {
		parts.push(`$${formatCostValue(cost.output * 1000)}/1K out`);
	}
	return parts.join(", ");
}

function formatCostValue(value: number): string {
	if (value === 0) return "0";
	return Number.parseFloat(value.toFixed(6)).toString();
}
