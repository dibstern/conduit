import type { ApsFeature, ApsStep } from "./apsTypes.js";

export type ScenarioExecution = {
	featureName: string;
	scenarioIndex: number;
	scenarioName: string;
	exampleIndex: number;
	example: Record<string, string>;
	steps: ApsStep[];
};

export function expandFeature(feature: ApsFeature): ScenarioExecution[] {
	const background = feature.background ?? [];

	return feature.scenarios.flatMap((scenario, scenarioIndex) => {
		const examples = scenario.examples.length > 0 ? scenario.examples : [{}];

		return examples.map((example, exampleIndex) => ({
			featureName: feature.name,
			scenarioIndex,
			scenarioName: scenario.name,
			exampleIndex,
			example,
			steps: [...background, ...scenario.steps],
		}));
	});
}

export function resolveStepText(
	text: string,
	example: Record<string, string>,
): string {
	return text.replace(/<([A-Za-z0-9_]+)>/g, (_match, key: string) => {
		const value = example[key];
		if (value == null) {
			throw new Error(`Missing example value for <${key}>`);
		}
		return value;
	});
}
