import { expect, type Page } from "@playwright/test";
import { surfacingSettingsFixture } from "../../../test/e2e/fixtures/surfacing-settings.js";
import { closeSettings } from "../../../test/e2e/helpers/settings.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const fixtures = new WeakMap<
	Page,
	ReturnType<typeof surfacingSettingsFixture>
>();
function fixture(page: Page) {
	const result = fixtures.get(page);
	if (!result) throw new Error("Surfacing fixture was not seeded");
	return result;
}
const bar = (page: Page) => page.getByTestId("surfacing-draft-bar");
const row = (page: Page, id: string) =>
	page.getByTestId(`surfacing-category-row-${id}`);
async function rowAction(
	page: Page,
	id: string,
	action: string,
): Promise<void> {
	await row(page, id).hover();
	await row(page, id)
		.getByRole("button", { name: action, exact: true })
		.click();
}
async function save(page: Page): Promise<void> {
	await bar(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(bar(page)).toBeHidden();
}

async function reloadCategories(page: Page): Promise<void> {
	await page.reload();
	await expect(page.locator("#connect-overlay")).toBeHidden();
	await page.evaluate(() =>
		window.dispatchEvent(
			new CustomEvent("settings:open", { detail: { section: "surfacing" } }),
		),
	);
	await expect(page.getByTestId("surfacing-key-state")).toBeVisible();
	await page.getByTestId("surfacing-tab-categories").click();
	await expect(row(page, "finding")).toBeVisible();
}

async function choose(
	page: Page,
	label: string,
	option: string,
): Promise<void> {
	const radio = page.getByRole("radiogroup", { name: label, exact: true });
	if (await radio.count())
		await radio.getByRole("radio", { name: option, exact: true }).click();
	else {
		await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
		await page
			.getByRole("menuitemradio", { name: option, exact: true })
			.click();
	}
	await expect(
		page.getByRole("switch", { name: "Turn summaries", exact: true }),
	).toBeEnabled();
}

export const settingsSurfacingHandlers: StepHandler[] = [
	{
		name: "persist all Turns open choices from General",
		match: /^Turns open defaults to Auto and saves all three choices$/,
		run: async ({ world }) => {
			const page = world.page;
			expect(fixture(page).settings.turnsOpen).toBe("auto");
			for (const [label, value] of [
				["Expanded", "expanded"],
				["Minimised", "minimised"],
				["Auto", "auto"],
			] as const) {
				await choose(page, "Turns open", label);
				await expect.poll(() => fixture(page).settings.turnsOpen).toBe(value);
			}
			await page.reload();
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", {
						detail: { section: "surfacing" },
					}),
				),
			);
			await expect(page.getByTestId("surfacing-key-state")).toBeVisible();
			const radio = page.getByRole("radiogroup", {
				name: "Turns open",
				exact: true,
			});
			if (await radio.count())
				await expect(
					radio.getByRole("radio", { name: "Auto", exact: true }),
				).toHaveAttribute("aria-checked", "true");
			else
				await expect(
					page.getByRole("button", { name: /^Turns open: Auto/ }),
				).toBeVisible();
		},
	},
	{
		name: "seed Surfacing settings and category RPCs",
		match:
			/^Surfacing has a (none|valid|invalid|env|invalid-env) key in the (dark|light) theme$/,
		run: async ({ world, match }) => {
			const state = match[1] ?? "none";
			const seeded = surfacingSettingsFixture({
				source:
					state === "none"
						? "none"
						: state === "env" || state === "invalid-env"
							? "env"
							: "stored",
				rejected: state === "invalid" || state === "invalid-env",
			});
			fixtures.set(world.page, seeded);
			requireRpcControl(world.page).setStubs(seeded.stubs);
			await world.page.evaluate(
				(theme) => localStorage.setItem("conduit-theme", theme),
				match[2] ?? "dark",
			);
			await world.page.reload();
			await expect(world.page.locator("#connect-overlay")).toBeHidden();
		},
	},
	{
		name: "open Surfacing settings",
		match: /^I open settings to Surfacing$/,
		run: async ({ world }) => {
			await world.page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", {
						detail: { section: "surfacing" },
					}),
				),
			);
			await expect(world.page.getByTestId("surfacing-key-state")).toBeVisible();
		},
	},
	{
		name: "assert write-only key state",
		match:
			/^Surfacing shows the (none|valid|invalid|env|invalid-env) key state without a saved secret$/,
		run: async ({ world, match }) => {
			const labels: Record<string, string> = {
				none: "Not set",
				valid: "Valid",
				invalid: "Rejected by TypeSafe",
				env: "Set by TYPESAFE_API_KEY",
				"invalid-env": "Rejected by TypeSafe",
			};
			const key = fixture(world.page).settings.key;
			await expect(world.page.getByTestId("surfacing-key-state")).toHaveText(
				labels[match[1] ?? "none"] ?? "",
			);
			const field = world.page.getByTestId("surfacing-key-input");
			const remove = world.page.getByTestId("surfacing-key-remove");
			const replace = world.page.getByTestId("surfacing-key-replace");
			if (key.source === "env") {
				await expect(
					world.page.getByText("Set by TYPESAFE_API_KEY", { exact: true }),
				).toBeVisible();
				await expect(field).toHaveCount(0);
				await expect(remove).toHaveCount(0);
				await expect(replace).toHaveCount(0);
				expect(
					requireRpcControl(world.page)
						.getRequests()
						.some((request) => request.tag === "UpdateMessageSurfacing"),
				).toBe(false);
			} else if (key.source === "none") {
				await expect(field).toHaveAttribute("type", "password");
				await expect(field).toHaveValue("");
				await expect(remove).toHaveCount(0);
				await expect(replace).toHaveCount(0);
			} else {
				// A stored key shows only its mask until Replace opens an empty field.
				await expect(field).toHaveCount(0);
				await expect(remove).toHaveCount(1);
				await expect(replace).toHaveCount(1);
			}
		},
	},
	{
		name: "assert opt-in default and disclosure",
		match: /^Surfacing is off with its disclosure visible$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByRole("switch", {
					name: "Jev categorisation & escalation",
				}),
			).toHaveAttribute("aria-checked", "false");
			await expect(
				world.page.getByTestId("surfacing-disclosure"),
			).toContainText(
				"your request (first 1,000 characters) and your category definitions to TypeSafe",
			);
			await expect(
				world.page.getByTestId("surfacing-disclosure"),
			).toBeVisible();
		},
	},
	{
		name: "assert Jev key requirement",
		match: /^Jev availability matches the (none|valid|invalid|env) key state$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const toggle = page.getByRole("switch", {
				name: "Jev categorisation & escalation",
				exact: true,
			});
			if (match[1] === "none") {
				await expect(toggle).toBeDisabled();
				await expect(page.getByTestId("surfacing-add-key")).toHaveText(
					"Add key",
				);
				await expect(page.getByTestId("surfacing-add-key")).toBeVisible();
			} else await expect(toggle).toBeEnabled();
			const summaries = page.getByRole("switch", {
				name: "Turn summaries",
				exact: true,
			});
			await expect(summaries).toBeEnabled();
			await expect(summaries).toHaveAttribute("aria-checked", "true");
		},
	},
	{
		name: "enable and change default level",
		match: /^I save a key if needed and enable Jev with Key as the default$/,
		run: async ({ world }) => {
			if (fixture(world.page).settings.key.source === "none") {
				await world.page
					.getByTestId("surfacing-key-input")
					.fill("acceptance-only-fixture-key");
				await world.page.getByTestId("surfacing-key-save").click();
				await expect(world.page.getByTestId("surfacing-key-state")).toHaveText(
					"Valid",
				);
			}
			const toggle = world.page.getByRole("switch", {
				name: "Jev categorisation & escalation",
			});
			await expect(toggle).toBeEnabled();
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-checked", "true");
			await expect(toggle).toBeEnabled();
			const radio = world.page.getByRole("radiogroup", {
				name: "Default level",
			});
			if (await radio.count())
				await radio.getByRole("radio", { name: "Key", exact: true }).click();
			else {
				await world.page
					.getByRole("button", { name: /^Default level:/ })
					.click();
				await world.page
					.getByRole("menuitemradio", { name: "Key", exact: true })
					.click();
			}
		},
	},
	{
		name: "assert persisted preferences",
		match:
			/^Surfacing preferences are saved through the daemon from the (none|valid|invalid|env) key state$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => fixture(world.page).settings.defaultLevel)
				.toBe("key");
			expect(fixture(world.page).settings.enabled).toBe(true);
			const requests = requireRpcControl(world.page)
				.getRequests()
				.filter((request) => request.tag === "UpdateMessageSurfacing")
				.map((request) => request.payload);
			expect(requests).toEqual([
				...(match[1] === "none"
					? [
							{
								_tag: "UpdateMessageSurfacing",
								apiKey: "acceptance-only-fixture-key",
							},
						]
					: []),
				{ _tag: "UpdateMessageSurfacing", enabled: true },
				{ _tag: "UpdateMessageSurfacing", defaultLevel: "key" },
			]);
		},
	},
	{
		name: "save summary and tuning preferences while off",
		match: /^summary model timing and tuning persist while Surfacing is off$/,
		run: async ({ world }) => {
			const page = world.page;
			const toggle = page.getByRole("switch", {
				name: "Jev categorisation & escalation",
			});
			await expect(toggle).toBeEnabled();
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-checked", "false");
			await expect(toggle).toBeEnabled();
			await choose(page, "Summary model", "Opus");
			await choose(page, "Summary timing", "On request");
			await choose(page, "Tuning model", "Sonnet (newest)");
			await expect
				.poll(() => fixture(page).settings.recap)
				.toEqual({ model: "opus", when: "on-request" });
			expect(fixture(page).settings).toMatchObject({
				enabled: false,
				active: false,
				tuningModel: "sonnet",
			});
		},
	},
	{
		name: "exercise secret entry rejection and removal",
		match: /^I can save and remove a TypeSafe key without showing it back$/,
		run: async ({ world }) => {
			const page = world.page;
			const field = page.getByTestId("surfacing-key-input");
			// A stored key hides the field until Replace; a rejected entry keeps it open.
			for (const [key, state, rejected] of [
				["rejected-fixture-key", "Not set", true],
				["acceptance-only-fixture-key", "Valid", false],
				["rejected-fixture-key", "Valid", true],
			] as const) {
				if (state === "Valid" && rejected)
					await page.getByTestId("surfacing-key-replace").click();
				await field.fill(key);
				await page.getByTestId("surfacing-key-save").click();
				if (rejected) {
					await expect(page.getByRole("alert")).toHaveText(
						"Rejected by TypeSafe. Your saved key is unchanged.",
					);
					await expect(field).toHaveValue("");
				} else await expect(field).toHaveCount(0);
				await expect(page.getByTestId("surfacing-key-state")).toHaveText(state);
				await expect(page.locator("#settings-panel")).not.toContainText(key);
			}
			await world.page.getByTestId("surfacing-key-remove").click();
			await expect(world.page.getByTestId("surfacing-key-state")).toHaveText(
				"Not set",
			);
		},
	},
	{
		name: "open category draft",
		match: /^I open Surfacing Categories$/,
		run: async ({ world }) => {
			await world.page.getByTestId("surfacing-tab-categories").click();
			await expect(row(world.page, "finding")).toBeVisible();
		},
	},
	{
		name: "assert category edits are local",
		match: /^category changes stay in a draft until Save$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Raise Finding weight" })
				.click();
			await expect(
				world.page.getByRole("spinbutton", {
					name: "Finding weight",
					exact: true,
				}),
			).toHaveValue("45");
			expect(fixture(world.page).categories.version).toBe(1);
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.some((r) => r.tag === "ReplaceCategorySet"),
			).toBe(false);
			await expect(bar(world.page)).toBeVisible();
			await expect(
				world.page.getByTestId("surfacing-category-preview"),
			).toContainText("No judged messages yet");
		},
	},
	{
		name: "exercise category discard save retire restore reset",
		match: /^I can discard save retire restore and reset a built-in category$/,
		run: async ({ world }) => {
			const page = world.page;
			await bar(page).getByRole("button", { name: "Discard" }).click();
			await expect(
				page.getByRole("spinbutton", { name: "Finding weight", exact: true }),
			).toHaveValue("40");
			await page.getByRole("button", { name: "Raise Finding weight" }).click();
			await save(page);
			expect(
				fixture(page).categories.categories.find((c) => c.id === "finding")
					?.weight,
			).toBe(45);
			await rowAction(page, "finding", "Edit Finding definition");
			await page
				.getByRole("textbox", { name: "Surface when" })
				.fill("reports a measured finding");
			await page
				.getByRole("textbox", { name: "Not for" })
				.fill("unmeasured guesses");
			await page
				.getByRole("textbox", { name: "Examples, one per line" })
				.fill("Latency fell by 20%.\nThe trace identifies the cause.");
			await page.getByTestId("surfacing-category-apply").click();
			await save(page);
			await reloadCategories(page);
			expect(
				fixture(page).categories.categories.find((c) => c.id === "finding"),
			).toMatchObject({
				weight: 45,
				criteria: {
					what: "reports a measured finding",
					not_for: "unmeasured guesses",
					examples: ["Latency fell by 20%.", "The trace identifies the cause."],
				},
			});
			await expect(row(page, "finding")).toContainText(
				"reports a measured finding",
			);
			await rowAction(page, "finding", "Edit Finding definition");
			await expect(page.getByRole("textbox", { name: "Not for" })).toHaveValue(
				"unmeasured guesses",
			);
			await expect(
				page.getByRole("textbox", { name: "Examples, one per line" }),
			).toHaveValue("Latency fell by 20%.\nThe trace identifies the cause.");
			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			await rowAction(page, "finding", "Retire");
			await expect(
				page
					.locator("#surfacing-retired-categories")
					.getByTestId("surfacing-category-row-finding"),
			).toBeVisible();
			await rowAction(page, "finding", "Restore");
			await rowAction(page, "finding", "Reset Finding");
			await expect(
				page.getByRole("spinbutton", { name: "Finding weight", exact: true }),
			).toHaveValue("40");
			await save(page);
			await reloadCategories(page);
			expect(
				fixture(page).categories.categories.find((c) => c.id === "finding")
					?.criteria.what,
			).toBe("establishes a new fact or root cause");
		},
	},
	{
		name: "exercise custom editor and validation",
		match: /^I can validate add edit and delete a custom category$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.getByTestId("surfacing-category-add").click();
			await page
				.getByRole("textbox", { name: "Label", exact: true })
				.fill("A".repeat(25));
			await page
				.getByRole("textbox", { name: "Glyph", exact: true })
				.fill("⚡⚡");
			await page
				.getByRole("textbox", { name: "Colour", exact: true })
				.fill("red");
			await expect(
				page.getByText("Label must be 1–24 characters."),
			).toBeVisible();
			await expect(
				page.getByText("Glyph must be one character."),
			).toBeVisible();
			await expect(
				page.getByText("Use a hex colour such as #2a9fd6."),
			).toBeVisible();
			await expect(page.getByTestId("surfacing-category-apply")).toBeDisabled();
			await page
				.getByRole("textbox", { name: "Label", exact: true })
				.fill("Perf");
			await page
				.getByRole("textbox", { name: "Glyph", exact: true })
				.fill("👨‍👩‍👧‍👦");
			await page
				.getByRole("textbox", { name: "Colour", exact: true })
				.fill("#2a9fd6");
			await page
				.getByRole("spinbutton", { name: "Weight", exact: true })
				.fill("101");
			await expect(page.getByTestId("surfacing-category-apply")).toBeDisabled();
			await page
				.getByRole("spinbutton", { name: "Weight", exact: true })
				.fill("55");
			await page
				.getByRole("textbox", { name: "Surface when", exact: true })
				.fill("reports measured performance changes");
			await page.getByTestId("surfacing-category-apply").click();
			await expect(row(page, "perf")).toBeVisible();
			await rowAction(page, "perf", "Edit Perf");
			await expect(page.getByTestId("surfacing-category-apply")).toBeEnabled();
			for (const label of ["Ask", "Routine"]) {
				await page
					.getByRole("textbox", { name: "Label", exact: true })
					.fill(label);
				await expect(
					page.getByTestId("surfacing-category-apply"),
				).toBeDisabled();
				await expect(
					page.getByText("That category already exists or is reserved."),
				).toBeVisible();
			}
			await page
				.getByRole("textbox", { name: "Label", exact: true })
				.fill("Performance");
			await page.getByTestId("surfacing-category-apply").click();
			await expect(row(page, "perf")).toHaveCount(0);
			await expect(row(page, "performance")).toContainText("Performance");
			await save(page);
			await reloadCategories(page);
			expect(
				fixture(page).categories.categories.find((c) => c.id === "performance"),
			).toMatchObject({ label: "Performance", weight: 55 });
			await rowAction(page, "performance", "Edit Performance");
			await page
				.getByRole("textbox", { name: "Label", exact: true })
				.fill("Measured perf");
			await page.getByRole("textbox", { name: "Glyph", exact: true }).fill("↗");
			await page
				.getByRole("textbox", { name: "Colour", exact: true })
				.fill("#3ecf8e");
			await page
				.getByRole("spinbutton", { name: "Weight", exact: true })
				.fill("65");
			await page
				.getByRole("textbox", { name: "Surface when" })
				.fill("compares measured latency");
			await page
				.getByRole("textbox", { name: "Not for" })
				.fill("estimates without measurements");
			await page
				.getByRole("textbox", { name: "Examples, one per line" })
				.fill("p95 fell to 40ms.\nMemory fell to 20MB.");
			await page.getByTestId("surfacing-category-apply").click();
			await save(page);
			await reloadCategories(page);
			expect(
				fixture(page).categories.categories.find((c) => c.id === "performance"),
			).toMatchObject({
				label: "Measured perf",
				glyph: "↗",
				colour: "#3ecf8e",
				weight: 65,
				criteria: {
					what: "compares measured latency",
					not_for: "estimates without measurements",
					examples: ["p95 fell to 40ms.", "Memory fell to 20MB."],
				},
			});
			await expect(row(page, "performance")).toContainText("Measured perf");
			await expect(
				page.getByRole("spinbutton", {
					name: "Measured perf weight",
					exact: true,
				}),
			).toHaveValue("65");
			await rowAction(page, "performance", "Edit Measured perf");
			await expect(
				page.getByRole("textbox", { name: "Glyph", exact: true }),
			).toHaveValue("↗");
			await expect(
				page.getByRole("textbox", { name: "Colour", exact: true }),
			).toHaveValue("#3ecf8e");
			await expect(
				page.getByRole("textbox", { name: "Surface when" }),
			).toHaveValue("compares measured latency");
			await expect(page.getByRole("textbox", { name: "Not for" })).toHaveValue(
				"estimates without measurements",
			);
			await expect(
				page.getByRole("textbox", { name: "Examples, one per line" }),
			).toHaveValue("p95 fell to 40ms.\nMemory fell to 20MB.");
			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			await rowAction(page, "performance", "Delete");
			await expect(row(page, "performance")).toContainText(
				"Delete ↗ Measured perf?",
			);
			await rowAction(page, "performance", "Cancel");
			await expect(row(page, "performance")).toBeVisible();
			await rowAction(page, "performance", "Delete");
			await rowAction(page, "performance", "Delete");
			await expect(row(page, "performance")).toHaveCount(0);
			await save(page);
			await reloadCategories(page);
			await expect(row(page, "performance")).toHaveCount(0);
			expect(
				fixture(page).categories.categories.some((c) => c.origin === "custom"),
			).toBe(false);
		},
	},
	{
		name: "validate reserved ids and active limits",
		match: /^category limits and conflicting identities are validated$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.getByTestId("surfacing-category-add").click();
			await page
				.getByRole("textbox", { name: "Glyph", exact: true })
				.fill("⚡");
			for (const label of ["Ask", "Routine", "⚡"]) {
				await page
					.getByRole("textbox", { name: "Label", exact: true })
					.fill(label);
				await expect(
					page.getByTestId("surfacing-category-apply"),
				).toBeDisabled();
			}
			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			fixture(page).fillActiveCategories();
			await closeSettings(page);
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", {
						detail: { section: "surfacing" },
					}),
				),
			);
			await page.getByTestId("surfacing-tab-categories").click();
			await expect(
				page.getByRole("heading", { name: "20 of 20 active" }),
			).toBeVisible();
			await expect(page.getByTestId("surfacing-category-add")).toBeDisabled();
			await rowAction(page, "finding", "Retire");
			await expect(page.getByTestId("surfacing-category-add")).toBeEnabled();
			await page.getByTestId("surfacing-category-add").click();
			await page
				.getByRole("textbox", { name: "Label", exact: true })
				.fill("Extra");
			await page.getByRole("textbox", { name: "Glyph", exact: true }).fill("+");
			await page.getByTestId("surfacing-category-apply").click();
			await expect(page.getByTestId("surfacing-category-add")).toBeDisabled();
			await expect(
				row(page, "finding").getByRole("button", { name: "Restore" }),
			).toBeDisabled();
		},
	},
	{
		name: "trigger stale version",
		match: /^categories change elsewhere while I edit$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Raise Finding weight" })
				.click();
			fixture(world.page).changeElsewhere();
			await bar(world.page)
				.getByRole("button", { name: "Save", exact: true })
				.click();
		},
	},
	{
		name: "discard stale draft and save against the current version",
		match:
			/^discarding the stale draft allows saving against the reloaded version$/,
		run: async ({ world }) => {
			const page = world.page;
			await bar(page).getByRole("button", { name: "Discard" }).click();
			await expect(
				page.getByRole("spinbutton", { name: "Finding weight", exact: true }),
			).toHaveValue("75");
			await page.getByRole("button", { name: "Raise Finding weight" }).click();
			await save(page);
			expect(fixture(page).categories.version).toBe(3);
			expect(
				fixture(page).categories.categories.find((c) => c.id === "finding")
					?.weight,
			).toBe(80);
			const saves = requireRpcControl(page)
				.getRequests()
				.filter((request) => request.tag === "ReplaceCategorySet");
			expect(saves.at(-1)?.payload["expectedVersion"]).toBe(2);
		},
	},
	{
		name: "assert stale reload preserves draft",
		match: /^Surfacing reloads the current set and keeps my draft visible$/,
		run: async ({ world }) => {
			const page = world.page;
			await expect(
				page.getByText("Categories changed elsewhere", { exact: true }),
			).toBeVisible();
			await expect(page.getByText(/The server has version 2/)).toBeVisible();
			await expect(
				page.getByRole("spinbutton", { name: "Finding weight", exact: true }),
			).toHaveValue("45");
			await expect(
				bar(page).getByRole("button", { name: "Save", exact: true }),
			).toBeDisabled();
			await expect(
				page.getByTestId("surfacing-category-preview"),
			).toContainText("No judged messages yet");
			// The app shell also loads the category set, so check the order rather than a count.
			const tags = requireRpcControl(page)
				.getRequests()
				.map((r) => r.tag);
			expect(tags.slice(tags.lastIndexOf("ReplaceCategorySet"))).toContain(
				"GetCategorySet",
			);
		},
	},
];
