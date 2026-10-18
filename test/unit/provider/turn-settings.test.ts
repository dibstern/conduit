/*
 * Resolver failure modes:
 * - Missing catalog/model, wrong provider namespace, unrelated aliases or dates.
 * - A pick or catalog entry belongs to the other harness, including anthropic
 *   being an OpenCode namespace rather than the Claude SDK namespace.
 * - An unknown effort, including a non-empty effort on absent/empty variants.
 * - An unknown context window, including a non-empty window on absent/empty
 *   options. Empty effort/window must always mean the model's default.
 * - Exact, routing and Claude [1m] identities are confused, routing ids are
 *   discarded, or suffix matching leaks across providers or into OpenCode.
 * - Claude [1m] folding loses the selected window or overrides an explicit one,
 *   or silently drops a [1m] request whose base model does not offer 1m;
 *   folding must use the catalog's options rather than a hardcoded model table.
 * - Offered lists, rejection fields or normalized settings are wrong, or
 *   resolution mutates the pick/catalog.
 */
import { Result as Either } from "effect";
import { describe, expect, it } from "vitest";
import {
	findCatalogModel,
	harnessForModelProvider,
	offeredOptions,
	resolveTurnSettings,
	type TurnPick,
} from "../../../src/lib/provider/turn-settings.js";
import type { ModelInfo } from "../../../src/lib/provider/types.js";

const windows = [
	{ value: "200k", label: "200k", isDefault: true },
	{ value: "1m", label: "1M" },
];
const claude: ModelInfo = {
	id: "sonnet",
	name: "Sonnet",
	providerId: "claude",
	variants: { low: {}, high: {} },
	contextWindowOptions: windows,
};
const opencode: ModelInfo = {
	id: "sonnet",
	name: "OpenCode Sonnet",
	providerId: "anthropic",
	variants: { medium: {}, high: {} },
	contextWindowOptions: windows,
};
const routing = {
	id: "bedrock-sonnet",
	name: "Bedrock Sonnet",
	providerId: "amazon-bedrock",
	variants: { high: {} },
	routingOptions: [{ value: "us.bedrock-sonnet", label: "US" }],
};
const catalog: readonly ModelInfo[] = [
	claude,
	opencode,
	routing,
	{ id: "plain", name: "Plain Claude", providerId: "claude" },
	{ id: "plain", name: "Plain OpenCode", providerId: "openai" },
	{
		id: "empty",
		name: "Empty Claude",
		providerId: "claude",
		variants: {},
		contextWindowOptions: [],
	},
	{
		id: "empty",
		name: "Empty OpenCode",
		providerId: "openai",
		variants: {},
		contextWindowOptions: [],
	},
	{
		id: "new-model",
		name: "Future Claude model",
		providerId: "claude",
		contextWindowOptions: windows,
	},
];

const pick = (overrides: Partial<TurnPick> = {}): TurnPick => ({
	harness: "claude",
	model: { providerId: "claude", modelId: "sonnet" },
	effort: "",
	contextWindow: "",
	...overrides,
});

describe("harnessForModelProvider", () => {
	it.each([
		["claude", "claude"],
		["anthropic", "opencode"],
		["openai", "opencode"],
		["amazon-bedrock", "opencode"],
		["claude-sdk", "opencode"],
		["work-claude", "opencode"],
		["", "opencode"],
	])("routes %j to %s", (providerId, expected) => {
		expect(harnessForModelProvider(providerId)).toBe(expected);
	});
});

describe("offeredOptions", () => {
	it.each(catalog)("reads options for $providerId/$id", (model) => {
		expect(offeredOptions(model)).toEqual({
			efforts: Object.keys(model.variants ?? {}),
			contextWindows: model.contextWindowOptions ?? [],
		});
	});
});

describe("findCatalogModel", () => {
	it.each([
		{
			name: "Claude exact",
			harness: "claude",
			providerId: "claude",
			modelId: "sonnet",
			expected: claude,
		},
		{
			name: "OpenCode exact",
			harness: "opencode",
			providerId: "anthropic",
			modelId: "sonnet",
			expected: opencode,
		},
		{
			name: "Claude suffix",
			harness: "claude",
			providerId: "claude",
			modelId: "sonnet[1M]",
			expected: claude,
		},
		{
			name: "routing option",
			harness: "opencode",
			providerId: "amazon-bedrock",
			modelId: "us.bedrock-sonnet",
			expected: routing,
		},
		{
			name: "wrong namespace",
			harness: "opencode",
			providerId: "other",
			modelId: "sonnet",
			expected: undefined,
		},
		{
			name: "OpenCode suffix is not an identity",
			harness: "opencode",
			providerId: "anthropic",
			modelId: "sonnet[1m]",
			expected: undefined,
		},
		{
			name: "Claude namespace in OpenCode",
			harness: "opencode",
			providerId: "claude",
			modelId: "sonnet",
			expected: undefined,
		},
		{
			name: "anthropic namespace in Claude",
			harness: "claude",
			providerId: "anthropic",
			modelId: "sonnet",
			expected: undefined,
		},
	] as const)("$name", ({ harness, providerId, modelId, expected }) => {
		expect(findCatalogModel(harness, { providerId, modelId }, catalog)).toBe(
			expected,
		);
	});

	it("prefers an exact catalog id over suffix equivalence", () => {
		const suffixed = { ...claude, id: "sonnet[1m]" };
		expect(
			findCatalogModel(
				"claude",
				{ providerId: "claude", modelId: suffixed.id },
				[claude, suffixed],
			),
		).toBe(suffixed);
	});
});

describe("resolveTurnSettings", () => {
	it.each([
		{ name: "Claude defaults", input: pick(), expected: pick() },
		{
			name: "Claude offered choices",
			input: pick({ effort: "high", contextWindow: "1m" }),
			expected: pick({ effort: "high", contextWindow: "1m" }),
		},
		{
			name: "OpenCode offered choices",
			input: pick({
				harness: "opencode",
				model: { providerId: "anthropic", modelId: "sonnet" },
				effort: "medium",
				contextWindow: "200k",
			}),
			expected: pick({
				harness: "opencode",
				model: { providerId: "anthropic", modelId: "sonnet" },
				effort: "medium",
				contextWindow: "200k",
			}),
		},
		{
			name: "Claude [1m] folds",
			input: pick({ model: { providerId: "claude", modelId: "sonnet[1m]" } }),
			expected: pick({ contextWindow: "1m" }),
		},
		{
			name: "Claude [1M] folds",
			input: pick({ model: { providerId: "claude", modelId: "sonnet[1M]" } }),
			expected: pick({ contextWindow: "1m" }),
		},
		{
			name: "explicit context wins over suffix",
			input: pick({
				model: { providerId: "claude", modelId: "sonnet[1m]" },
				contextWindow: "200k",
			}),
			expected: pick({ contextWindow: "200k" }),
		},
		{
			name: "suffix folding uses catalog capabilities",
			input: pick({
				model: { providerId: "claude", modelId: "new-model[1m]" },
			}),
			expected: pick({
				model: { providerId: "claude", modelId: "new-model" },
				contextWindow: "1m",
			}),
		},
		{
			name: "routing id retained",
			input: pick({
				harness: "opencode",
				model: { providerId: "amazon-bedrock", modelId: "us.bedrock-sonnet" },
				effort: "high",
			}),
			expected: pick({
				harness: "opencode",
				model: { providerId: "amazon-bedrock", modelId: "us.bedrock-sonnet" },
				effort: "high",
			}),
		},
		...(["claude", "opencode"] as const).flatMap((harness) =>
			["plain", "empty"].map((modelId) => {
				const input = pick({
					harness,
					model: {
						providerId: harness === "claude" ? "claude" : "openai",
						modelId,
					},
				});
				return {
					name: `${harness} ${modelId} defaults`,
					input,
					expected: input,
				};
			}),
		),
	])("$name", ({ input, expected }) => {
		expect(resolveTurnSettings(input, catalog)).toEqual(Either.right(expected));
	});

	it.each([
		{
			input: pick({ model: { providerId: "claude", modelId: "missing" } }),
			tag: "ModelNotInCatalog",
		},
		{
			input: pick({
				model: { providerId: "claude", modelId: "claude-sonnet-20260101" },
			}),
			tag: "ModelNotInCatalog",
		},
		{
			input: pick({ model: { providerId: "anthropic", modelId: "sonnet" } }),
			tag: "ModelNotInCatalog",
		},
		{ input: pick({ harness: "opencode" }), tag: "ModelNotInCatalog" },
		{
			input: pick({
				harness: "opencode",
				model: { providerId: "other", modelId: "sonnet" },
			}),
			tag: "ModelNotInCatalog",
		},
		{ input: pick({ effort: "medium" }), tag: "EffortNotOffered" },
		{
			input: pick({
				harness: "opencode",
				model: { providerId: "anthropic", modelId: "sonnet" },
				effort: "low",
			}),
			tag: "EffortNotOffered",
		},
		{ input: pick({ contextWindow: "2m" }), tag: "ContextWindowNotOffered" },
		{
			input: pick({ model: { providerId: "claude", modelId: "plain[1m]" } }),
			tag: "ContextWindowNotOffered",
		},
		{
			input: pick({
				harness: "opencode",
				model: { providerId: "anthropic", modelId: "sonnet" },
				contextWindow: "2m",
			}),
			tag: "ContextWindowNotOffered",
		},
		...(["claude", "opencode"] as const).flatMap((harness) =>
			["plain", "empty"].flatMap((modelId) => {
				const model = {
					providerId: harness === "claude" ? "claude" : "openai",
					modelId,
				};
				return [
					{
						input: pick({ harness, model, effort: "high" }),
						tag: "EffortNotOffered",
					},
					{
						input: pick({ harness, model, contextWindow: "1m" }),
						tag: "ContextWindowNotOffered",
					},
				];
			}),
		),
	])("rejects $tag for $input", ({ input, tag }) => {
		const result = resolveTurnSettings(input, catalog);
		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe(tag);
			expect(result.left.message).toMatch(new RegExp(`^${tag}:`));
		}
	});

	it("rejects an empty catalog with model identity fields", () => {
		expect(resolveTurnSettings(pick(), [])).toMatchObject({
			left: {
				_tag: "ModelNotInCatalog",
				harness: "claude",
				providerId: "claude",
				modelId: "sonnet",
			},
		});
	});

	it("reports the requested effort and offered efforts", () => {
		expect(resolveTurnSettings(pick({ effort: "max" }), catalog)).toMatchObject(
			{
				left: {
					_tag: "EffortNotOffered",
					modelId: "sonnet",
					effort: "max",
					offered: ["low", "high"],
				},
			},
		);
	});

	it("reports the requested context window and offered values", () => {
		expect(
			resolveTurnSettings(pick({ contextWindow: "2m" }), catalog),
		).toMatchObject({
			left: {
				_tag: "ContextWindowNotOffered",
				modelId: "sonnet",
				contextWindow: "2m",
				offered: ["200k", "1m"],
			},
		});
	});

	it("uses a suffix-only catalog's advertised id", () => {
		expect(
			resolveTurnSettings(pick(), [{ ...claude, id: "sonnet[1m]" }]),
		).toEqual(
			Either.right(
				pick({ model: { providerId: "claude", modelId: "sonnet[1m]" } }),
			),
		);
	});

	it("does not mutate input or catalog", () => {
		const input = pick({
			model: { providerId: "claude", modelId: "sonnet[1m]" },
		});
		const before = structuredClone({ input, catalog });
		resolveTurnSettings(input, catalog);
		expect({ input, catalog }).toEqual(before);
	});
});
