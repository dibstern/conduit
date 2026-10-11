import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const card = (page: Page, id: string) =>
	page.getByTestId(`picker-account-${id}`);
const beforeCardTap = new WeakMap<Page, number>();

export const composerAccountsHandlers: StepHandler[] = [
	{
		name: "assert account or instance card layout",
		match:
			/^the (Account|Instance) section has (\d+) (equal-width|scroll-snap) cards and the caption (.+)$/,
		run: async ({ world, match }) => {
			const section = world.page.getByTestId("picker-account-section");
			const row = world.page.getByTestId("picker-account-options");
			await expect(section).toHaveAttribute("aria-label", match[1] ?? "");
			await expect(
				section.getByTestId("picker-account-section-caption"),
			).toHaveText(match[4] ?? "");
			await expect(row.getByRole("radio")).toHaveCount(Number(match[2]));
			const scrolling = match[3] === "scroll-snap";
			await expect(row).toHaveAttribute(
				"data-layout",
				scrolling ? "scroll" : "segmented",
			);
			await expect(row).toHaveCSS("display", scrolling ? "flex" : "grid");
			await expect(row).toHaveCSS("gap", "6px");
			if (scrolling) {
				await expect(row).toHaveCSS("scroll-snap-type", "x mandatory");
				await expect(row).toHaveCSS("scrollbar-width", "none");
				expect(
					await row.evaluate(
						(element) => element.scrollWidth > element.clientWidth,
					),
				).toBe(true);
			}
			const widths = await row
				.getByRole("radio")
				.evaluateAll((items) =>
					items.map((item) => item.getBoundingClientRect().width),
				);
			expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
			for (const radio of await row.getByRole("radio").all()) {
				if (scrolling) {
					await expect(radio).toHaveCSS("width", "108px");
					await expect(radio).toHaveCSS("scroll-snap-align", "start");
				}
				const face = radio.locator(".picker-account-card");
				await expect(face).toHaveCSS("border-width", "1px");
				await expect(face).toHaveCSS("border-radius", "9px");
				await expect(face).toHaveCSS("padding", "7px 9px");
				await expect(face).toHaveCSS("gap", "6px");
				await expect(face).toHaveCSS("font-size", "11.5px");
			}
		},
	},
	{
		name: "assert card name and account identity dot",
		match: /^the picker card (\S+) is named (.+) and shows its AccountDot$/,
		run: async ({ world, match }) => {
			const radio = card(world.page, match[1] ?? "");
			await expect(radio).toHaveAttribute("aria-label", match[2] ?? "");
			await expect(radio.getByTestId("picker-account-name")).toHaveText(
				match[2] ?? "",
			);
			await expect(radio.getByTestId("picker-account-name")).toHaveCSS(
				"text-overflow",
				"ellipsis",
			);
			await expect(radio.getByTestId("account-dot")).toHaveAttribute(
				"data-account",
				match[1] ?? "",
			);
			await expect(radio.getByTestId("account-dot")).toBeVisible();
		},
	},
	{
		name: "select or try a disabled picker card",
		match: /^I (select|try to pick) the (\S+) (Account|Instance) card$/,
		run: async ({ world, match }) => {
			beforeCardTap.set(
				world.page,
				requireRpcControl(world.page).getRequests().length,
			);
			await card(world.page, match[2] ?? "").click({
				force: match[1] === "try to pick",
			});
		},
	},
	{
		name: "assert inert card interaction",
		match: /^the card tap sends no binding or handoff RPC$/,
		run: async ({ world }) => {
			const start = beforeCardTap.get(world.page);
			if (start === undefined) throw new Error("No card tap was recorded");
			const requests = requireRpcControl(world.page).getRequests().slice(start);
			expect(
				requests.filter((request) =>
					[
						"SetProjectInstance",
						"PreviewContinuation",
						"ContinueSession",
					].includes(request.tag),
				),
			).toEqual([]);
			await expect(world.page.getByTestId("handoff-dialog")).toHaveCount(0);
		},
	},
	{
		name: "assert picker closed before the account handoff",
		match: /^the model picker is closed before the handoff dialog$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("model-picker")).toHaveCount(0);
			const dialog = world.page.getByTestId("handoff-dialog");
			await expect(dialog).toHaveCount(1);
			await expect(dialog).toBeVisible();
			const start = beforeCardTap.get(world.page);
			if (start === undefined) throw new Error("No card tap was recorded");
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.slice(start)
					.filter((request) =>
						["PreviewContinuation", "ContinueSession"].includes(request.tag),
					)
					.map((request) => request.tag),
			).toEqual(["PreviewContinuation"]);
		},
	},
	{
		name: "cancel picker account handoff",
		match: /^I cancel the account handoff$/,
		run: async ({ world }) => {
			await world.page.getByTestId("handoff-cancel").click();
		},
	},
	{
		name: "assert cancellation sends no account switch",
		match: /^no account switch RPC was sent$/,
		run: ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "ContinueSession"),
			).toEqual([]);
		},
	},
	{
		name: "assert account handoff note styling",
		match:
			/^the picker account handoff note is a muted footer under the cards$/,
		run: async ({ world }) => {
			const section = world.page.getByTestId("picker-account-section");
			const note = section.getByTestId("picker-account-note");
			await expect(note).toHaveText(
				"You'll see what carries over before anything changes.",
			);
			await expect(note).toHaveCSS("font-size", "10.5px");
			await expect(note).toHaveCSS("border-top-width", "1px");
			await expect(note).toHaveCSS("margin-top", "8px");
			await expect(note).toHaveCSS("padding", "6px 0px 0px");
			await expect(note).toHaveCSS(
				"color",
				await world.page
					.getByTestId("picker-row-model")
					.locator("span")
					.first()
					.evaluate((element) => getComputedStyle(element).color),
			);
			const cards = await section
				.getByTestId("picker-account-options")
				.boundingBox();
			const box = await note.boundingBox();
			if (!cards || !box)
				throw new Error("No account cards or handoff note box");
			expect(Math.abs(box.x - cards.x)).toBeLessThanOrEqual(1);
			expect(box.y).toBeGreaterThanOrEqual(cards.y + cards.height);
		},
	},
	{
		name: "assert account handoff note hidden",
		match: /^the picker has no account handoff note$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("picker-account-note")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "assert card selection and visibility",
		match:
			/^the (\S+) (Account|Instance) card is (selected and in view|outside the visible row)$/,
		run: async ({ world, match }) => {
			const radio = card(world.page, match[1] ?? "");
			await expect(radio).toHaveAttribute("aria-checked", "true");
			await expect
				.poll(() =>
					radio
						.evaluate((element) => {
							const row = element.closest(
								'[data-testid="picker-account-options"]',
							);
							if (!row) return false;
							const bounds = row.getBoundingClientRect();
							const item = element.getBoundingClientRect();
							return {
								inside:
									item.left >= bounds.left - 1 &&
									item.right <= bounds.right + 1,
								outside: item.left >= bounds.right || item.right <= bounds.left,
							};
						})
						.then(
							(position) =>
								position &&
								(match[3] === "selected and in view"
									? position.inside
									: position.outside),
						),
				)
				.toBe(true);
			const face = radio.locator(".picker-account-card");
			const colour = await radio
				.getByTestId("account-dot")
				.evaluate((element) => getComputedStyle(element).backgroundColor);
			await expect(face).toHaveCSS("border-color", colour);
			expect(
				await face.evaluate(
					(element) => getComputedStyle(element).backgroundColor,
				),
			).toMatch(/(?:\/ 0\.1\)|, 0\.1\))$/);
		},
	},
	{
		name: "assert known card usage and account-coloured meter",
		match: /^the (\S+) Account card shows (\d+)% usage$/,
		run: async ({ world, match }) => {
			const radio = card(world.page, match[1] ?? "");
			await expect(radio.getByTestId("picker-account-usage")).toHaveText(
				`${match[2]}%`,
			);
			await expect(radio.getByTestId("picker-account-usage")).toHaveCSS(
				"font-size",
				"10px",
			);
			const meter = radio.getByTestId("picker-account-meter");
			await expect(meter).toHaveCSS("height", "4px");
			await expect(meter).toHaveCSS("border-radius", "2px");
			const ratio = await meter.evaluate((element) => {
				const fill = element.firstElementChild;
				if (!fill) throw new Error("Missing usage meter fill");
				return (
					(fill.getBoundingClientRect().width /
						element.getBoundingClientRect().width) *
					100
				);
			});
			expect(Math.abs(ratio - Number(match[2]))).toBeLessThan(1);
			await expect(meter.locator("span")).toHaveCSS(
				"background-color",
				await radio
					.getByTestId("account-dot")
					.evaluate((element) => getComputedStyle(element).backgroundColor),
			);
		},
	},
	{
		name: "assert unknown card usage",
		match: /^the (\S+) Account card shows unknown usage$/,
		run: async ({ world, match }) => {
			const radio = card(world.page, match[1] ?? "");
			await expect(radio.getByTestId("picker-account-usage")).toHaveText("—");
			await expect(radio.getByTestId("picker-account-caption")).toHaveText(
				"usage unknown",
			);
			await expect(radio.getByTestId("picker-account-meter")).toHaveCount(0);
			await expect(radio).toBeEnabled();
		},
	},
	{
		name: "assert limited card state and reset time",
		match: /^the (\S+) Account card is limited until (\S+)$/,
		run: async ({ world, match }) => {
			const radio = card(world.page, match[1] ?? "");
			const time = await world.page.evaluate(
				(at) =>
					new Date(at).toLocaleTimeString("en-GB", {
						hour: "numeric",
						minute: "2-digit",
						hour12: true,
					}),
				match[2] ?? "",
			);
			await expect(radio).toBeDisabled();
			await expect(radio).toHaveAttribute("aria-disabled", "true");
			await expect(radio.locator(".picker-account-card")).toHaveCSS(
				"opacity",
				"0.6",
			);
			await expect(radio.getByTestId("picker-account-caption")).toHaveText(
				`limit · resets ${time}`,
			);
			await expect(radio.getByTestId("picker-account-caption")).toHaveCSS(
				"font-size",
				"10px",
			);
			await expect(radio.getByTestId("picker-account-usage")).toHaveCount(0);
			await expect(radio.getByTestId("picker-account-meter")).toHaveCount(0);
		},
	},
	{
		name: "assert current Claude card disabled",
		match: /^the (\S+) Account card is disabled$/,
		run: async ({ world, match }) => {
			await expect(card(world.page, match[1] ?? "")).toBeDisabled();
			await expect(card(world.page, match[1] ?? "")).toHaveAttribute(
				"aria-disabled",
				"true",
			);
		},
	},
	{
		name: "assert OpenCode card status without a usage meter",
		match:
			/^the (\S+) Instance card shows (healthy|starting|unhealthy|stopped) status$/,
		run: async ({ world, match }) => {
			const radio = card(world.page, match[1] ?? "");
			await expect(radio.getByTestId("picker-account-caption")).toHaveText(
				match[2] ?? "",
			);
			const colours = {
				healthy: "bg-green-500",
				starting: "bg-yellow-500",
				unhealthy: "bg-red-500",
				stopped: "bg-zinc-500",
			} as const;
			const status = match[2] as keyof typeof colours;
			const dot = radio.getByTestId("picker-instance-status-dot");
			await expect(dot).toBeVisible();
			await expect(dot).toHaveClass(new RegExp(colours[status]));
			expect(
				await dot.evaluate(
					(element) => getComputedStyle(element).backgroundColor,
				),
			).not.toBe("rgba(0, 0, 0, 0)");
			await expect(radio.getByTestId("picker-account-usage")).toHaveCount(0);
			await expect(radio.getByTestId("picker-account-meter")).toHaveCount(0);
		},
	},
	{
		name: "assert OpenCode instance cards locked",
		match:
			/^the Instance cards are locked and announce Harness is fixed for this session$/,
		run: async ({ world }) => {
			for (const radio of await world.page
				.getByTestId("picker-account-options")
				.getByRole("radio")
				.all()) {
				await expect(radio).toBeDisabled();
				await expect(radio).toHaveAttribute("aria-disabled", "true");
				await expect(radio).toHaveAccessibleDescription(
					"Harness is fixed for this session",
				);
			}
		},
	},
	{
		name: "scroll account cards",
		match: /^I scroll the Account row to the (start|end)$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("picker-account-options");
			await row.evaluate(
				(element, edge) =>
					element.scrollTo({
						left: edge === "end" ? element.scrollWidth : 0,
						behavior: "instant",
					}),
				match[1],
			);
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
		name: "assert account overflow fade",
		match: /^the Account row has (a|no) right-edge fade$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("picker-account-options");
			await expect(row).toHaveAttribute(
				"data-fade",
				match[1] === "a" ? "true" : "false",
			);
			const mask = await row.evaluate(
				(element) => getComputedStyle(element).maskImage,
			);
			if (match[1] === "a") {
				expect(mask).toContain("linear-gradient");
				expect(mask).toContain("28px");
			} else expect(mask).toBe("none");
		},
	},
	{
		name: "move between account cards with arrow keys",
		match: /^I move to the (next|previous) Account card with the keyboard$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("picker-account-options")
				.getByRole("radio", { checked: true })
				.focus();
			await world.page.keyboard.press(
				match[1] === "next" ? "ArrowRight" : "ArrowLeft",
			);
		},
	},
	{
		name: "assert quotas refreshed on every picker open",
		match: /^the picker has refreshed account quotas (\d+) times$/,
		run: async ({ world, match }) => {
			await expect
				.poll(
					() =>
						requireRpcControl(world.page)
							.getRequests()
							.filter(
								(request) =>
									request.tag === "QuotaForAccounts" &&
									request.payload["projectSlug"] === "myapp",
							).length,
				)
				.toBe(Number(match[1]));
		},
	},
	{
		name: "assert single account or instance section hidden",
		match: /^the picker has no Account or Instance section$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("picker-account-section"),
			).toHaveCount(0);
			await expect(
				world.page.getByTestId("picker-account-options"),
			).toHaveCount(0);
			await expect(world.page.getByTestId("picker-row-model")).toBeVisible();
		},
	},
];
