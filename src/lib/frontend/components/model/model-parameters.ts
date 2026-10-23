import { Result } from "effect";
import { modelParameterChoices } from "../../../provider/turn-settings.js";

/** Resolve each parameter independently while preserving the other values. */
export function resolveModelParameters(
	model: Parameters<typeof modelParameterChoices>[0] | undefined,
	variant: string | null | undefined,
) {
	const choices = modelParameterChoices(model ?? { id: "" });
	const resolved = choices.resolve(variant ?? "");
	const defaultChoice = Result.getOrUndefined(choices.resolve(""));
	const unavailable = Result.isFailure(resolved) ? resolved.failure : undefined;
	// Keep stale picks visible. An explicit replacement starts from the provider
	// default; rendering never changes the stored choice.
	const values = Object.fromEntries(
		(Result.isSuccess(resolved)
			? resolved.success.values
			: (defaultChoice?.values ?? [])
		).map(({ id, value }) => [id, value]),
	);
	const withValue = (id: string, value: string) =>
		choices.withValue(unavailable ? "" : (variant ?? ""), id, value);
	const rows = (model?.parameters?.rows ?? []).flatMap((row) => {
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
			disabled: withValue(row.id, value) === undefined,
		}));
		const value = values[row.id] ?? "";
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
		defaultValues: Object.fromEntries(
			(defaultChoice?.values ?? []).map(({ id, value }) => [id, value]),
		),
		unavailable,
		variantUnavailable: unavailable !== undefined,
		rows,
		withValue,
	};
}
