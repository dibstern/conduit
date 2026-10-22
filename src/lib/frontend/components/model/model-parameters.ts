import type { Immutable, ModelInfo } from "../../types.js";

/** Resolve each parameter independently while preserving the other values. */
export function resolveModelParameters(
	parameters: Immutable<ModelInfo["parameters"]>,
	variant: string | null | undefined,
) {
	const defaultCombination =
		parameters?.combinations.find((entry) => entry.isDefault) ??
		parameters?.combinations[0];
	const selectedCombination = parameters?.combinations.find(
		(entry) => entry.variant === variant,
	);
	const combination = selectedCombination ?? defaultCombination;
	function parameterCombination(id: string, value: string) {
		if (!combination) return undefined;
		const values = { ...combination.values, [id]: value };
		return parameters?.combinations.find(
			(entry) =>
				Object.keys(entry.values).length === Object.keys(values).length &&
				Object.entries(values).every(
					([key, value]) => entry.values[key] === value,
				),
		);
	}
	const rows = (parameters?.rows ?? []).flatMap((row) => {
		const kind = ["effort", "reasoning", "reasoning_effort"].includes(row.id)
			? "effort"
			: row.id;
		if (!["effort", "context", "thinking", "fast"].includes(kind)) return [];
		const options = row.values.map(({ value, label }) => ({
			value,
			label:
				kind === "effort"
					? value
					: kind === "thinking" || kind === "fast"
						? value === "true"
							? "On"
							: "Off"
						: label,
			testId: `picker-${kind}-option-${value}`,
			disabled: !parameterCombination(row.id, value),
		}));
		const value = combination?.values[row.id] ?? "";
		return [
			{
				id: row.id,
				kind,
				title:
					kind === "effort"
						? "Effort"
						: kind === "context"
							? "Context"
							: kind === "thinking"
								? "Thinking"
								: "Fast",
				options,
				value,
				label: options.find((option) => option.value === value)?.label ?? value,
			},
		];
	});
	return {
		defaultCombination,
		combination,
		variantUnavailable: Boolean(variant && !selectedCombination),
		rows,
		parameterCombination,
	};
}
