// Failure modes: default storage gets pinned, missing defaults choose arbitrary
// values, combination order masquerades as cost, stale keys fall back silently,
// row changes lose other values or select combinations the model cannot offer.
import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../../src/lib/contracts/ws-rpc.js";
import { ModelListResponseSchema } from "../../../src/lib/provider/codex/app-server/protocol.js";
import { codexModelInfo } from "../../../src/lib/provider/codex/codex-discovery.js";
import {
	modelParameterChoices,
	resolveTurnSettings,
} from "../../../src/lib/provider/turn-settings.js";

const model: ModelInfo = {
	id: "probe",
	name: "Probe",
	provider: "cursor",
	variants: ["stale-legacy"],
	parameters: {
		rows: [
			{
				id: "effort",
				label: "Effort",
				values: ["low", "medium", "high"].map((value) => ({
					value,
					label: value,
				})),
			},
			{
				id: "fast",
				label: "Fast",
				values: ["false", "true"].map((value) => ({ value, label: value })),
			},
		],
		combinations: [
			{ variant: "medium", values: { effort: "medium", fast: "false" } },
			{
				variant: "high",
				values: { effort: "high", fast: "false" },
				isDefault: true,
			},
			{ variant: "low", values: { effort: "low", fast: "false" } },
			{ variant: "low-fast", values: { effort: "low", fast: "true" } },
		],
	},
};

describe("Model Parameter Choice", () => {
	it("offers parameter keys and resolves the provider default independently of order", () => {
		const choices = modelParameterChoices(model);
		expect(choices.offered()).toEqual(["medium", "high", "low", "low-fast"]);
		expect(choices.resolve("")).toEqual(
			Result.succeed({
				_tag: "Default",
				values: [
					{ id: "effort", value: "high" },
					{ id: "fast", value: "false" },
				],
			}),
		);
		expect(choices.resolve("low-fast")).toEqual(
			Result.succeed({
				_tag: "Chosen",
				key: "low-fast",
				values: [
					{ id: "effort", value: "low" },
					{ id: "fast", value: "true" },
				],
			}),
		);
		expect(choices.cheapest()).toEqual({
			_tag: "Chosen",
			key: "low",
			values: [
				{ id: "effort", value: "low" },
				{ id: "fast", value: "false" },
			],
		});
	});
	it("leaves absent defaults to the provider and preserves the empty storage encoding", () => {
		const parameters = model.parameters;
		if (!parameters) throw new Error("Missing fixture parameters");
		const withoutDefault = {
			...model,
			parameters: {
				...parameters,
				combinations: parameters.combinations.map(({ variant, values }) => ({
					variant,
					values,
				})),
			},
		};
		expect(modelParameterChoices(withoutDefault).resolve("")).toEqual(
			Result.succeed({ _tag: "Default", values: [] }),
		);
		expect(
			resolveTurnSettings(
				{
					harness: "cursor",
					model: { providerId: "cursor", modelId: "probe" },
					effort: "",
					contextWindow: "",
				},
				[
					{
						id: model.id,
						name: model.name,
						parameters: model.parameters,
						providerId: "cursor",
						variants: {},
					},
				],
			),
		).toMatchObject({ success: { effort: "" } });
	});
	it("rejects stale keys and changes one row only within the offered combinations", () => {
		const choices = modelParameterChoices(model);
		expect(choices.resolve("retired")).toMatchObject({
			failure: {
				_tag: "ModelParametersUnavailable",
				reason: "not-offered",
				choice: "retired",
			},
		});
		expect(choices.withValue("low-fast", "effort", "high")).toBeUndefined();
		expect(choices.withValue("low-fast", "fast", "false")).toBe("low");
		expect(choices.withValue("", "effort", "medium")).toBe("medium");
		expect(choices.withValue("retired", "effort", "low")).toBeUndefined();
	});
	it("lets each row leave Default without a marked default and preserves other chosen values", () => {
		const choices = modelParameterChoices({
			id: "no-default",
			parameters: {
				rows: [
					{
						id: "effort",
						label: "Effort",
						values: [
							{ value: "low", label: "Low" },
							{ value: "high", label: "High" },
						],
					},
					{
						id: "fast",
						label: "Fast",
						values: [
							{ value: "false", label: "Off" },
							{ value: "true", label: "On" },
						],
					},
				],
				combinations: [
					{ variant: "high-fast", values: { effort: "high", fast: "true" } },
					{ variant: "low", values: { effort: "low", fast: "false" } },
					{ variant: "high", values: { effort: "high", fast: "false" } },
					{ variant: "low-fast", values: { effort: "low", fast: "true" } },
				],
			},
		});
		expect(choices.resolve("")).toEqual(
			Result.succeed({ _tag: "Default", values: [] }),
		);
		for (const [row, value, expected] of [
			["effort", "low", "low"],
			["effort", "high", "high-fast"],
			["fast", "false", "low"],
			["fast", "true", "high-fast"],
		] as const) {
			const key = choices.withValue("", row, value);
			expect(key).toBe(expected);
			expect(choices.offered()).toContain(key);
		}
		expect(choices.withValue("low", "effort", "high")).toBe("high");
		expect(choices.withValue("low", "fast", "true")).toBe("low-fast");
		expect(choices.resolve("")).toEqual(
			Result.succeed({ _tag: "Default", values: [] }),
		);
	});
	it("prefers an exact row edit over an earlier compatible combination", () => {
		const choices = modelParameterChoices({
			id: "partial-choices",
			parameters: {
				rows: [
					{
						id: "effort",
						label: "Effort",
						values: [{ value: "high", label: "High" }],
					},
					{
						id: "fast",
						label: "Fast",
						values: [{ value: "true", label: "On" }],
					},
				],
				combinations: [
					{ variant: "high-fast", values: { effort: "high", fast: "true" } },
					{ variant: "high", values: { effort: "high" } },
				],
			},
		});
		expect(choices.withValue("", "effort", "high")).toBe("high");
	});
	it.each([
		"claude",
		"anthropic",
	])("validates legacy %s variants without inventing parameter values", (provider) => {
		const legacy: ModelInfo = {
			id: "legacy",
			name: "Legacy",
			provider,
			variants: ["low", "high"],
		};
		const choices = modelParameterChoices(legacy);
		expect(choices.offered()).toEqual(["low", "high"]);
		expect(choices.resolve("high")).toEqual(
			Result.succeed({ _tag: "Chosen", key: "high", values: [] }),
		);
		expect(choices.resolve("")).toEqual(
			Result.succeed({ _tag: "Default", values: [] }),
		);
		expect(choices.cheapest()).toEqual({ _tag: "Default", values: [] });
		expect(choices.resolve("stale")).toMatchObject({
			failure: { _tag: "ModelParametersUnavailable", reason: "not-offered" },
		});
	});
	it("uses the cheapest-first Codex effort order pinned by the captured model list", () => {
		const rows = readFileSync(
			"test/fixtures/codex-app-server-traces/model-list.jsonl",
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { message?: { result?: unknown } });
		const response = rows
			.map((row) =>
				Schema.decodeUnknownResult(ModelListResponseSchema)(
					row.message?.result,
				),
			)
			.find(Result.isSuccess);
		if (!response) throw new Error("Missing captured Codex model list");
		expect(response.success.data.length).toBeGreaterThan(0);
		for (const captured of response.success.data) {
			expect(
				captured.supportedReasoningEfforts.map(
					({ reasoningEffort }) => reasoningEffort,
				),
			).toEqual(
				captured.model === "gpt-5.5"
					? ["low", "medium", "high", "xhigh"]
					: captured.model === "gpt-6-luna" ||
							captured.model === "gpt-5.6-luna" ||
							captured.model === "codex-auto-review"
						? ["low", "medium", "high", "xhigh", "max"]
						: ["low", "medium", "high", "xhigh", "max", "ultra"],
			);
			expect(
				modelParameterChoices(codexModelInfo(captured)).cheapest(),
			).toEqual({
				_tag: "Chosen",
				key: "low",
				values: [{ id: "effort", value: "low" }],
			});
		}
	});
});
