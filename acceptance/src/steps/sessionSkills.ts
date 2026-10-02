import { expect } from "@playwright/test";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { mockSessionSkills, requireRpcControl } from "./shared.js";

const LOAD = /^\s*([\w:-]+) by (you|agent) in turn (\d+)\s*$/;
const FIVE_MINUTES = 5 * 60_000;

export const sessionSkillsHandlers: StepHandler[] = [
	{
		name: "seed session skill loads",
		// e.g. "release-notes by you in turn 1; changelog-style by agent in turn 1"
		match: /^the session loaded the skills "(.*)"$/,
		run: async ({ world, match }) => {
			const loads = (match[1] ?? "").split(";").map((entry, index) => {
				const parts = LOAD.exec(entry);
				if (!parts) throw new Error(`unreadable skill load "${entry}"`);
				return {
					name: parts[1],
					invokedBy: parts[2] === "you" ? "user" : "agent",
					turnOrdinal: Number(parts[3]),
					// The browser's Date.now is pinned, so ages are read against that.
					at: PINNED_CLOCK_MS - FIVE_MINUTES,
					anchor: { messageId: `msg-skill-${index}` },
					running: false,
				};
			});
			mockSessionSkills.set(world.page, loads);
		},
	},
	{
		name: "skills chip count",
		match: /^the skills chip reads ([0-9]+) skills? used$/,
		run: async ({ world, match }) => {
			const chip = world.page.getByTestId("session-skills-chip");
			const count = match[1] ?? "";
			await expect(chip).toHaveAccessibleName(
				`${count} ${count === "1" ? "skill" : "skills"} used`,
			);
			await expect(chip).toHaveText(count);
		},
	},
	{
		name: "no skills chip",
		match: /^there is no skills chip$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) => request.tag === "GetSessionSkills",
			);
			await expect(world.page.getByTestId("session-bar")).toBeVisible();
			await expect(world.page.getByTestId("session-skills-chip")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "skills chip touch target",
		match: /^the skills chip has a 44 pixel touch target$/,
		run: async ({ world }) => {
			const target = await world.page
				.getByTestId("session-skills-chip")
				.evaluate((el) => {
					const hit = getComputedStyle(el, "::before");
					const box = el.getBoundingClientRect();
					return {
						height: Math.max(box.height, Number.parseFloat(hit.minHeight) || 0),
						width: Math.max(box.width, Number.parseFloat(hit.minWidth) || 0),
					};
				});
			if (target.height < 44 || target.width < 44)
				throw new Error(
					`skills chip target is ${target.width}x${target.height}`,
				);
		},
	},
	{
		name: "skills chip placement",
		match:
			/^the skills chip sits between (back|the title row) and the identity$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const before =
				match[1] === "back"
					? page.getByTestId("session-bar-back")
					: page.locator("#session-bar-title-row");
			const [left, chip, identity, bar] = await Promise.all([
				before.boundingBox(),
				page.getByTestId("session-skills-chip").boundingBox(),
				page.getByTestId("session-bar-identity").boundingBox(),
				page.getByTestId("session-bar").boundingBox(),
			]);
			if (!left || !chip || !identity || !bar)
				throw new Error("session bar controls are not all rendered");
			const centre = (box: { y: number; height: number }) =>
				box.y + box.height / 2;
			if (Math.abs(centre(chip) - centre(identity)) > 8)
				throw new Error("skills chip is not on the identity's row");
			if (!(left.x + left.width <= chip.x && chip.x + chip.width <= identity.x))
				throw new Error(
					`expected ${match[1]} < chip < identity, got x ${left.x}, ${chip.x}, ${identity.x}`,
				);
			if (chip.x + chip.width / 2 < bar.x + bar.width / 2)
				throw new Error("skills chip is not in the right-hand group");
		},
	},
	{
		name: "open skills chip",
		match: /^I open the skills chip$/,
		run: async ({ world }) => {
			await world.page.getByTestId("session-skills-chip").click();
		},
	},
	{
		name: "skills list presentation",
		match: /^the skills list opens as a (sheet|popover)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByRole("menu", { name: "Skills used" }),
			).toBeVisible();
			await expect(world.page.getByTestId("menu-sheet-scrim")).toHaveCount(
				match[1] === "sheet" ? 1 : 0,
			);
		},
	},
	{
		name: "skills list rows",
		// Rows separated by ";", each "name [×N] (who · turns · age)".
		match: /^the skills list shows "(.*)"$/,
		run: async ({ world, match }) => {
			const rows = world.page.getByTestId("session-skills-row");
			await expect(rows.first()).toBeVisible();
			const actual = await rows.evaluateAll((items) =>
				items.map((item) => {
					const name = item.getAttribute("data-skill") ?? "";
					const meta =
						item.querySelector("[data-testid='session-skills-row-meta']")
							?.textContent ?? "";
					const repeat = item
						.querySelector("[data-testid='session-skills-row-count']")
						?.textContent?.trim();
					return `${name}${repeat ? ` ${repeat}` : ""} (${meta.trim()})`;
				}),
			);
			const expected = (match[1] ?? "").split(";").map((row) => row.trim());
			expect(actual).toEqual(expected);
		},
	},
];
