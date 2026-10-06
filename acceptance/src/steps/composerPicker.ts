import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import {
	effortOptions,
	openModelPicker,
	requireRelayControl,
	requireRpcControl,
	serveModelCatalog,
} from "./shared.js";

const levels = ["low", "medium", "high", "xhigh", "max"];
const contextOptions = [
	{ value: "200k", label: "200K", isDefault: true },
	{ value: "1m", label: "1M" },
];
const providers = [
	{
		id: "claude",
		name: "Claude",
		configured: true,
		models: [
			{
				id: "claude-sonnet-5",
				name: "Sonnet 5",
				provider: "claude",
				limit: { context: 200_000 },
				contextWindowOptions: contextOptions,
				variants: levels,
			},
			{
				id: "claude-opus-5",
				name: "Opus 5",
				provider: "claude",
				limit: { context: 1_000_000 },
				contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
				variants: levels,
			},
		],
	},
	{
		id: "anthropic",
		name: "OpenCode",
		configured: true,
		models: [
			{
				id: "claude-sonnet-4",
				name: "Sonnet 4",
				provider: "anthropic",
				limit: { context: 200_000 },
				contextWindowOptions: [contextOptions[0]],
			},
		],
	},
];

export async function seedComposerPickerCatalog(
	page: Page,
	harness: "Claude" | "OpenCode",
): Promise<void> {
	const claude = harness === "Claude";
	const options = claude ? contextOptions : contextOptions.slice(0, 1);
	effortOptions.set(page, claude ? levels : []);
	const model = claude ? "claude-sonnet-5" : "claude-sonnet-4";
	const provider = claude ? "claude" : "anthropic";
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	await serveModelCatalog(page, { providers, active: { model, provider } });
	requireRpcControl(page).setProjectSetting({
		_tag: "defaultModel",
		model,
		provider,
		variant: "",
	});
	await requireRelayControl(page).sendMessages([
		// An open session shows its own model, not the default.
		...(sessionId ? [{ type: "model_info", sessionId, model, provider }] : []),
		{ type: "context_window_info", contextWindow: "200k", options },
		{ type: "variant_info", variant: "", variants: claude ? levels : [] },
	]);
	// The phone button shows only a short tag (S5); its accessible name has the full model.
	await expect(
		page.getByTestId(/^(model-picker-trigger|composer-word-model)$/),
	).toHaveAttribute("aria-label", claude ? /Sonnet 5/ : /Sonnet 4/);
}

export const composerPickerHandlers: StepHandler[] = [
	{
		name: "seed composer picker catalog",
		match: /^the composer picker has the (Claude|OpenCode) catalog$/,
		run: async ({ world, match }) => {
			await seedComposerPickerCatalog(
				world.page,
				match[1] === "Claude" ? "Claude" : "OpenCode",
			);
		},
	},
	{
		name: "drill into picker choices",
		match: /^I view (Harness|Model|Agent) choices in the picker$/,
		run: async ({ world, match }) => {
			await openModelPicker(world.page);
			await world.page
				.getByTestId(`picker-row-${(match[1] ?? "").toLowerCase()}`)
				.click();
			await expect(world.page.getByTestId("picker-back")).toBeVisible();
		},
	},
	{
		name: "return to picker root",
		match: /^I go Back in the picker$/,
		run: async ({ world }) => {
			await world.page.getByTestId("picker-back").click();
			await expect(world.page.getByTestId("picker-row-model")).toBeVisible();
		},
	},
	{
		name: "close composer picker",
		match: /^I close the model picker$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
			await expect(world.page.locator("#model-picker")).toHaveCount(0);
		},
	},
	{
		name: "assert picker root rows",
		match: /^the picker root shows (Claude|OpenCode) and (.+)$/,
		run: async ({ world, match }) => {
			const picker = world.page.locator("#model-picker");
			await expect(picker).toBeVisible();
			await expect(picker).toContainText("Harness & model");
			await expect(world.page.getByTestId("picker-row-harness")).toContainText(
				match[1] ?? "",
			);
			await expect(world.page.getByTestId("picker-row-model")).toContainText(
				match[2] ?? "",
			);
			await expect(world.page.getByTestId("picker-back")).toHaveCount(0);
		},
	},
	{
		name: "assert phone bottom sheet geometry",
		match: /^the picker is a phone bottom sheet$/,
		run: async ({ world }) => {
			const viewport = world.page.viewportSize();
			if (!viewport || viewport.width >= 768)
				throw new Error("Phone viewport was not initialised");
			await expect
				.poll(async () => {
					const box = await world.page.locator("#model-picker").boundingBox();
					return (
						box !== null &&
						box.y > 0 &&
						Math.abs(box.y + box.height - viewport.height) <= 2 &&
						Math.abs(box.width - viewport.width) <= 2
					);
				})
				.toBe(true);
		},
	},
	{
		name: "assert desktop popover geometry",
		match: /^the picker is a desktop popover$/,
		run: async ({ world }) => {
			const picker = await world.page.locator("#model-picker").boundingBox();
			const trigger = await world.page
				.getByTestId("model-picker-trigger")
				.boundingBox();
			if (!picker || !trigger) throw new Error("Picker or trigger is missing");
			expect(picker.width).toBeLessThan(768);
			expect(picker.y + picker.height).toBeLessThanOrEqual(trigger.y + 2);
		},
	},
	{
		name: "assert selectable context windows",
		match: /^the picker offers context windows (.+)$/,
		run: async ({ world, match }) => {
			const options = (match[1] ?? "").split(", ");
			const row = world.page.getByTestId("picker-row-context");
			await expect(row.getByRole("radio")).toHaveCount(options.length);
			for (const value of options) {
				await expect(
					world.page.getByTestId(`picker-context-option-${value}`),
				).toHaveAttribute("role", "radio");
			}
		},
	},
	{
		name: "select picker context window",
		match: /^I select context window (\w+) in the picker$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId(`picker-context-option-${match[1]}`).click();
		},
	},
	{
		name: "assert picker selected context persists in composer",
		match:
			/^the picker context (\w+) is selected and the composer reflects (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`picker-context-option-${match[1]}`),
			).toHaveAttribute("aria-checked", "true");
			await expect(
				world.page.getByTestId("model-picker-trigger"),
			).toHaveAttribute("aria-label", new RegExp(match[2] ?? ""));
			await expect(world.page.getByTestId("picker-row-model")).toBeVisible();
		},
	},
	{
		name: "assert static context window",
		match: /^the picker shows a static (.+) context window$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("picker-row-context");
			await expect(row).toContainText(match[1] ?? "");
			await expect(row.getByRole("radio")).toHaveCount(0);
			await expect(row.getByRole("button")).toHaveCount(0);
			await expect(
				world.page.locator('[data-testid^="picker-context-option-"]'),
			).toHaveCount(0);
		},
	},
	{
		name: "assert picker effort options",
		match: /^the picker lists every effort level including xhigh$/,
		run: async ({ world }) => {
			const options = world.page.locator(
				'[data-testid^="picker-effort-option-"]',
			);
			await expect(options).toHaveCount(levels.length);
			for (const level of levels) {
				await expect(
					world.page.getByTestId(`picker-effort-option-${level}`),
				).toHaveAttribute("role", "radio");
			}
		},
	},
	{
		name: "select picker effort",
		match: /^I select effort (\w+) in the picker$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId(`picker-effort-option-${match[1]}`).click();
		},
	},
	{
		name: "assert picker selected effort stays open",
		match: /^the picker effort (\w+) is selected while the root remains open$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`picker-effort-option-${match[1]}`),
			).toHaveAttribute("aria-checked", "true");
			await expect(world.page.getByTestId("picker-row-model")).toBeVisible();
		},
	},
	{
		name: "assert Default leaves picker effort unselected",
		match: /^no effort segment in the picker is selected$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator('[data-testid^="picker-effort-option-"]'),
			).toHaveCount(levels.length);
			await expect(
				world.page.locator(
					'[data-testid^="picker-effort-option-"][aria-checked="true"]',
				),
			).toHaveCount(0);
		},
	},
	{
		name: "assert model context details",
		match: /^the picker model (.+) lists context windows (.+)$/,
		run: async ({ world, match }) => {
			const model = world.page
				.locator("#model-picker .model-item")
				.filter({ hasText: match[1] ?? "" });
			await expect(model).toBeVisible();
			for (const label of (match[2] ?? "").split(", ")) {
				await expect(model).toContainText(label);
			}
		},
	},
	{
		name: "select picker model",
		match: /^I select model (.+) in the picker$/,
		run: async ({ world, match }) => {
			await world.page
				.locator("#model-picker .model-item")
				.filter({ hasText: match[1] ?? "" })
				.click();
		},
	},
];
