import { expect, type Locator, type Page } from "@playwright/test";
import {
	DEFAULT_CATEGORY_SET,
	type SurfacingFeedbackEntry,
	type SurfacingMark,
} from "../../../src/lib/contracts/category-set.js";
import type { StubTable } from "../../../test/helpers/stub-ws-rpc.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";
import { setSurfacingFixtureMark } from "./surfacingCard.js";

const SESSION = "sess-surfacing";
const ledgers = new WeakMap<Page, SurfacingFeedbackEntry[]>();
const themes = new WeakMap<Page, "dark" | "light">();
const targets = new WeakMap<Page, Locator>();
const levelNames = {
	hidden: "the log",
	all: "All",
	balanced: "Balanced",
	key: "Key",
} as const;

function card(page: Page): Locator {
	return page.getByTestId("surfacing-msg-card");
}
function target(page: Page): Locator {
	return targets.get(page) ?? card(page);
}
function why(page: Page): Locator {
	return target(page).getByTestId("surfacing-mark-why");
}
function requests(page: Page) {
	return requireRpcControl(page)
		.getRequests()
		.filter(({ tag }) => tag === "SetSurfacingMark");
}

/** A committed mark returns through the same detail feed as daemon annotations. */
export function surfacingMarkStubs(page: Page): StubTable {
	return {
		GetSurfacingFeedback: () => ledgers.get(page) ?? [],
		SetSurfacingMark: ({ sessionId, partId, mark }) => {
			expect(sessionId).toBe(SESSION);
			expect(partId).toMatch(/^surfacing-part-\d+$/);
			setSurfacingFixtureMark(page, partId, mark);
			const previous = ledgers.get(page) ?? [];
			const rows = previous.filter((row) => row.partId !== partId);
			if (mark)
				rows.push({
					projectId: "myapp",
					sessionId,
					partId,
					messageId: "surfacing-agent",
					turnId: "surfacing-user",
					ordinal: Number(partId.replace("surfacing-part-", "")),
					text: "A marked message from the surfacing fixture.",
					probabilities: { finding: 0.6 },
					mark,
					createdAt: PINNED_CLOCK_MS,
				});
			ledgers.set(page, rows);
			return { ok: true };
		},
		GetCategorySet: () =>
			ledgers.has(page)
				? {
						...DEFAULT_CATEGORY_SET,
						categories: [
							...DEFAULT_CATEGORY_SET.categories.map((category) => ({
								...category,
								retired: category.id === "milestone",
							})),
							{
								id: "perf",
								origin: "custom",
								label: "Perf",
								glyph: "⚡",
								colour: "#3ecf8e",
								weight: 70,
								retired: false,
								criteria: { what: "Reports a measured performance change." },
							},
						],
					}
				: DEFAULT_CATEGORY_SET,
	};
}

export const surfacingMarksHandlers: StepHandler[] = [
	{
		name: "seed ranked reasons before marks app startup",
		match: /^a surfacing marks ledger is available in the (dark|light) theme$/,
		run: async ({ world, match }) => {
			const theme = match[1] === "light" ? "light" : "dark";
			themes.set(world.page, theme);
			await world.page.addInitScript((mode) => {
				localStorage.setItem("conduit-theme", mode);
			}, theme);
			const rows: SurfacingFeedbackEntry[] = [];
			for (const [direction, reasons] of [
				[
					"raise",
					[
						"changed the plan",
						"users saw this",
						"needed my answer",
						"rare reason",
					],
				],
				["lower", ["noise", "just a compile", "already covered", "rare lower"]],
				[
					"retype",
					[
						"wrong category",
						"needed my answer",
						"changed the plan",
						"rare retype",
					],
				],
			] as const) {
				for (const [index, reason] of reasons.entries()) {
					for (let count = 0; count < 4 - index; count++) {
						const id = `feedback-${direction}-${index}-${count}`;
						rows.push({
							projectId: "myapp",
							sessionId: "surfacing-feedback-history",
							partId: id,
							messageId: `message-${id}`,
							turnId: "feedback-turn",
							ordinal: rows.length + 1,
							text: "A previously marked message.",
							probabilities: { finding: 0.6 },
							mark: { level: "balanced", direction, reason },
							createdAt: PINNED_CLOCK_MS - rows.length * 1_000,
						});
					}
				}
			}
			ledgers.set(world.page, rows);
		},
	},
	{
		name: "verify marks theme after fixture startup",
		match: /^the surfacing marks theme is applied$/,
		run: async ({ world }) => {
			await expect(world.page.locator("html")).toHaveClass(
				new RegExp(`${themes.get(world.page)}-theme`),
			);
		},
	},
	{
		name: "open mark action on the selected card or a log row",
		match:
			/^I (Raise|Lower|Retype) surfaced message #(\d+) from the (card|step log)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const ordinal = match[2] ?? "";
			const wrapper =
				match[3] === "card"
					? card(page)
					: page.getByTestId(`surfacing-step-mark-${ordinal}`);
			if (match[3] === "card") {
				await page.getByTestId(`surfacing-pin-${ordinal}`).click();
				await expect(wrapper).toHaveAttribute("data-ordinal", ordinal);
			}
			targets.set(page, wrapper);
			await wrapper
				.getByTestId(`surfacing-mark-${match[1]?.toLowerCase()}`)
				.click();
		},
	},
	{
		name: "assert why prompt and untouched Jev arithmetic",
		match:
			/^the mark Why row proposes (Raise|Lower|Retype) #(\d+) from (hidden|all|balanced|key) to (hidden|all|balanced|key)$/,
		run: async ({ world, match }) => {
			const row = why(world.page);
			await expect(row).toBeVisible();
			await expect(row.getByTestId("surfacing-mark-prompt")).toContainText(
				new RegExp(
					`${match[1]} #${match[2]}.*${levelNames[match[3] as keyof typeof levelNames]}.*${levelNames[match[4] as keyof typeof levelNames]}.*Why\\?`,
					"i",
				),
			);
			await expect(row).toContainText(/Jev:/);
			await expect(row).toContainText(/Finding/);
			await expect(row).toContainText(/(?:0?\.60?|\.6)\s*×\s*40\s*=\s*24/);
		},
	},
	{
		name: "assert directional top three reason chips",
		match:
			/^the Why row offers the three most used (raise|lower|retype) reasons$/,
		run: async ({ world, match }) => {
			const expected =
				match[1] === "raise"
					? ["changed the plan", "users saw this", "needed my answer"]
					: match[1] === "lower"
						? ["noise", "just a compile", "already covered"]
						: ["wrong category", "needed my answer", "changed the plan"];
			await expect(
				why(world.page).getByTestId("surfacing-mark-reason-chip"),
			).toHaveText(expected);
		},
	},
	{
		name: "save a mark using a reason chip",
		match: /^I save the mark with reason chip (.+)$/,
		run: async ({ world, match }) => {
			await why(world.page)
				.getByTestId("surfacing-mark-reason-chip")
				.filter({ hasText: match[1] ?? "" })
				.click();
		},
	},
	{
		name: "save free text through Enter",
		match: /^I save the mark with free text (.+)$/,
		run: async ({ world, match }) => {
			const field = why(world.page).getByTestId("surfacing-mark-reason");
			await field.fill(match[1] ?? "");
			await field.press("Enter");
		},
	},
	{
		name: "save without a reason",
		match: /^I save the mark without a reason$/,
		run: async ({ world }) => {
			await why(world.page).getByTestId("surfacing-mark-no-reason").click();
		},
	},
	{
		name: "assert the committed mark payload",
		match:
			/^message #(\d+) has an absolute (hidden|all|balanced|key) (raise|lower|retype) mark with (no reason|reason .+)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => requests(world.page).at(-1)?.payload)
				.toMatchObject({
					sessionId: SESSION,
					partId: `surfacing-part-${match[1]}`,
					mark: { level: match[2], direction: match[3] },
				});
			const saved = requests(world.page).at(-1)?.payload[
				"mark"
			] as SurfacingMark;
			if (match[4] === "no reason") expect(saved.reason ?? "").toBe("");
			else expect(saved.reason).toBe(match[4]?.replace(/^reason /, ""));
			if (match[3] !== "retype") expect(saved.category).toBeUndefined();
			await expect(why(world.page)).toHaveCount(0);
		},
	},
	{
		name: "assert mark metadata on the card and pin",
		match:
			/^the card and pin for #(\d+) show the (▲|▼|⇄) mark with reason (.+)$/,
		run: async ({ world, match }) => {
			await expect(card(world.page)).toHaveAttribute(
				"data-ordinal",
				match[1] ?? "",
			);
			await expect(card(world.page)).toContainText(`${match[2]} you`);
			await expect(card(world.page)).toContainText(match[3] ?? "");
			await expect(
				world.page.getByTestId(`surfacing-pin-${match[1]}`),
			).toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert specific saved toast",
		match: /^the surfacing mark toast says (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("surfacing-mark-toast"),
			).toContainText(match[1] ?? "");
			await expect(
				world.page.getByTestId("surfacing-toast-undo"),
			).toBeVisible();
		},
	},
	{
		name: "assert lowered message remains open below this level",
		match: /^message #(\d+) stays open marked hidden at this level$/,
		run: async ({ world, match }) => {
			await expect(card(world.page)).toHaveAttribute(
				"data-ordinal",
				match[1] ?? "",
			);
			await expect(card(world.page)).toContainText(/hidden at this level/i);
		},
	},
	{
		name: "press an active mark again",
		match: /^I press the active (Raise|Lower|Retype) mark again$/,
		run: async ({ world, match }) => {
			const action = target(world.page).getByTestId(
				`surfacing-mark-${match[1]?.toLowerCase()}`,
			);
			await expect(action).toHaveAttribute("aria-pressed", "true");
			await action.click();
		},
	},
	{
		name: "assert mark clear payload",
		match: /^the surfacing mark for #(\d+) is cleared$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => requests(world.page).at(-1)?.payload)
				.toMatchObject({
					sessionId: SESSION,
					partId: `surfacing-part-${match[1]}`,
					mark: null,
				});
		},
	},
	{
		name: "publish a remote clear after the saved part acknowledgement",
		match: /^another device clears surfacing mark #(\d+)$/,
		run: ({ world, match }) => {
			setSurfacingFixtureMark(world.page, `surfacing-part-${match[1]}`, null);
		},
	},
	{
		name: "assert a remote clear replaces the local saved mark",
		match: /^the selected message #(\d+) has no mark label or pressed Raise$/,
		run: async ({ world, match }) => {
			await expect(card(world.page)).toHaveAttribute(
				"data-ordinal",
				match[1] ?? "",
			);
			await expect(
				card(world.page).getByTestId("surfacing-mark-label"),
			).toHaveCount(0);
			await expect(
				card(world.page).getByTestId("surfacing-mark-raise"),
			).toHaveAttribute("aria-pressed", "false");
		},
	},
	{
		name: "undo the last saved or cleared mark",
		match: /^I undo the surfacing mark$/,
		run: async ({ world }) => {
			await world.page.getByTestId("surfacing-toast-undo").click();
		},
	},
	{
		name: "assert retype menu active categories",
		match:
			/^the retype menu offers active categories and hides retired categories$/,
		run: async ({ world }) => {
			await expect(
				target(world.page).getByTestId("surfacing-mark-category-risk"),
			).toBeVisible();
			await expect(
				target(world.page).getByTestId("surfacing-mark-category-perf"),
			).toBeVisible();
			await expect(
				target(world.page).getByTestId("surfacing-mark-category-milestone"),
			).toHaveCount(0);
		},
	},
	{
		name: "pick a new mark category",
		match: /^I retype the message as (risk|perf)$/,
		run: async ({ world, match }) => {
			await target(world.page)
				.getByTestId(`surfacing-mark-category-${match[1]}`)
				.click();
		},
	},
	{
		name: "assert retype stores the chosen category",
		match: /^the saved mark category is (risk|perf)$/,
		run: async ({ world, match }) => {
			expect(requests(world.page).at(-1)?.payload["mark"]).toMatchObject({
				category: match[1],
			});
		},
	},
	{
		name: "expand marked step log",
		match: /^I open the surfacing step log$/,
		run: async ({ world }) => {
			await world.page.locator(".turn-activity-toggle").first().click();
			await expect(
				world.page.getByTestId("surfacing-step-mark-6"),
			).toBeVisible();
		},
	},
	{
		name: "assert limits on surfaced and routine log rows",
		match:
			/^the step log disables Raise at Key and Lower for a routine message$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByTestId("surfacing-step-mark-2")
					.getByTestId("surfacing-mark-raise"),
			).toBeDisabled();
			await expect(
				world.page
					.getByTestId("surfacing-step-mark-6")
					.getByTestId("surfacing-mark-lower"),
			).toBeDisabled();
			await expect(
				world.page
					.getByTestId("surfacing-step-mark-6")
					.getByTestId("surfacing-mark-raise"),
			).toBeEnabled();
		},
	},
	{
		name: "verify keyboard reason cancellation and focus return",
		match: /^mark shortcuts open Why and Escape cancels without saving$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.getByTestId("surfacing-pin-1").click();
			targets.set(page, card(page));
			for (const key of ["+", "-", "−"]) {
				await card(page).focus();
				await card(page).dispatchEvent("keydown", {
					key,
					bubbles: true,
					cancelable: true,
				});
				await expect(why(page)).toBeVisible();
				await why(page)
					.getByTestId("surfacing-mark-reason")
					.fill("do not save this");
				await page.keyboard.press("Escape");
				await expect(why(page)).toHaveCount(0);
				await expect(card(page)).toBeFocused();
			}
			expect(requests(page)).toHaveLength(0);
		},
	},
	{
		name: "verify phone Why controls and prompt layout",
		match:
			/^the Why row keeps phone touch targets and wraps its prompt above chips$/,
		run: async ({ world }) => {
			if ((world.page.viewportSize()?.width ?? 0) >= 768) return;
			const row = why(world.page);
			for (const button of await row.getByRole("button").all()) {
				const box = await button.boundingBox();
				if (!box) throw new Error("Why control has no bounds");
				expect(box.width).toBeGreaterThanOrEqual(32);
				expect(box.height).toBeGreaterThanOrEqual(32);
			}
			const promptBox = await row
				.getByTestId("surfacing-mark-prompt")
				.boundingBox();
			const chipBox = await row
				.getByTestId("surfacing-mark-reason-chip")
				.first()
				.boundingBox();
			if (!promptBox || !chipBox)
				throw new Error("Why prompt or reasons have no bounds");
			expect(promptBox.y + promptBox.height).toBeLessThanOrEqual(chipBox.y + 1);
		},
	},
	{
		name: "freeze the clock for six second Undo window",
		match: /^the surfacing marks clock is paused$/,
		run: async ({ world }) => {
			await world.page.clock.install({ time: PINNED_CLOCK_MS });
			await world.page.clock.pauseAt(PINNED_CLOCK_MS + 1_000);
		},
	},
	{
		name: "assert six second Undo lifetime",
		match: /^the mark Undo stays available for six seconds$/,
		run: async ({ world }) => {
			await world.page.clock.runFor(5_999);
			await expect(
				world.page.getByTestId("surfacing-toast-undo"),
			).toBeVisible();
			await world.page.clock.runFor(1);
			await expect(world.page.getByTestId("surfacing-toast-undo")).toHaveCount(
				0,
			);
		},
	},
];
