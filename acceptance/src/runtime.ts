import type { Page } from "@playwright/test";
import type { ApsFeature } from "./apsTypes.js";
import { expandFeature, resolveStepText } from "./exampleExpansion.js";
import type { PlaywrightDriver } from "./playwrightDriver.js";

export type AcceptanceWorld = {
	page: Page;
	driver: PlaywrightDriver;
	artifacts: string[];
};

type ScenarioLifecycleInput = {
	scenarioName: string;
	exampleIndex: number;
	example: Record<string, string>;
};

export type AcceptanceLifecycle = {
	createWorld: (
		input: ScenarioLifecycleInput,
	) => Promise<AcceptanceWorld> | AcceptanceWorld;
	afterScenario?: (
		input: ScenarioLifecycleInput & {
			world: AcceptanceWorld;
			error?: unknown;
		},
	) => Promise<void> | void;
	afterFeature?: (input: { error?: unknown }) => Promise<void> | void;
};

export type StepHandler = {
	name: string;
	match: RegExp;
	run: (input: {
		world: AcceptanceWorld;
		text: string;
		match: RegExpMatchArray;
		example: Record<string, string>;
	}) => Promise<void> | void;
};

export async function runFeature(
	feature: ApsFeature,
	handlers: StepHandler[],
	lifecycle: AcceptanceLifecycle,
): Promise<void> {
	let featureError: unknown;

	try {
		for (const execution of expandFeature(feature)) {
			const lifecycleInput = {
				scenarioName: execution.scenarioName,
				exampleIndex: execution.exampleIndex,
				example: execution.example,
			};
			const world = await lifecycle.createWorld(lifecycleInput);
			let scenarioError: unknown;

			try {
				for (const step of execution.steps) {
					const text = resolveStepText(step.text, execution.example);
					const found = handlers
						.map((handler) => ({
							handler,
							match: text.match(handler.match),
						}))
						.find((candidate) => candidate.match);

					if (!found?.match) {
						throw new Error(`Unsupported acceptance step: ${text}`);
					}

					try {
						await found.handler.run({
							world,
							text,
							match: found.match,
							example: execution.example,
						});
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						throw new Error(
							`Acceptance step failed in "${execution.scenarioName}" example ${execution.exampleIndex + 1} using ${found.handler.name}: ${message}`,
							{ cause: error },
						);
					}
				}
			} catch (error) {
				scenarioError = error;
			}

			try {
				await lifecycle.afterScenario?.({
					...lifecycleInput,
					world,
					error: scenarioError,
				});
			} catch (error) {
				if (!scenarioError) {
					const message =
						error instanceof Error ? error.message : String(error);
					scenarioError = new Error(
						`Acceptance scenario cleanup failed in "${execution.scenarioName}" example ${execution.exampleIndex + 1}: ${message}`,
						{ cause: error },
					);
				}
			}

			if (scenarioError) {
				throw scenarioError;
			}

			console.log(
				`PASS ${execution.scenarioName}/example_${execution.exampleIndex + 1}`,
			);
		}
	} catch (error) {
		featureError = error;
	}

	try {
		await lifecycle.afterFeature?.({ error: featureError });
	} catch (error) {
		if (!featureError) {
			featureError = error;
		}
	}

	if (featureError) {
		throw featureError;
	}

	console.log(`PASS Feature: ${feature.name}`);
}
