import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import {
	effortOptions,
	openModelPicker,
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
				contextWindowOptions: contextOptions.slice(0, 1),
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
	requireRpcControl(page).setProjectSetting({
		_tag: "defaultModel",
		model,
		provider,
		variant: "",
	});
	await serveModelCatalog(page, {
		providers,
		active: { model, provider },
		contextWindow: { contextWindow: "200k", options },
		variant: { variant: "", variants: claude ? levels : [] },
	});
	// The phone button shows only a short tag (S5); its accessible name has the full model.
	await expect(
		page.getByTestId(/^(model-picker-trigger|composer-word-model)$/),
	).toHaveAttribute("aria-label", claude ? /Sonnet 5/ : /Sonnet 4/);
}

export const composerPickerHandlers: StepHandler[] = [
	{
		name: "assert shared composer picker is closed",
		match: /^the shared composer picker is closed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("model-picker")).toHaveCount(0);
		},
	},
	{
		name: "assert desktop icons control opens its picker section",
		match: /^the icons control opens the picker at (Harness|Model|Effort)$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId("model-picker");
			await expect(picker).toBeVisible();
			if (match[1] === "Model") {
				await expect(picker.getByTestId("model-picker-list")).toBeVisible();
				await expect(picker.getByTestId("picker-back")).toBeVisible();
				await expect(picker.getByTestId("model-picker-search")).toBeFocused();
			} else {
				await expect(picker.getByTestId("picker-back")).toHaveCount(0);
				await expect(
					match[1] === "Harness"
						? picker.getByTestId("picker-harness-claude")
						: picker.getByTestId("picker-row-effort"),
				).toBeFocused();
			}
		},
	},
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
		name: "view picker choices",
		match:
			/^I view (Harness|Model|Agent|Account|Instance) choices in the picker$/,
		run: async ({ world, match }) => {
			await openModelPicker(world.page);
			if (match[1] === "Harness") {
				await expect(
					world.page.getByTestId("picker-harness-section"),
				).toBeVisible();
				await expect(world.page.getByTestId("picker-back")).toHaveCount(0);
				return;
			}
			if (match[1] === "Account" || match[1] === "Instance") {
				await expect(
					world.page.getByTestId("picker-account-section"),
				).toHaveAttribute("aria-label", match[1]);
				await expect(
					world.page.getByTestId("picker-account-options"),
				).toBeVisible();
				await expect(world.page.getByTestId("picker-back")).toHaveCount(0);
				return;
			}
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
			await expect(
				world.page.getByTestId(
					`picker-harness-${(match[1] ?? "").toLowerCase()}`,
				),
			).toHaveAttribute("aria-checked", "true");
			await expect(world.page.getByTestId("picker-row-model")).toContainText(
				match[2] ?? "",
			);
			await expect(world.page.getByTestId("picker-back")).toHaveCount(0);
		},
	},
	{
		name: "assert segmented Harness layout",
		match: /^the Harness section has (\d+) equal-width segmented tabs$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("picker-harness-options");
			await expect(row).toHaveAttribute("data-layout", "segmented");
			await expect(row).toHaveCSS("display", "grid");
			await expect(row.getByRole("radio")).toHaveCount(Number(match[1]));
			const widths = await row
				.getByRole("radio")
				.evaluateAll((items) =>
					items.map((item) => item.getBoundingClientRect().width),
				);
			expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
			for (const tab of await row.getByRole("radio").all()) {
				await expect(tab).toHaveCSS("height", "32px");
				await expect(tab.getByTestId("harness-logo")).toHaveCSS(
					"width",
					"14px",
				);
			}
		},
	},
	{
		name: "assert scrolling Harness layout",
		match: /^the Harness section has (\d+) scroll-snap tabs$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("picker-harness-options");
			await expect(row).toHaveAttribute("data-layout", "scroll");
			await expect(row).toHaveCSS("scroll-snap-type", "x mandatory");
			await expect(row).toHaveCSS("scrollbar-width", "none");
			await expect(row.getByRole("radio")).toHaveCount(Number(match[1]));
			expect(
				await row.evaluate(
					(element) => element.scrollWidth > element.clientWidth,
				),
			).toBe(true);
			for (const tab of await row.getByRole("radio").all()) {
				await expect(tab).toHaveCSS("width", "104px");
				await expect(tab).toHaveCSS("height", "32px");
				await expect(tab).toHaveCSS("scroll-snap-align", "start");
			}
		},
	},
	{
		name: "assert Harness overflow fade and clipped peek",
		match: /^the Harness row fades and cuts its last visible tab$/,
		run: async ({ world }) => {
			const row = world.page.getByTestId("picker-harness-options");
			await expect(row).toHaveAttribute("data-fade", "true");
			const mask = await row.evaluate(
				(element) => getComputedStyle(element).maskImage,
			);
			expect(mask).toContain("linear-gradient");
			expect(mask).toContain("28px");
			const peek = await row.evaluate((element) => {
				const bounds = element.getBoundingClientRect();
				const visible = Array.from(element.querySelectorAll('[role="radio"]'))
					.map((item) => item.getBoundingClientRect())
					.filter(
						(item) => item.left < bounds.right && item.right > bounds.left,
					);
				const last = visible.at(-1);
				return (
					!!last && last.left < bounds.right - 28 && last.right > bounds.right
				);
			});
			expect(peek).toBe(true);
		},
	},
	{
		name: "scroll Harness options",
		match: /^I scroll the Harness row to the (start|end)$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("picker-harness-options");
			await row.evaluate((element, edge) => {
				element.scrollTo({
					left: edge === "end" ? element.scrollWidth : 0,
					behavior: "instant",
				});
			}, match[1]);
			await expect
				.poll(() =>
					row.evaluate(
						(element, edge) =>
							edge === "end"
								? element.scrollWidth -
										element.clientWidth -
										element.scrollLeft <=
									1
								: element.scrollLeft <= 1,
						match[1],
					),
				)
				.toBe(true);
		},
	},
	{
		name: "assert Harness fade drops at the end",
		match: /^the Harness row has no right-edge fade$/,
		run: async ({ world }) => {
			const row = world.page.getByTestId("picker-harness-options");
			await expect(row).toHaveAttribute("data-fade", "false");
			await expect(row).toHaveCSS("mask-image", "none");
		},
	},
	{
		name: "assert selected Harness tab is outside the visible row",
		match:
			/^the (Claude|OpenCode|Codex|Gemini|Cursor) Harness tab is outside the visible row$/,
		run: async ({ world, match }) => {
			const tab = world.page.getByTestId(
				`picker-harness-${(match[1] ?? "").toLowerCase()}`,
			);
			await expect(tab).toHaveAttribute("aria-checked", "true");
			await expect
				.poll(() =>
					tab.evaluate((element) => {
						const row = element.closest(
							'[data-testid="picker-harness-options"]',
						);
						if (!row) return false;
						const bounds = row.getBoundingClientRect();
						const item = element.getBoundingClientRect();
						return item.left >= bounds.right || item.right <= bounds.left;
					}),
				)
				.toBe(true);
		},
	},
	{
		name: "assert unknown Harness logos render",
		match: /^the Codex, Gemini, Cursor Harness tabs have fallback logos$/,
		run: async ({ world }) => {
			for (const driver of ["codex", "gemini", "cursor"]) {
				const logo = world.page
					.getByTestId(`picker-harness-${driver}`)
					.getByTestId("harness-logo");
				await expect(logo).toHaveAttribute("data-driver", driver);
				await expect(logo.locator("svg")).toBeVisible();
			}
		},
	},
	{
		name: "assert single Harness section hidden",
		match: /^the picker has no Harness section$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("picker-harness-section"),
			).toHaveCount(0);
			await expect(
				world.page.getByTestId("picker-harness-options"),
			).toHaveCount(0);
			await expect(world.page.getByTestId("picker-row-model")).toBeVisible();
		},
	},
	{
		name: "assert Harness drill-in removed",
		match: /^the picker has no Harness drill-in$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("picker-row-harness")).toHaveCount(0);
			await expect(world.page.getByTestId("picker-back")).toHaveCount(0);
		},
	},
	{
		name: "assert picker session subtitle",
		match: /^the picker subtitle is (new session|this session)$/,
		run: async ({ world, match }) => {
			const picker = world.page.locator("#model-picker");
			await expect(
				picker.getByText(match[1] ?? "", { exact: true }),
			).toBeVisible();
			await expect(picker.getByText(match[1] ?? "", { exact: true })).toHaveCSS(
				"font-size",
				"10.5px",
			);
			await expect(
				picker.getByRole("heading", { name: /^Harness & model/ }),
			).toHaveCSS("font-size", "11.5px");
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
			for (const row of ["model", "context", "effort", "agent"]) {
				const box = await world.page
					.getByTestId(`picker-row-${row}`)
					.boundingBox();
				if (!box) throw new Error(`Picker ${row} row is missing`);
				expect(box.height).toBeGreaterThanOrEqual(50);
			}
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
			expect(Math.abs(picker.width - 404)).toBeLessThanOrEqual(1);
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
