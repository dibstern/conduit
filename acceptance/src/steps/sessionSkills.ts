import { expect, type Page } from "@playwright/test";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	mockSessionSkills,
	requireRelayControl,
	requireRpcControl,
} from "./shared.js";

const LOAD = /^\s*([\w:-]+) by (you|agent) in turn (\d+)(, loading)?\s*$/;
const FIVE_MINUTES = 5 * 60_000;
const SKILL_TOOL_ID = "tool-skill-live";
const navigationScrollTops = new WeakMap<Page, number>();

const activityPanel = (page: Page, turn: string) =>
	page.locator(
		`#messages .msg-container:has([data-uuid="msg-skill-nav-user-${turn}/user"]) + div .turn-activity`,
	);

// e.g. "release-notes by you in turn 1; changelog-style by agent in turn 2, loading"
const parseLoads = (text: string) =>
	text.split(";").map((entry, index) => {
		const parts = LOAD.exec(entry);
		if (!parts) throw new Error(`unreadable skill load "${entry}"`);
		return {
			name: parts[1],
			invokedBy: parts[2] === "you" ? "user" : "agent",
			turnOrdinal: Number(parts[3]),
			// The browser's Date.now is pinned, so ages are read against that.
			at: PINNED_CLOCK_MS - FIVE_MINUTES,
			anchor: { messageId: `msg-skill-${index}` },
			running: parts[4] !== undefined,
		};
	});

/** The open session, as the chip last asked the server about it. */
const openSessionId = async (page: Page) => {
	const request = await requireRpcControl(page).waitForRequest(
		(candidate) => candidate.tag === "GetSessionSkills",
	);
	return String(request.payload["sessionId"]);
};

export const sessionSkillsHandlers: StepHandler[] = [
	{
		name: "seed session skill loads",
		match: /^the session loaded the skills "(.*)"$/,
		run: async ({ world, match }) => {
			mockSessionSkills.set(world.page, parseLoads(match[1] ?? ""));
		},
	},
	{
		name: "seed skills with transcript anchors",
		match: /^the session loaded skills with transcript anchors$/,
		run: async ({ world }) => {
			// Turn 3 wins the timestamp tie with turn 1; turn 2 is last but older.
			const loads = parseLoads(
				"paged-skill by agent in turn 1; paged-skill by agent in turn 3; paged-skill by agent in turn 2; user-skill by you in turn 42",
			);
			mockSessionSkills.set(
				world.page,
				loads.map((load) => ({
					...load,
					at: PINNED_CLOCK_MS - FIVE_MINUTES * (load.turnOrdinal === 2 ? 2 : 1),
					anchor: {
						messageId: `msg-skill-nav-${load.invokedBy === "user" ? "user" : "agent"}-${load.turnOrdinal}`,
						...(load.invokedBy === "agent"
							? { partId: `part-skill-nav-skill-${load.turnOrdinal}` }
							: {}),
					},
				})),
			);
		},
	},
	{
		name: "turn is absent from first transcript page",
		match: /^turn ([0-9]+) is absent from the first transcript page$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#messages .msg-user")).toHaveCount(25);
			await expect(
				world.page.locator(`[data-uuid="msg-skill-nav-user-${match[1]}/user"]`),
			).toHaveCount(0);
			await expect(
				world.page.locator(
					`[data-part="msg-skill-nav-agent-${match[1]}/part-skill-nav-skill-${match[1]}"]`,
				),
			).toHaveCount(0);
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "LoadMoreHistory"),
			).toHaveLength(0);
		},
	},
	{
		name: "tap a skill row",
		match: /^I tap the skill row "([\w:-]+)"$/,
		run: async ({ world, match }) => {
			const row = world.page.locator(
				`[data-testid="session-skills-row"][data-skill="${match[1]}"]`,
			);
			await expect(row).toBeVisible();
			if (navigationScrollTops.has(world.page)) {
				// Measure the row tap after any chrome changes from opening the menu.
				const position = await world.page
					.locator("#messages")
					.evaluate((el) => el.scrollTop);
				navigationScrollTops.set(world.page, position);
			}
			await row.click();
		},
	},
	{
		name: "hold a skill row",
		match: /^I hold the skill row "([\w:-]+)"$/,
		run: async ({ world, match }) => {
			const row = world.page.locator(
				`[data-testid="session-skills-row"][data-skill="${match[1]}"]`,
			);
			await expect(row).toBeVisible();
			const box = await row.boundingBox();
			if (!box) throw new Error("skill row has no touch target");
			const touch = await world.page.context().newCDPSession(world.page);
			try {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [
						{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
					],
				});
				await expect(
					world.page.getByTestId("session-skills-runs"),
				).toBeVisible();
			} finally {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
				await touch.detach();
			}
			await expect(world.page.getByTestId("session-skills-runs")).toBeVisible();
		},
	},
	{
		name: "right-click a skill row",
		match: /^I right-click the skill row "([\w:-]+)"$/,
		run: async ({ world, match }) => {
			await world.page
				.locator(`[data-testid="session-skills-row"][data-skill="${match[1]}"]`)
				.click({ button: "right" });
		},
	},
	{
		name: "focus a skill row",
		match: /^I focus the skill row "([\w:-]+)"$/,
		run: async ({ world, match }) => {
			// The opening menu focuses itself. Wait for that, or it can land after
			// the row's focus and swallow the next key.
			await expect(world.page.getByTestId("session-skills-menu")).toBeFocused();
			const row = world.page.locator(
				`[data-testid="session-skills-row"][data-skill="${match[1]}"]`,
			);
			await row.focus();
			await expect(row).toBeFocused();
		},
	},
	{
		name: "press a skills menu key",
		match:
			/^I press (ArrowRight|ArrowLeft|ContextMenu|Shift\+F10|Escape) in the skills menu$/,
		run: async ({ world, match }) => {
			await world.page.keyboard.press(match[1] ?? "");
		},
	},
	{
		name: "earlier skill runs in order",
		match: /^the earlier runs for "([\w:-]+)" show "(.*)"$/,
		run: async ({ world, match }) => {
			const group = world.page.getByTestId("session-skills-runs");
			await expect(group.getByRole("presentation")).toHaveText(match[1] ?? "");
			await expect(world.page.getByTestId("session-skills-row")).toHaveCount(0);
			await expect(world.page.getByTestId("session-skills-hint")).toHaveCount(
				0,
			);
			const runs = group.getByTestId("session-skills-run");
			const expected = (match[2] ?? "").split(";").map((run) => run.trim());
			await expect(runs).toHaveCount(expected.length);
			const actual = await runs.evaluateAll((items) =>
				items.map((item) => {
					const turn = item.getAttribute("data-turn") ?? "";
					const meta = item
						.querySelector("[data-testid='session-skills-run-meta']")
						?.textContent?.trim();
					return `Jump to turn ${turn} (${meta})`;
				}),
			);
			expect(actual).toEqual(expected);
		},
	},
	{
		name: "first skill run receives focus",
		match: /^the first skill run is focused$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("session-skills-run").first(),
			).toBeFocused();
		},
	},
	{
		name: "originating skill row receives focus",
		match: /^the skill row "([\w:-]+)" is focused$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.locator(
					`[data-testid="session-skills-row"][data-skill="${match[1]}"]`,
				),
			).toBeFocused();
		},
	},
	{
		name: "select a skill action",
		match:
			/^I select the skill action "(All skills|Open SKILL\.md|Hide SKILL\.md|Jump to turn [0-9]+)"$/,
		run: async ({ world, match }) => {
			await world.page
				.getByRole("menu", { name: "Skills used" })
				.getByRole("menuitem")
				.filter({ hasText: match[1] ?? "" })
				.click();
		},
	},
	{
		name: "holding a skill does not page history",
		match: /^no older transcript pages were requested$/,
		run: async ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "LoadMoreHistory"),
			).toHaveLength(0);
		},
	},
	{
		name: "skill doc RPC requested name",
		match: /^SKILL\.md was requested for "([\w:-]+)"$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "GetSkillContent" &&
					request.payload["name"] === match[1],
			);
		},
	},
	{
		name: "skill document visible inside open popover",
		match:
			/^the skill document heading "(.*)" is visible inside the open popover$/,
		run: async ({ world, match }) => {
			const menu = world.page.getByRole("menu", { name: "Skills used" });
			await expect(menu).toBeVisible();
			await expect(world.page.getByTestId("menu-sheet-scrim")).toHaveCount(0);
			const doc = menu.getByTestId("session-skills-doc");
			await expect(
				doc.getByRole("heading", { name: match[1] ?? "", exact: true }),
			).toBeVisible();
			await expect(doc.locator("pre code.language-yaml")).toContainText(
				"name: paged-skill",
			);
			await expect(
				menu.getByRole("menuitem", { name: "Hide SKILL.md", exact: true }),
			).toBeVisible();
			const width = await doc.evaluate((el) => ({
				actual: el.getBoundingClientRect().width,
				limit:
					Number.parseFloat(
						getComputedStyle(document.documentElement).fontSize,
					) * 28,
			}));
			expect(width.actual).toBeLessThanOrEqual(width.limit);
		},
	},
	{
		name: "skill document is hidden",
		match: /^the skill document is hidden$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("session-skills-doc")).toHaveCount(0);
		},
	},
	{
		name: "skills menu is closed",
		match: /^the skills menu is closed$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByRole("menu", { name: "Skills used" }),
			).toHaveCount(0);
		},
	},
	{
		name: "skill navigation paged older history twice",
		match: /^two older transcript pages were requested$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					requireRpcControl(world.page)
						.getRequests()
						.filter((request) => request.tag === "LoadMoreHistory")
						.map((request) => ({
							sessionId: request.payload["sessionId"],
							before: request.payload["before"],
						})),
				)
				.toEqual([
					{ sessionId: "sess-mockup-001", before: "msg-skill-nav-user-40" },
					{ sessionId: "sess-mockup-001", before: "msg-skill-nav-user-15" },
				]);
		},
	},
	{
		name: "skill navigation reveals its focused activity step",
		match:
			/^the Skill step in turn ([0-9]+) is focused in its expanded activity panel and in the viewport$/,
		run: async ({ world, match }) => {
			const turn = match[1] ?? "";
			const panel = activityPanel(world.page, turn);
			const step = panel.locator(
				`[data-part="msg-skill-nav-agent-${turn}/part-skill-nav-skill-${turn}"]`,
			);
			await expect(panel.locator(".turn-activity-toggle")).toHaveAttribute(
				"aria-expanded",
				"true",
			);
			await expect(step).toContainText("paged-skill");
			await expect(step.getByRole("button").first()).toHaveClass(
				/bg-\[rgba\(var\(--overlay-rgb\),0\.06\)\]/,
			);
			await expect(step).toBeInViewport({ ratio: 0.5 });
		},
	},
	{
		name: "turn skills toggle stays closed",
		match: /^the skills toggle for turn ([0-9]+) stays closed$/,
		run: async ({ world, match }) => {
			await expect(
				activityPanel(world.page, match[1] ?? "").locator(".skills-toggle"),
			).toHaveAttribute("aria-expanded", "false");
		},
	},
	{
		name: "collapse skill activity before revisiting it",
		match: /^I collapse the activity panel for turn ([0-9]+)$/,
		run: async ({ world, match }) => {
			const toggle = activityPanel(world.page, match[1] ?? "").locator(
				".turn-activity-toggle",
			);
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "false");
		},
	},
	{
		name: "user skill prompt viewport position",
		match:
			/^the user message in turn ([0-9]+) is (loaded outside the viewport|in the viewport)$/,
		run: async ({ world, match }) => {
			const message = world.page.locator(
				`#messages .msg-user[data-uuid="msg-skill-nav-user-${match[1]}/user"]`,
			);
			await expect(message).toHaveCount(1);
			if (match[2] === "loaded outside the viewport")
				await expect(message).not.toBeInViewport();
			else await expect(message).toBeInViewport({ ratio: 0.5 });
		},
	},
	{
		name: "remember position before skill navigation",
		match: /^I leave the transcript halfway up and remember its position$/,
		run: async ({ world }) => {
			const transcript = world.page.locator("#messages");
			const position = await transcript.evaluate((el) => {
				const midpoint = Math.floor((el.scrollHeight - el.clientHeight) / 2);
				if (midpoint <= 0) throw new Error("transcript has no scroll range");
				el.scrollTo({ top: midpoint, behavior: "instant" });
				return midpoint;
			});
			await expect
				.poll(() => transcript.evaluate((el) => el.scrollTop))
				.toBe(position);
			navigationScrollTops.set(world.page, position);
		},
	},
	{
		name: "missing skill has a quiet default toast",
		match: /^a quiet toast says "(.*)"$/,
		run: async ({ world, match }) => {
			const toast = world.page.getByRole("status").filter({
				hasText: match[1] ?? "",
			});
			await expect(toast).toHaveText(match[1] ?? "");
			await expect(toast).toHaveAttribute("aria-live", "polite");
			await expect(toast).toHaveClass(/\bbg-bg-alt\b/);
			await expect(toast).toBeVisible();
		},
	},
	{
		name: "missing skill keeps transcript position",
		match: /^the transcript has not moved for the skill navigation$/,
		run: async ({ world }) => {
			const position = navigationScrollTops.get(world.page);
			if (position === undefined)
				throw new Error("transcript position was not remembered");
			expect(
				await world.page.locator("#messages").evaluate((el) => el.scrollTop),
			).toBe(position);
		},
	},
	{
		name: "agent starts a skill load",
		match:
			/^the agent starts loading a skill, leaving the session with "(.*)"$/,
		run: async ({ world, match }) => {
			const sessionId = await openSessionId(world.page);
			mockSessionSkills.set(world.page, parseLoads(match[1] ?? ""));
			requireRelayControl(world.page).sendMessage({
				type: "tool_executing",
				sessionId,
				id: SKILL_TOOL_ID,
				name: "Skill",
				input: { skill: "changelog-style" },
			});
		},
	},
	{
		name: "another tab sends a message",
		match: /^another tab sends "(.*)", leaving the session with "(.*)"$/,
		run: async ({ world, match }) => {
			const sessionId = await openSessionId(world.page);
			mockSessionSkills.set(world.page, parseLoads(match[2] ?? ""));
			requireRelayControl(world.page).sendMessage({
				type: "user_message",
				sessionId,
				text: match[1] ?? "",
				originId: "another-tab",
			});
		},
	},
	{
		name: "agent finishes a skill load",
		match: /^the agent finishes loading the skill$/,
		run: async ({ world }) => {
			const sessionId = await openSessionId(world.page);
			const loads = (mockSessionSkills.get(world.page) ?? []) as readonly {
				running: boolean;
			}[];
			mockSessionSkills.set(
				world.page,
				loads.map((load) => ({ ...load, running: false })),
			);
			requireRelayControl(world.page).sendMessage({
				type: "tool_result",
				sessionId,
				id: SKILL_TOOL_ID,
				content: "Loaded.",
				is_error: false,
			});
		},
	},
	{
		name: "skills chip pulse",
		match: /^the skills chip (pulses|does not pulse)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("session-skills-chip-pulse"),
			).toHaveCount(match[1] === "pulses" ? 1 : 0);
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
			const hint = world.page.getByTestId("session-skills-hint");
			if ((await world.page.getByTestId("session-skills-runs").count()) === 0)
				await expect(hint).toHaveText(
					match[1] === "sheet"
						? "Hold a skill for earlier runs and SKILL.md"
						: "Right-click a skill for earlier runs and SKILL.md",
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
