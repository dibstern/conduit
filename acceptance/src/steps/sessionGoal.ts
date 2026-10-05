import { expect, type Page } from "@playwright/test";
import type { SessionGoalChangedPayload } from "../../../src/lib/contracts/stored-event.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const goals = new WeakMap<Page, SessionGoalChangedPayload>();

export const sessionGoalHandlers: StepHandler[] = [
	{
		name: "Claude sets a session goal",
		match: /^Claude sets the goal (.+)$/,
		run: async ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("No session is open");
			const facts: SessionGoalChangedPayload = {
				sessionId,
				goal: {
					condition: match[1] ?? "",
					iterations: 0,
					setAt: await world.page.evaluate(() => Date.now()),
					tokensAtStart: 0,
				},
			};
			goals.set(world.page, facts);
			const relay = requireRelayControl(world.page);
			relay.sendMessage({ type: "status", sessionId, status: "processing" });
			relay.sendMessage({ type: "session.goal_changed", ...facts });
		},
	},
	{
		name: "Claude reports a goal check",
		match: /^Claude reports the goal check (.+)$/,
		run: async ({ world, match }) => {
			const previous = goals.get(world.page);
			if (!previous?.goal) throw new Error("No goal was set");
			const facts: SessionGoalChangedPayload = {
				sessionId: previous.sessionId,
				goal: {
					...previous.goal,
					iterations: previous.goal.iterations + 1,
					lastReason: match[1] ?? "",
				},
			};
			goals.set(world.page, facts);
			requireRelayControl(world.page).sendMessage({
				type: "session.goal_changed",
				...facts,
			});
		},
	},
	{
		name: "Claude is idle",
		match: /^Claude is idle$/,
		run: async ({ world }) => {
			const facts = goals.get(world.page);
			if (!facts) throw new Error("No goal was set");
			requireRelayControl(world.page).sendMessage({
				type: "status",
				sessionId: facts.sessionId,
				status: "idle",
			});
		},
	},
	{
		name: "goal check is running",
		match: /^the goal check is running$/,
		run: async ({ world }) => {
			const previous = goals.get(world.page);
			if (!previous?.goal) throw new Error("No goal was set");
			const facts: SessionGoalChangedPayload = {
				sessionId: previous.sessionId,
				goal: { ...previous.goal, iterations: 2, lastReason: undefined },
			};
			goals.set(world.page, facts);
			const relay = requireRelayControl(world.page);
			relay.sendMessage({
				type: "status",
				sessionId: facts.sessionId,
				status: "idle",
			});
			relay.sendMessage({ type: "session.goal_changed", ...facts });
		},
	},
	{
		name: "Claude pauses the goal",
		match: /^Claude pauses the goal with the reason (.+)$/,
		run: async ({ world, match }) => {
			const previous = goals.get(world.page);
			if (!previous?.goal) throw new Error("No goal was set");
			const facts: SessionGoalChangedPayload = {
				...previous,
				pausedReason: match[1] ?? "",
			};
			goals.set(world.page, facts);
			const relay = requireRelayControl(world.page);
			relay.sendMessage({
				type: "status",
				sessionId: facts.sessionId,
				status: "idle",
			});
			relay.sendMessage({ type: "session.goal_changed", ...facts });
		},
	},
	{
		name: "goal is met with a reason",
		match: /^the goal is met with the reason (.+)$/,
		run: async ({ world, match }) => {
			const previous = goals.get(world.page);
			if (!previous?.goal) throw new Error("No goal was set");
			const endedAt = await world.page.evaluate(() => Date.now());
			const facts: SessionGoalChangedPayload = {
				sessionId: previous.sessionId,
				goal: null,
				ended: "met",
				endedGoal: {
					...previous.goal,
					setAt: endedAt - 41 * 60_000,
					iterations: 7,
					lastReason: match[1] ?? "",
				},
				endedAt,
			};
			goals.set(world.page, facts);
			const relay = requireRelayControl(world.page);
			relay.sendMessage({
				type: "status",
				sessionId: facts.sessionId,
				status: "idle",
			});
			relay.sendMessage({ type: "session.goal_changed", ...facts });
		},
	},
	{
		name: "Claude clears the session goal",
		match: /^Claude clears the goal$/,
		run: async ({ world }) => {
			const previous = goals.get(world.page);
			if (!previous) throw new Error("No goal was set");
			const facts: SessionGoalChangedPayload = {
				sessionId: previous.sessionId,
				goal: null,
				ended: "cleared",
				...(previous.goal ? { endedGoal: previous.goal } : {}),
				endedAt: await world.page.evaluate(() => Date.now()),
			};
			goals.set(world.page, facts);
			requireRelayControl(world.page).sendMessage({
				type: "session.goal_changed",
				...facts,
			});
		},
	},
	{
		name: "assert session goal subtitle",
		match: /^the (amber )?session goal subtitle reads (.+)$/,
		run: async ({ world, match }) => {
			const subtitle = world.page.getByTestId("session-goal-subtitle");
			await expect(subtitle).toHaveText(match[2] ?? "");
			const presentation = await subtitle.evaluate((el, amber) => {
				const style = getComputedStyle(el);
				const expected = new Option().style;
				const label = el.textContent?.trim() ?? "";
				const token = amber
					? "--color-status-amber"
					: label.startsWith("Goal met")
						? "--color-status-green"
						: "--color-status-violet";
				expected.color = style.getPropertyValue(token);
				const text = el.querySelector("span");
				return {
					color: style.color,
					tone: expected.color,
					icon: el.querySelector("svg") !== null,
					ellipsis: text ? getComputedStyle(text).textOverflow : null,
				};
			}, match[1] !== undefined);
			expect(presentation.color).toBe(presentation.tone);
			expect(presentation.icon).toBe(true);
			expect(presentation.ellipsis).toBe("ellipsis");
			const titleBox = await world.page
				.getByTestId("session-bar-title")
				.boundingBox();
			const subtitleBox = await subtitle.boundingBox();
			if (
				!titleBox ||
				!subtitleBox ||
				subtitleBox.y < titleBox.y + titleBox.height - 1
			)
				throw new Error("Goal subtitle is not below the session title");
		},
	},
	{
		name: "assert goal composer border",
		match: /^the composer has a (violet|dashed violet|normal) goal border$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() =>
					world.page.locator("#input-row").evaluate((el, kind) => {
						const style = getComputedStyle(el);
						const probe = document.createElement("span");
						probe.style.color =
							kind === "dashed violet"
								? "color-mix(in srgb, var(--color-status-violet) 60%, var(--color-border))"
								: "var(--color-status-violet)";
						el.append(probe);
						const color = getComputedStyle(probe).color;
						probe.remove();
						if (kind === "normal")
							return (
								style.borderStyle === "solid" &&
								style.borderColor !== color &&
								!style.boxShadow.includes("3px")
							);
						return (
							style.borderColor === color &&
							style.borderStyle ===
								(kind === "dashed violet" ? "dashed" : "solid") &&
							(kind === "dashed violet"
								? style.boxShadow === "none"
								: style.boxShadow.includes("3px"))
						);
					}, match[1]),
				)
				.toBe(true);
		},
	},
	{
		name: "assert session goal spinner",
		match: /^the session goal subtitle has a spinner$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					world.page
						.getByTestId("session-goal-subtitle")
						.locator("svg.lucide-loader-circle")
						.evaluate((el) => getComputedStyle(el).animationName),
				)
				.toBe("spin");
		},
	},
	{
		name: "assert checking goal header",
		match:
			/^the composer checks the goal at check ([0-9]+) without an elapsed timer$/,
		run: async ({ world, match }) => {
			const header = world.page.getByTestId("composer-status-header");
			await expect(header).toHaveText(`Checking goal · check ${match[1]}`);
			await expect(
				world.page.getByTestId("composer-status-elapsed"),
			).toHaveCount(0);
			await expect
				.poll(() =>
					header
						.locator("svg.lucide-loader-circle")
						.evaluate((el) => getComputedStyle(el).animationName),
				)
				.toBe("spin");
			await expect
				.poll(() =>
					world.page.getByTestId("composer-status-checking").evaluate((el) => {
						const style = getComputedStyle(el);
						const expected = new Option().style;
						expected.color = style.getPropertyValue("--color-status-violet");
						return (
							style.color === expected.color && Number(style.fontWeight) >= 600
						);
					}),
				)
				.toBe(true);
		},
	},
	{
		name: "assert composer status omits text",
		match: /^the composer status header does not include (.+)$/,
		run: async ({ world, match }) => {
			const header = world.page.getByTestId("composer-status-header");
			await expect(header).toBeVisible();
			await expect(header).not.toContainText(match[1] ?? "");
		},
	},
	{
		name: "assert pause reason title",
		match: /^the session goal pause title includes (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("session-goal-subtitle"),
			).toHaveAttribute("title", expect.stringContaining(match[1] ?? ""));
		},
	},
	{
		name: "assert met goal bar",
		match: /^the met goal bar reads (.+)$/,
		run: async ({ world, match }) => {
			const bar = world.page.getByTestId("composer-goal-met");
			await expect(bar.locator(":scope > span")).toHaveText(match[1] ?? "");
			await expect(
				bar.getByRole("button", { name: "Dismiss", exact: true }),
			).toBeVisible();
			await expect(
				bar.getByRole("button", { name: "Details", exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "dismiss met goal bar",
		match: /^I dismiss the met goal bar$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("composer-goal-met")
				.getByRole("button", { name: "Dismiss", exact: true })
				.click();
		},
	},
	{
		name: "assert dismissed goal outcome",
		match: /^the met goal bar and subtitle are not rendered$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("composer-goal-met")).toHaveCount(0);
			await expect(world.page.getByTestId("session-goal-subtitle")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "replay stored goal after reload",
		match: /^the stored goal is replayed after a reload$/,
		run: async ({ world }) => {
			const facts = goals.get(world.page);
			if (!facts) throw new Error("No goal was set");
			// The daemon restores a goal through the session row and the /ws
			// metadata push, in either order. A row without goalState arriving
			// after the push would clear the goal.
			const rpc = requireRpcControl(world.page);
			rpc.setShellRows(
				(rpc.shellRows ?? []).map((row) =>
					(row as { id?: string }).id === facts.sessionId
						? { ...(row as object), goalState: facts }
						: row,
				),
			);
			await world.page.reload();
			await expect(world.page.locator("#input")).toBeVisible();
			requireRelayControl(world.page).sendMessage({
				type: "session.goal_changed",
				...facts,
			});
		},
	},
	{
		name: "assert cleared goal bar",
		match: /^the cleared goal bar offers Undo$/,
		run: async ({ world }) => {
			const bar = world.page.getByTestId("composer-goal-cleared");
			await expect(
				bar.getByText("Goal cleared", { exact: true }),
			).toBeVisible();
			await expect(
				bar.getByRole("button", { name: "Undo", exact: true }),
			).toBeEnabled();
		},
	},
	{
		name: "undo cleared goal",
		match: /^I click Undo for the cleared goal$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("composer-goal-cleared")
				.getByRole("button", { name: "Undo", exact: true })
				.click();
		},
	},
	{
		name: "assert sent goal command",
		match:
			/^the mock relay received the goal message (\/goal .+) for the current session$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["text"] === match[1],
			);
			expect(request.payload["sessionId"]).toBe(
				new URL(world.page.url()).pathname.split("/")[2],
			);
		},
	},
	{
		name: "assert cleared goal bar absent",
		match: /^the cleared goal bar is not rendered$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("composer-goal-cleared")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "assert preserved composer draft",
		match: /^the composer draft still reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#input")).toHaveValue(match[1] ?? "");
		},
	},
	{
		name: "assert goal transcript notice",
		match: /^the goal transcript notice reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("session-goal-notice")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert goal subtitle and notice absent",
		match: /^no session goal subtitle or transcript notice is rendered$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("session-goal-subtitle")).toHaveCount(
				0,
			);
			await expect(world.page.getByTestId("session-goal-notice")).toHaveCount(
				0,
			);
		},
	},
];
