import { expect } from "@playwright/test";
import type { SessionGoalChangedPayload } from "../../../src/lib/contracts/stored-event.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const CONDITION = "All 38 scenarios pass";
const CHECK_REASONS = [
	"29/38 pass. Three baselines are stale.",
	"33/38. Focus ring regressed.",
	"35/38. jump-to-live fails.",
] as const;
const CHECK_TEXT = [
	/8m\s*Not yet\s*·\s*29\/38 pass\. Three baselines are stale\./,
	/19m\s*Not yet\s*·\s*33\/38\. Focus ring regressed\./,
	/31m\s*Not yet\s*·\s*35\/38\. jump-to-live fails\./,
];

export const sessionGoalDetailsHandlers: StepHandler[] = [
	{
		name: "provide goal details through mocked RPC",
		match:
			/^goal details are available for a (working|checking|paused|met) goal$/,
		run: async ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Goal details require an open session");
			const phase = match[1];
			const now = await world.page.evaluate(() => Date.now());
			const setAt = now - 41 * 60_000;
			const goal = {
				condition: CONDITION,
				iterations: 3,
				setAt,
				tokensAtStart: 0,
				lastReason: phase === "checking" ? undefined : CHECK_REASONS[2],
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
			rpc.setResponse("GetGoalDetails", {
				checks: [8, 19, 31].map((minutes, index) => ({
					iteration: index + 1,
					at: setAt + minutes * 60_000,
					reason: CHECK_REASONS[index],
				})),
				tokensSinceStart: 1_240_000,
			});
			rpc.setResponse("CancelSession", { ok: true });
			// The desktop header renders its title row, and with it the goal
			// subtitle, only for a session the sidebar list knows about.
			rpc.setShellRows([
				{
					id: sessionId,
					title: "Stabilise visual suite",
					status: phase === "working" ? "busy" : "idle",
					updatedAt: now,
					messageCount: 6,
					goalState: facts,
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
		match: /^goal details are open below the full session header$/,
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
			expect(request.payload["projectSlug"]).toBe(rpc.projectSlug);
			expect(request.payload["sessionId"]).toBe(
				new URL(world.page.url()).pathname.split("/")[2],
			);
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
						Math.abs(panel.x - header.x) < 2 &&
						Math.abs(panel.width - header.width) < 2 &&
						Math.abs(panel.y - (header.y + header.height)) < 2
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
		name: "assert goal details age and tokens",
		match: /^the goal details metadata includes 41m and 1\.24M tokens$/,
		run: async ({ world }) => {
			const metadata = world.page.getByTestId("goal-details-meta");
			await expect(metadata).toContainText("41m");
			await expect(metadata).toContainText("1.24M");
		},
	},
	{
		name: "assert complete goal details history in iteration order",
		match:
			/^the goal details history shows all three checks in iteration order$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByTestId("goal-details-history")
					.getByTestId("goal-details-check"),
			).toHaveText(CHECK_TEXT);
		},
	},
	{
		name: "assert checking goal details history",
		match:
			/^the goal details history shows three checks followed by Checking now$/,
		run: async ({ world }) => {
			const checks = world.page
				.getByTestId("goal-details-history")
				.getByTestId("goal-details-check");
			await expect(checks).toHaveText([...CHECK_TEXT, /now\s*Checking…/]);
			await expect
				.poll(() =>
					checks
						.last()
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
			await scrim.click({ position: { x: 10, y: box.height - 10 } });
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
			expect(request.payload["projectSlug"]).toBe(rpc.projectSlug);
		},
	},
	{
		name: "assert exact goal details command through composer",
		match:
			/^the goal details action sends exactly (Continue\.|\/goal clear) for the current session$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(candidate) => candidate.tag === "SendMessage",
			);
			expect(request.payload["text"]).toBe(match[1]);
			expect(request.payload["sessionId"]).toBe(
				new URL(world.page.url()).pathname.split("/")[2],
			);
			expect(request.payload["projectSlug"]).toBe(rpc.projectSlug);
		},
	},
	{
		name: "assert goal composer prefill and cursor position",
		match:
			/^the composer is ready (to edit the goal|for a new goal) with its cursor at the end$/,
		run: async ({ world, match }) => {
			const draft =
				match[1] === "to edit the goal" ? `/goal ${CONDITION}` : "/goal ";
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
