import { expect } from "@playwright/test";
import { chooseSettingsOption } from "../../../test/e2e/helpers/settings.js";
import type { StepHandler } from "../runtime.js";
import { effortOptions, requireRpcControl } from "./shared.js";

const sessionId = "sess-first-send";
// Captured parameter shapes, with the driver's existing combination keys.
const fastValues = ["false", "true"];
const fastRow = {
	id: "fast",
	label: "Fast",
	values: fastValues.map((value) => ({
		value,
		label: value === "true" ? "Fast" : "None",
	})),
};
const grokContexts = [
	{ value: "256k", label: "256K" },
	{ value: "500k", label: "500K" },
];
const grokEfforts = ["low", "medium", "high", "xhigh"];
const grokCombinations = grokContexts.flatMap((context) =>
	grokEfforts.flatMap((effort) =>
		fastValues.map((fast) => ({
			variant: `${context.label} · ${effort}${fast === "true" ? " · Fast" : ""}`,
			values: { context: context.value, reasoning_effort: effort, fast },
			isDefault:
				context.value === "500k" && effort === "high" && fast === "false",
		})),
	),
);
const gptContexts = [
	{ value: "272k", label: "272K" },
	{ value: "1m", label: "1M" },
];
const gptEfforts = ["none", "low", "medium", "high", "extra-high"];
const gptCombinations = gptContexts.flatMap((context) =>
	gptEfforts.flatMap((effort) =>
		(context.value === "1m" ? ["false"] : fastValues).map((fast) => ({
			variant: `${context.label} · ${effort}${fast === "true" ? " · Fast" : ""}`,
			values: { context: context.value, reasoning: effort, fast },
			isDefault:
				context.value === "1m" && effort === "medium" && fast === "false",
		})),
	),
);
const models = [
	{
		id: "composer-2.5",
		name: "Composer 2.5",
		provider: "cursor",
		parameters: {
			rows: [fastRow],
			combinations: fastValues.map((fast) => ({
				variant: fast === "true" ? "Fast" : "Standard",
				values: { fast },
				isDefault: fast === "false",
			})),
		},
	},
	{
		id: "grok-4.7",
		name: "Grok 4.7",
		provider: "cursor",
		parameters: {
			rows: [
				{ id: "context", label: "Context", values: grokContexts },
				{
					id: "reasoning_effort",
					label: "Reasoning effort",
					values: grokEfforts.map((value) => ({
						value,
						label: value === "xhigh" ? "Extra High" : value,
					})),
				},
				fastRow,
			],
			combinations: grokCombinations,
		},
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		provider: "cursor",
		parameters: {
			rows: [
				{ id: "context", label: "Context", values: gptContexts },
				{
					id: "reasoning",
					label: "Reasoning",
					values: gptEfforts.map((value) => ({
						value,
						label: value === "extra-high" ? "Extra High" : value,
					})),
				},
				fastRow,
			],
			combinations: gptCombinations,
		},
	},
].map((model) => ({
	...model,
	variants: model.parameters.combinations.map(({ variant }) => variant),
}));

const rowValues = (text: string, separator: string) =>
	Object.fromEntries(
		text.split(separator).map((entry) => {
			const [kind = "", value = ""] = entry.split("=");
			return [kind, value] as const;
		}),
	);

export const cursorModelParametersHandlers: StepHandler[] = [
	{
		name: "assert Cursor effort chip labels",
		match:
			/^the Cursor effort chip describes (.+) instead of combination (.+)$/,
		run: async ({ world, match }) => {
			const chip = world.page.getByTestId("variant-badge");
			await expect(chip).toHaveText(match[1] ?? "");
			await expect(chip).toHaveAttribute(
				"aria-label",
				`Effort: ${match[1]}. Open effort options`,
			);
			await expect(chip).toHaveAttribute(
				"title",
				`Effort ${match[1]}. Ctrl+T to cycle`,
			);
			await expect(chip).not.toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert Cursor phone effort row labels",
		match: /^the Cursor phone effort row omits combination (.+)$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("composer-more-effort");
			await expect(row).not.toContainText(match[1] ?? "");
			await expect(row).toHaveAttribute(
				"aria-label",
				"Effort: xhigh · Fast. Open effort options",
			);
		},
	},
	{
		name: "prepare Cursor title generation combination",
		match: /^Cursor titles use combination (.+)$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setProjectSetting({
				_tag: "titleGeneration",
				selection: {
					account: { _tag: "Id", id: "cursor-work" },
					providerId: "cursor",
					modelId: "grok-4.7",
					effort: match[1] ?? "",
				},
				status: "unverified",
			});
		},
	},
	{
		name: "assert Cursor title model combination RPC",
		match: /^the Cursor title model saves combination (.+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				({ tag, payload }) =>
					tag === "SetTitleGeneration" &&
					(payload["selection"] as { effort?: string } | null)?.effort ===
						match[1],
			);
			expect(request.payload["selection"]).toEqual({
				account: { _tag: "Id", id: "cursor-work" },
				providerId: "cursor",
				modelId: "grok-4.7",
				effort: match[1],
			});
			await expect(
				world.page.getByTestId("title-generation-picker"),
			).toHaveAttribute("aria-busy", "false");
		},
	},
	{
		name: "assert Cursor title summary values",
		match: /^the Cursor title summary shows (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("settings-title-generation-picker"),
			).toContainText(match[1] ?? "");
		},
	},
	{
		name: "prepare Cursor default saves",
		match: /^Cursor defaults can be saved$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setProjectSetting({
				_tag: "harnessDefaults",
				claude: { status: "missing" },
				opencode: { status: "missing" },
				cursor: { status: "missing" },
			});
			rpc.setStubs({
				SetHarnessDefault: ({
					projectSlug,
					harness,
					providerId,
					modelId,
					effort = "",
					contextWindow,
				}) => ({
					projectSlug,
					harness,
					state: {
						pick: { providerId, modelId, effort: effort ?? "", contextWindow },
						status: "ok",
					},
				}),
			});
		},
	},
	{
		name: "prepare unavailable Cursor default combination",
		match: /^the saved Cursor default has unavailable combination (.+)$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setProjectSetting({
				_tag: "harnessDefaults",
				claude: { status: "missing" },
				opencode: { status: "missing" },
				cursor: {
					status: "invalid",
					problem: "EffortNotOffered",
					pick: {
						providerId: "cursor",
						modelId: "grok-4.7",
						effort: match[1] ?? "",
						contextWindow: "",
					},
				},
			});
		},
	},
	{
		name: "assert unavailable Cursor default remains visible",
		match: /^the saved Cursor combination (.+) is shown as unavailable$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId(
				"settings-harness-default-cursor-unavailable",
			);
			await expect(picker).toBeDisabled();
			await expect(picker).toHaveText(`${match[1]} (unavailable)`);
		},
	},
	{
		name: "assert unavailable Cursor default parameter choice",
		match:
			/^the Cursor default (fast|context) option (\S+) is (disabled|enabled)$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId(`settings-harness-default-cursor-${match[1]}`)
				.click();
			const option = world.page
				.getByRole("menuitemradio")
				.and(world.page.locator(`[data-value="${match[2]}"]`));
			if (match[3] === "disabled") await expect(option).toBeDisabled();
			else await expect(option).toBeEnabled();
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "choose Cursor default model",
		match: /^I choose (\S+) as the Cursor default model$/,
		run: async ({ world, match }) => {
			await chooseSettingsOption(
				world.page,
				world.page.getByTestId("settings-harness-default-cursor-model"),
				`cursor/${match[1]}`,
			);
		},
	},
	{
		name: "assert Cursor default parameter selections",
		match: /^the Cursor default parameter pickers show (.+)$/,
		run: async ({ world, match }) => {
			const values = rowValues(match[1] ?? "", ", ");
			await expect(
				world.page.locator(
					'button[data-testid^="settings-harness-default-cursor-"]',
				),
			).toHaveCount(Object.keys(values).length + 1);
			for (const [kind, value] of Object.entries(values)) {
				const picker = world.page.getByTestId(
					`settings-harness-default-cursor-${kind}`,
				);
				await expect(picker).toBeVisible();
				await expect(picker).toHaveAttribute("data-value", value);
				await expect(picker).toHaveAttribute(
					"aria-label",
					new RegExp(`^Cursor ${kind[0]?.toUpperCase()}${kind.slice(1)}:`),
				);
			}
		},
	},
	{
		name: "assert Cursor default parameter choices replace combination keys",
		match: /^the Cursor default (context|effort|fast) picker offers (.+)$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId(`settings-harness-default-cursor-${match[1]}`)
				.click();
			await expect(world.page.getByRole("menuitemradio")).toHaveText(
				(match[2] ?? "").split(", "),
			);
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "choose Cursor default parameter",
		match: /^I set Cursor default (context|effort|fast) to (\S+)$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId(
				`settings-harness-default-cursor-${match[1]}`,
			);
			await chooseSettingsOption(world.page, picker, match[2] ?? "");
			await expect(picker).toHaveAttribute("data-value", match[2] ?? "");
		},
	},
	{
		name: "assert Cursor default combination RPC",
		match: /^the Cursor default saves combination (.+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetHarnessDefault" &&
					request.payload["effort"] === match[1],
			);
			expect(request.payload).toMatchObject({
				projectSlug: "myapp",
				harness: "cursor",
				providerId: "cursor",
				modelId: "grok-4.7",
				effort: match[1],
				contextWindow: "",
			});
		},
	},
	{
		name: "prepare Cursor parameter catalogue",
		match: /^the Cursor parameter catalogue is ready for (\S+)$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const modelId = match[1] ?? "";
			const model = models.find((model) => model.id === modelId);
			if (!model) throw new Error(`Unknown Cursor parameter model: ${modelId}`);
			const choices = model.variants;
			effortOptions.set(world.page, choices);
			rpc.setProjectSetting({
				_tag: "providerModels",
				accountId: "cursor-work",
				providers: [
					{
						id: "cursor",
						name: "Cursor",
						configured: true,
						models,
					},
				],
			});
			const {
				GetModels: getModels,
				GetAgents: getAgents,
				CreateSession: createSession,
				SwitchVariant: switchVariant,
			} = rpc.stubs;
			if (!getModels || !getAgents || !createSession || !switchVariant)
				throw new Error("Cursor parameters wrap the mockup's typed stubs");
			let variant = "";
			rpc.setStubs({
				GetModels: (payload) =>
					payload.instanceId === "cursor-work" ||
					("sessionId" in payload && payload.sessionId === sessionId)
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providers: [
									{ id: "cursor", name: "Cursor", configured: true, models },
								],
								active: { provider: "cursor", model: modelId },
								variant: { variant, variants: choices },
							}
						: getModels(payload),
				GetAgents: (payload) =>
					payload.instanceId === "cursor-work" ||
					("sessionId" in payload && payload.sessionId === sessionId)
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providerScope: { id: "cursor", name: "Cursor" },
								agents: [],
							}
						: getAgents(payload),
				CreateSession: (payload) => {
					if (payload.instanceId === "cursor-work")
						variant = payload.model?.variant ?? "";
					return createSession(payload);
				},
				SwitchVariant: (payload) => {
					if (payload.sessionId === sessionId) variant = payload.variant;
					return switchVariant(payload);
				},
			});
		},
	},
	{
		name: "assert separate Cursor parameter rows",
		match: /^the Cursor (title )?parameter rows offer (.+)$/,
		run: async ({ world, match }) => {
			const rows = rowValues(match[2] ?? "", "; ");
			const picker = world.page.getByTestId(
				match[1] ? "title-generation-picker" : "model-picker",
			);
			for (const kind of ["context", "effort", "thinking", "fast"]) {
				const row = picker.getByTestId(`picker-row-${kind}`);
				const choices = rows[kind]?.split("/");
				if (!choices) {
					await expect(row).toHaveCount(0);
					continue;
				}
				await expect(row).toBeVisible();
				await expect(row.getByRole("radio")).toHaveCount(choices.length);
				for (const value of choices) {
					const option = row.getByTestId(`picker-${kind}-option-${value}`);
					await expect(option).toBeVisible();
					if (kind === "fast" || kind === "thinking")
						await expect(option).toHaveText(value === "true" ? "On" : "Off");
					if (kind === "effort") await expect(option).toHaveText(value);
					if (kind === "context")
						await expect(option).toHaveText(
							[...grokContexts, ...gptContexts].find(
								(entry) => entry.value === value,
							)?.label ?? value,
						);
				}
			}
		},
	},
	{
		name: "assert Cursor parameter options fit the picker",
		match: /^the Cursor parameter options fit inside the model picker$/,
		run: async ({ world }) => {
			const picker = world.page.getByTestId("model-picker");
			const bounds = await picker.boundingBox();
			if (!bounds) throw new Error("Model picker has no visible bounds");
			const options = picker.locator(
				'[data-testid^="picker-"][data-testid*="-option-"]',
			);
			for (const option of await options.all()) {
				const box = await option.boundingBox();
				if (!box) throw new Error("Cursor parameter option is hidden");
				expect(box.x).toBeGreaterThanOrEqual(bounds.x);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
			}
			await expect
				.poll(() =>
					options.evaluateAll((buttons) =>
						buttons.every(
							(button) => button.scrollWidth <= button.clientWidth + 1,
						),
					),
				)
				.toBe(true);
		},
	},
	{
		name: "choose individual Cursor parameter values",
		match: /^I choose Cursor values (.+) in the picker$/,
		run: async ({ world, match }) => {
			for (const [kind, value] of Object.entries(
				rowValues(match[1] ?? "", ", "),
			)) {
				const option = world.page.getByTestId(`picker-${kind}-option-${value}`);
				await expect(option).toBeEnabled();
				await option.click();
				await expect(option).toHaveAttribute("aria-checked", "true");
			}
		},
	},
	{
		name: "assert stored Cursor row selections",
		match: /^the Cursor rows show (.+)$/,
		run: async ({ world, match }) => {
			for (const [kind, value] of Object.entries(
				rowValues(match[1] ?? "", ", "),
			))
				await expect(
					world.page.getByTestId(`picker-${kind}-option-${value}`),
				).toHaveAttribute("aria-checked", "true");
		},
	},
	{
		name: "assert unavailable Cursor combination",
		match: /^the Cursor (fast|context) option (\S+) is (disabled|enabled)$/,
		run: async ({ world, match }) => {
			const option = world.page.getByTestId(
				`picker-${match[1]}-option-${match[2]}`,
			);
			if (match[3] === "disabled") await expect(option).toBeDisabled();
			else await expect(option).toBeEnabled();
		},
	},
	{
		name: "assert Cursor composer words",
		match: /^the Cursor composer words show context (.+) and effort (.+)$/,
		run: async ({ world, match }) => {
			// A phone shows the words as one summary that opens the Composer sheet.
			const summary = world.page.getByTestId("composer-words-sheet-trigger");
			if (await summary.count()) {
				for (const word of [match[1], match[2]])
					if (word && word !== "absent")
						await expect(summary).toContainText(word);
				return;
			}
			const context = world.page.getByTestId("composer-word-context");
			if (match[1] === "absent") await expect(context).toHaveCount(0);
			else await expect(context).toHaveText(match[1] ?? "");
			await expect(world.page.getByTestId("composer-word-effort")).toHaveText(
				match[2] ?? "",
			);
		},
	},
	{
		name: "assert Cursor stored combination key",
		match: /^the Cursor composer stores combination (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(
					/^(composer-word-model|composer-words-sheet-trigger)$/,
				),
			).toHaveAttribute("data-shown-effort", match[1] ?? "");
		},
	},
	{
		name: "assert Cursor creation parameters",
		match:
			/^the Cursor session is created with model (\S+) and parameters (.+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "CreateSession",
			);
			expect(request.payload["instanceId"]).toBe("cursor-work");
			expect(request.payload["model"]).toMatchObject({
				providerId: "cursor",
				modelId: match[1],
				variant: match[2],
			});
		},
	},
	{
		name: "assert Cursor next-turn parameter switch",
		match: /^the Cursor parameter switch to (.+) is sent for the same session$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SwitchVariant" &&
					request.payload["sessionId"] === sessionId &&
					request.payload["variant"] === match[1],
			);
		},
	},
	{
		name: "assert second Cursor turn stays in session",
		match: /^the same Cursor session receives its second turn$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			await expect
				.poll(
					() =>
						rpc
							.getRequests()
							.filter((request) => request.tag === "input.submit").length,
				)
				.toBe(2);
			expect(
				rpc.getRequests().filter((request) => request.tag === "CreateSession"),
			).toHaveLength(1);
			const submissions = rpc
				.getRequests()
				.filter((request) => request.tag === "input.submit");
			expect(
				submissions.map((request) => request.payload["sessionId"]),
			).toEqual([sessionId, sessionId]);
			expect(submissions[1]?.payload["text"]).toBe("Next Cursor turn");
		},
	},
	{
		name: "assert parameter catalogue preserves other accounts",
		match: /^no project-loading error toast is shown$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByRole("status")
					.filter({ hasText: "Failed to load projects" }),
			).toHaveCount(0);
		},
	},
];
