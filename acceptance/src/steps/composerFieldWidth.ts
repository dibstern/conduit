import type { StepHandler } from "../runtime.js";
import { openSessionRoute, requireRelayControl } from "./shared.js";

export const composerFieldWidthHandlers: StepHandler[] = [
	{
		name: "open composer session",
		match: /^I open a composer session$/,
		run: async ({ world }) => {
			await openSessionRoute(world.page, "sess-mockup-001");
			await world.page.locator("#input").waitFor({ state: "visible" });
		},
	},
	{
		name: "change composer placeholder",
		match: /^the composer placeholder changes to (.+)$/,
		run: async ({ world, match }) => {
			await world.page.locator("#input").evaluate((textarea, placeholder) => {
				textarea.setAttribute("placeholder", placeholder);
			}, match[1] ?? "");
		},
	},
	{
		name: "change composer processing state",
		match: /^the mock relay sets composer status to (idle|processing)$/,
		run: async ({ world, match }) => {
			requireRelayControl(world.page).sendMessage({
				type: "status",
				status: match[1] ?? "idle",
				sessionId: "sess-mockup-001",
			});
			await world.page.locator("#stop").waitFor({
				state: match[1] === "processing" ? "visible" : "hidden",
			});
		},
	},
	{
		name: "assert composer rows",
		match: /^the composer has (1|2) rows?$/,
		run: async ({ world, match }) => {
			await world.page.waitForFunction(
				(rows) =>
					document
						.querySelector('[data-testid="composer-layout"]')
						?.getAttribute("data-rows") === rows,
				match[1],
			);
		},
	},
	{
		name: "assert full width composer field",
		match:
			/^the composer field is at least the composer width minus ([0-9]+) pixels$/,
		run: async ({ world, match }) => {
			await world.page.waitForFunction((allowance) => {
				const composer = document.getElementById("input-row");
				const field = document.getElementById("input");
				return (
					composer &&
					field &&
					field.getBoundingClientRect().width >=
						composer.getBoundingClientRect().width - allowance
				);
			}, Number(match[1]));
		},
	},
	{
		name: "assert placeholder fully visible",
		match: /^the composer placeholder is fully visible$/,
		run: async ({ world }) => {
			await world.page.waitForFunction(() => {
				const textarea = document.getElementById("input");
				return (
					textarea instanceof HTMLTextAreaElement &&
					textarea.value === "" &&
					textarea.placeholder.length > 0 &&
					textarea.scrollWidth <= textarea.clientWidth + 1 &&
					textarea.scrollHeight <= textarea.clientHeight + 1
				);
			});
		},
	},
	{
		name: "assert send and stop visible",
		match: /^send and stop are both visible$/,
		run: async ({ world }) => {
			await world.page.locator("#send").waitFor({ state: "visible" });
			await world.page.locator("#stop").waitFor({ state: "visible" });
		},
	},
];
