import { expect, type Page } from "@playwright/test";
import type { SessionGoalChangedPayload } from "../../../src/lib/contracts/stored-event.js";
import type { GoalSummary } from "../../../src/lib/contracts/ws-rpc.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const CONDITION = "All 38 scenarios pass";
const STUCK_SUMMARY =
	"Merged to main at 03dc05f8 and closed the beads. Blocked on cleanup: worktrees effect4 and mainbase remain because killing their processes (pids 99950, 11588) was denied. Stop them or allow the kill, and the goal can finish.";
const STUCK_REASON = "Worktree cleanup is blocked by running processes.";
const goalFixtureTimes = new WeakMap<Page, { setAt: number; now: number }>();
const fixtureClock = (at: number) =>
	new Date(at).toLocaleTimeString("en-US", {
		timeZone: "UTC",
		hour: "numeric",
		minute: "2-digit",
	});
const CHECKS = [
	{ minutes: 8, reason: "29/38 pass. Three baselines are stale." },
	{ minutes: 19, reason: "33/38. Focus ring regressed." },
	{ minutes: 31, reason: "35/38. jump-to-live fails." },
];
function fixtureTimes(page: Page) {
	const times = goalFixtureTimes.get(page);
	if (!times) throw new Error("Goal details fixture has not been seeded");
	return times;
}
function checkText(page: Page) {
	const { setAt } = fixtureTimes(page);
	return [...CHECKS]
		.reverse()
		.map(
			({ minutes, reason }) =>
				new RegExp(
					`Not yet.*${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${fixtureClock(setAt + minutes * 60_000).replace(/\s/g, "\\s")}`,
				),
		);
}

export const sessionGoalDetailsHandlers: StepHandler[] = [
	{
		name: "open goal details with keyboard",
		match: /^I open the session goal subtitle with the keyboard$/,
		run: async ({ world }) => {
			await world.page.getByTestId("session-goal-subtitle").focus();
			await world.page.keyboard.press("Enter");
		},
	},
	{
		name: "assert phone goal sheet modality",
		match:
			/^the phone goal sheet is a labelled modal with focus inside and an inert background$/,
		run: async ({ world }) => {
			const sheet = world.page.getByTestId("goal-details");
			await expect(sheet).toHaveRole("dialog");
			await expect(sheet).toHaveAttribute("aria-modal", "true");
			await expect(sheet).toHaveAccessibleName(CONDITION);
			const titleId = await sheet
				.getByTestId("goal-details-condition")
				.getAttribute("id");
			if (!titleId) throw new Error("Goal sheet title has no id");
			await expect(sheet).toHaveAttribute("aria-labelledby", titleId);
			await expect
				.poll(() => sheet.evaluate((el) => el.contains(document.activeElement)))
				.toBe(true);
			for (const target of [
				world.page.getByTestId("session-goal-subtitle"),
				world.page.locator("#input"),
			]) {
				await expect
					.poll(() => target.evaluate((el) => el.closest("[inert]") !== null))
					.toBe(true);
				await target.focus();
				await expect(target).not.toBeFocused();
			}
		},
	},
	{
		name: "cycle phone goal sheet actions in both directions",
		match: /^I tab forwards and backwards through the goal sheet actions$/,
		run: async ({ world }) => {
			const sheet = world.page.getByTestId("goal-details");
			const active = await sheet.getByTestId("goal-details-pause").count();
			const actions = active
				? ["history-toggle", "pause", "edit", "clear"]
				: ["history-toggle", "new", "dismiss"];
			await sheet.getByTestId(`goal-details-${actions[0]}`).focus();
			for (const action of [...actions.slice(1), actions[0]]) {
				await world.page.keyboard.press("Tab");
				await expect(sheet.getByTestId(`goal-details-${action}`)).toBeFocused();
			}
			for (const action of [...actions.slice(1).reverse(), actions[0]]) {
				await world.page.keyboard.press("Shift+Tab");
				await expect(sheet.getByTestId(`goal-details-${action}`)).toBeFocused();
			}
		},
	},
	{
		name: "tap goal subtitle or scrim with touch input",
		match: /^I tap the (session goal subtitle|goal details scrim)$/,
		run: async ({ world, match }) => {
			const scrim = match[1] === "goal details scrim";
			const target = world.page.getByTestId(
				scrim ? "goal-details-scrim" : "session-goal-subtitle",
			);
			await expect(target).toHaveCSS("pointer-events", "auto");
			await expect
				.poll(() => target.evaluate((el) => el.closest("[inert]") !== null))
				.toBe(false);
			const box = await target.boundingBox();
			if (!box) throw new Error("Goal touch target has no layout box");
			const sheet = scrim
				? await world.page.getByTestId("goal-details").boundingBox()
				: null;
			const touch = await world.page.context().newCDPSession(world.page);
			try {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [
						{
							x: scrim ? box.x + 10 : box.x + box.width / 2,
							y: sheet
								? (sheet.y + sheet.height + box.y + box.height) / 2
								: box.y + box.height / 2,
						},
					],
				});
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
			} finally {
				await touch.detach();
			}
		},
	},
	{
		name: "assert goal sheet releases background inertness",
		match: /^the goal sheet background is interactive again$/,
		run: async ({ world }) => {
			for (const target of [
				world.page.getByTestId("session-goal-subtitle"),
				world.page.locator("#input"),
			]) {
				await expect
					.poll(() => target.evaluate((el) => el.closest("[inert]") !== null))
					.toBe(false);
			}
		},
	},
	{
		name: "provide goal details through mocked RPC",
		match:
			/^goal details are available for a (working|checking|paused|met|stuck) goal$/,
		run: async ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Goal details require an open session");
			const phase = match[1];
			const now = await world.page.evaluate(() => Date.now());
			const setAt = now - 41 * 60_000;
			goalFixtureTimes.set(world.page, { setAt, now });
			const goal = {
				condition:
					phase === "stuck"
						? "Complete conduit-test-16c8 and merge it to main, then clean up the worktree"
						: CONDITION,
				iterations: phase === "stuck" ? 196 : 3,
				setAt,
				tokensAtStart: 0,
				lastReason:
					phase === "checking"
						? undefined
						: phase === "stuck"
							? STUCK_REASON
							: CHECKS[2]?.reason,
			};
			const facts: SessionGoalChangedPayload =
				phase === "met"
					? {
							sessionId,
							goal: null,
							ended: "met",
							endedAt: now,
							endedGoal: { ...goal, lastReason: "All 38 scenarios pass" },
						}
					: {
							sessionId,
							goal,
							...(phase === "paused"
								? { pausedReason: "Goal check interrupted" }
								: {}),
						};
			const rpc = requireRpcControl(world.page);
			let summary: GoalSummary | null =
				phase === "stuck"
					? null
					: {
							text:
								phase === "met"
									? "All 38 scenarios pass. The visual suite is stable."
									: "35/38 scenarios pass. The jump-to-live control still fails.",
							generatedAt: now,
							stale: false,
						};
			rpc.setStubs({
				GetGoalDetails: () => ({
					summary,
					judgeModel: "Sonnet 5",
					setAt,
					turnCount: phase === "stuck" ? 196 : 4,
					checks:
						phase === "stuck"
							? Array.from({ length: 196 }, (_, index) => ({
									iteration: index + 1,
									turnIndex: index + 1,
									at:
										index < 3
											? setAt + (index + 1) * 60_000
											: now - 25 * 60_000 + (index - 3) * 7_500,
									reason:
										index < 3 ? (CHECKS[index]?.reason ?? null) : STUCK_REASON,
								}))
							: CHECKS.map(({ minutes, reason }, index) => ({
									iteration: index + 1,
									turnIndex: index + 1,
									at: setAt + minutes * 60_000,
									reason,
								})),
					tokensSinceStart: 1_240_000,
				}),
				GenerateGoalSummary: () => {
					summary = { text: STUCK_SUMMARY, generatedAt: now, stale: false };
					return summary;
				},
			});
			rpc.setStubs({ CancelSession: () => ({ ok: true }) });
			// The desktop header renders its title row, and with it the goal
			// subtitle, only for a session the sidebar list knows about.
			const row = rpc.shellRows?.find(
				(candidate) => (candidate as { id?: string }).id === sessionId,
			);
			rpc.setShellRows([
				{
					...(row as object | undefined),
					id: sessionId,
					title: "Stabilise visual suite",
					status: phase === "working" ? "busy" : "idle",
					updatedAt: now,
					messageCount: 6,
					goalState: facts,
					...(phase === "stuck"
						? {
								goalStuck: {
									since: now - 25 * 60_000,
									lastAt: now - 60_000,
									count: 193,
								},
							}
						: {}),
				},
			]);
			const relay = requireRelayControl(world.page);
			relay.sendMessage({ type: "session.goal_changed", ...facts });
			await expect(
				world.page.getByTestId("session-goal-subtitle"),
			).toBeVisible();
		},
	},
	{
		name: "open goal details from subtitle",
		match: /^I click the session goal subtitle$/,
		run: async ({ world }) => {
			const subtitle = world.page.getByTestId("session-goal-subtitle");
			await expect(subtitle).toHaveRole("button");
			await subtitle.click();
		},
	},
	{
		name: "open goal details from met composer bar",
		match: /^I click Details in the met goal bar$/,
		run: async ({ world }) => {
			await world.page.getByTestId("composer-goal-met-details").click();
		},
	},
	{
		name: "assert open goal details and header anchoring",
		match: /^goal details open in the session header popover or phone sheet$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("goal-details")).toBeVisible();
			await expect(world.page.getByTestId("goal-details-scrim")).toBeVisible();
			await expect(
				world.page.getByTestId("session-goal-subtitle"),
			).toHaveAttribute("aria-expanded", "true");
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(candidate) => candidate.tag === "GetGoalDetails",
			);
			expect(request.payload["sessionId"]).toBe(
				new URL(world.page.url()).pathname.split("/")[2],
			);
			const desktop = await world.page
				.locator('#session-bar[data-compact="false"]')
				.count();
			await expect
				.poll(async () => {
					const header = await world.page
						.getByTestId("session-bar")
						.boundingBox();
					const panel = await world.page
						.getByTestId("goal-details")
						.boundingBox();
					return (
						header !== null &&
						panel !== null &&
						(desktop
							? panel.width <= 380 &&
								panel.x >= header.x &&
								panel.y >= header.y + header.height
							: Math.abs(panel.x - header.x) < 2 &&
								Math.abs(panel.width - header.width) < 2 &&
								Math.abs(panel.y - header.y - header.height) < 2 &&
								panel.y + panel.height <=
									(world.page.viewportSize()?.height ?? 0) - 64)
					);
				})
				.toBe(true);
		},
	},
	{
		name: "assert goal details condition",
		match: /^the goal details condition reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("goal-details-condition")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert stuck goal callout",
		match: /^the stuck goal explains its repeated blocker$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("session-goal-subtitle"),
			).toContainText("Stuck");
			const callout = world.page.getByTestId("goal-details-stuck");
			await expect(callout).toContainText("Stuck for 24 minutes");
			await expect(callout).toContainText(
				"193 checks in a row found the same blocker.",
			);
		},
	},
	{
		name: "assert generated goal summary and live announcement",
		match: /^the goal summary is written on open in a polite live region$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("goal-details-summary"),
			).toHaveAttribute("aria-live", "polite");
			await expect(
				world.page.getByTestId("goal-details-summary-body"),
			).toHaveText(STUCK_SUMMARY);
			await expect(
				world.page.getByTestId("goal-details-summary-label"),
			).toHaveText(`Summary · ${fixtureClock(fixtureTimes(world.page).now)}`);
		},
	},
	{
		name: "assert exact goal summary generation calls",
		match: /^the goal summary has been generated exactly (\d+) times?$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			await expect
				.poll(
					() =>
						rpc
							.getRequests()
							.filter(
								(request) =>
									request.tag === "GenerateGoalSummary" &&
									request.payload["sessionId"] === sessionId,
							).length,
				)
				.toBe(Number(match[1]));
		},
	},
	{
		name: "assert goal details refetch on reopen",
		match: /^the goal details have been fetched exactly (\d+) times$/,
		run: async ({ world, match }) => {
			await expect
				.poll(
					() =>
						requireRpcControl(world.page)
							.getRequests()
							.filter((request) => request.tag === "GetGoalDetails").length,
				)
				.toBe(Number(match[1]));
		},
	},
	{
		name: "assert reopened goal keeps its current summary",
		match: /^the goal summary remains current without another generation$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("goal-details-summary-body"),
			).toHaveText(STUCK_SUMMARY);
			await expect(
				world.page.getByTestId("goal-details-summary-label"),
			).toHaveText(`Summary · ${fixtureClock(fixtureTimes(world.page).now)}`);
			await world.page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => resolve()),
					),
			);
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "GenerateGoalSummary"),
			).toHaveLength(1);
		},
	},
	{
		name: "assert goal summary heading",
		match: /^the goal summary heading reads (Where it stands|How it ended)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByTestId("goal-details-summary")
					.getByText(match[1] ?? "", { exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "assert goal history is initially collapsed",
		match: /^the goal details history is collapsed$/,
		run: async ({ world }) => {
			const history = world.page.getByTestId("goal-details-history-toggle");
			await expect(history).toHaveRole("button");
			await expect(history).toHaveAttribute("aria-expanded", "false");
			await expect(world.page.getByTestId("goal-details-history")).toBeHidden();
		},
	},
	{
		name: "toggle inline goal history",
		match: /^I toggle goal details History$/,
		run: async ({ world }) => {
			await world.page.getByTestId("goal-details-history-toggle").click();
		},
	},
	{
		name: "assert goal details metadata and tokens",
		match: /^the goal details metadata describes its start, judge and tokens$/,
		run: async ({ world }) => {
			const metadata = world.page.getByTestId("goal-details-meta");
			await expect(metadata).toHaveText(
				`Set ${fixtureClock(fixtureTimes(world.page).setAt)} · Sonnet 5 judges · 1.24M tokens`,
			);
			await expect(world.page.getByTestId("goal-details")).toContainText(
				"1.24M tokens",
			);
		},
	},
	{
		name: "assert complete goal details history in layout order",
		match: /^the goal details history shows all three checks in layout order$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByTestId("goal-details-history")
					.getByTestId("goal-details-check"),
			).toHaveText(checkText(world.page));
		},
	},
	{
		name: "assert checking goal details history",
		match:
			/^the goal details history shows Checking now followed by three checks$/,
		run: async ({ world }) => {
			const checks = world.page
				.getByTestId("goal-details-history")
				.getByTestId("goal-details-check");
			await expect(checks).toHaveText([
				/Checking.*now/,
				...checkText(world.page),
			]);
			await expect
				.poll(() =>
					checks
						.first()
						.locator("svg")
						.evaluate((el) => getComputedStyle(el).animationName),
				)
				.toBe("spin");
		},
	},
	{
		name: "assert active goal details actions",
		match: /^goal details offer (Pause|Resume), Edit and Clear$/,
		run: async ({ world, match }) => {
			const pause = match[1] === "Pause";
			await expect(
				world.page.getByTestId(`goal-details-${pause ? "pause" : "resume"}`),
			).toBeVisible();
			await expect(
				world.page.getByTestId(`goal-details-${pause ? "resume" : "pause"}`),
			).toBeHidden();
			for (const action of ["edit", "clear"])
				await expect(
					world.page.getByTestId(`goal-details-${action}`),
				).toBeVisible();
			for (const action of ["new", "dismiss"])
				await expect(
					world.page.getByTestId(`goal-details-${action}`),
				).toBeHidden();
		},
	},
	{
		name: "assert met goal details actions",
		match: /^goal details offer Set a new goal and Dismiss$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("goal-details-new")).toHaveText(
				"Set a new goal",
			);
			await expect(world.page.getByTestId("goal-details-dismiss")).toHaveText(
				"Dismiss",
			);
			await expect(world.page.getByTestId("goal-details")).toContainText(
				`3 checks · met ${fixtureClock(fixtureTimes(world.page).now)}`,
			);
			for (const action of ["pause", "resume", "edit", "clear"])
				await expect(
					world.page.getByTestId(`goal-details-${action}`),
				).toBeHidden();
		},
	},
	{
		name: "dismiss goal details with scrim",
		match: /^I click the goal details scrim$/,
		run: async ({ world }) => {
			const scrim = world.page.getByTestId("goal-details-scrim");
			const box = await scrim.boundingBox();
			if (!box) throw new Error("Goal details scrim has no layout box");
			const phoneSheet = world.page.locator(
				'#session-bar[data-compact="true"] #goal-details',
			);
			const sheet = (await phoneSheet.count())
				? await phoneSheet.boundingBox()
				: null;
			await scrim.click({
				position: {
					x: 10,
					y: sheet
						? (sheet.y + sheet.height - box.y + box.height) / 2
						: box.height - 10,
				},
			});
		},
	},
	{
		name: "dismiss goal details with Escape",
		match: /^I press Escape in goal details$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "assert closed goal details",
		match: /^goal details are closed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("goal-details")).toBeHidden();
			await expect(world.page.getByTestId("goal-details-scrim")).toBeHidden();
			const subtitle = world.page.getByTestId("session-goal-subtitle");
			if (await subtitle.count())
				await expect(subtitle).toHaveAttribute("aria-expanded", "false");
		},
	},
	{
		name: "assert subtitle focus after Escape",
		match: /^the session goal subtitle has focus$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("session-goal-subtitle"),
			).toBeFocused();
		},
	},
	{
		name: "press goal details action",
		match:
			/^I press (Pause|Resume|Edit|Clear|Set a new goal|Dismiss) in goal details$/,
		run: async ({ world, match }) => {
			const action =
				match[1] === "Set a new goal" ? "new" : match[1]?.toLowerCase();
			await world.page.getByTestId(`goal-details-${action}`).click();
		},
	},
	{
		name: "assert goal details interrupts current session",
		match: /^the goal details action interrupts the current session$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(candidate) => candidate.tag === "CancelSession",
			);
			expect(request.payload["sessionId"]).toBe(
				new URL(world.page.url()).pathname.split("/")[2],
			);
		},
	},
	{
		name: "assert exact goal details command through composer",
		match:
			/^the goal details action sends exactly (Continue\.|\/goal clear) for the current session$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(candidate) => candidate.tag === "input.submit",
			);
			expect(request.payload["text"]).toBe(match[1]);
			expect(request.payload["sessionId"]).toBe(
				new URL(world.page.url()).pathname.split("/")[2],
			);
		},
	},
	{
		name: "assert goal composer prefill and cursor position",
		match:
			/^the composer is ready (to edit the goal|for a new goal) with its cursor at the end$/,
		run: async ({ world, match }) => {
			// The composer spells Claude's goal command $goal, as its command menu does.
			const draft =
				match[1] === "to edit the goal" ? `$goal ${CONDITION}` : "$goal ";
			const input = world.page.locator("#input");
			await expect(input).toHaveValue(draft);
			await expect(input).toBeFocused();
			const selection = await input.evaluate((el) => {
				const textarea = el as HTMLTextAreaElement;
				return { start: textarea.selectionStart, end: textarea.selectionEnd };
			});
			expect(selection).toEqual({ start: draft.length, end: draft.length });
		},
	},
];
