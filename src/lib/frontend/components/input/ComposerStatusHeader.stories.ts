import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { goalView } from "../../stores/goal.svelte.js";
import ComposerStatusHeader from "./ComposerStatusHeader.svelte";

const STORY_NOW = 1_791_000_000_000;

const meta = {
	title: "Input/ComposerStatusHeader",
	component: ComposerStatusHeader,
	tags: ["autodocs"],
	parameters: { layout: "padded", a11y: { test: "error" } },
	args: {
		startedAt: STORY_NOW - 65_000,
		activity: "Bash · pnpm acceptance:visual",
		following: true,
		onlive: fn(),
	},
	argTypes: {
		startedAt: { control: "number" },
		activity: { control: "text" },
		following: { control: "boolean" },
	},
	beforeEach: () => {
		const realNow = Date.now;
		Date.now = () => STORY_NOW;
		return () => {
			Date.now = realNow;
		};
	},
} satisfies Meta<typeof ComposerStatusHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("composer-status-elapsed"),
		).toHaveTextContent("Working 1:05");
		await expect(
			canvas.queryByTestId("composer-status-live"),
		).not.toBeInTheDocument();
	},
};

export const NewTurn: Story = {
	args: { startedAt: STORY_NOW, activity: "" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("composer-status-elapsed"),
		).toHaveTextContent("Working 0:00");
		await expect(
			canvas.queryByTestId("composer-status-activity"),
		).not.toBeInTheDocument();
	},
};

export const UnderAnHour: Story = {
	args: { startedAt: STORY_NOW - 3_599_000, activity: "Thinking" },
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("composer-status-elapsed"),
		).toHaveTextContent("Working 59:59");
	},
};

export const OverAnHour: Story = {
	args: { startedAt: STORY_NOW - 3_665_000 },
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("composer-status-elapsed"),
		).toHaveTextContent("Working 1:01:05");
	},
};

export const Detached: Story = {
	args: { following: false },
	play: async ({ canvasElement, args }) => {
		const live = within(canvasElement).getByTestId("composer-status-live");
		await expect(live).toBeVisible();
		await userEvent.click(live);
		await expect(args["onlive"]).toHaveBeenCalledOnce();
	},
};

export const PhoneActivity: Story = {
	args: {
		class: "w-[361px] max-w-full",
		following: false,
		activity:
			"Read · src/lib/frontend/components/input/a-very-long-directory-name/another-long-directory/InputArea.svelte",
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const activity = canvas.getByTestId("composer-status-activity");
		const style = getComputedStyle(activity);
		await expect(style.whiteSpace).toBe("nowrap");
		await expect(style.textOverflow).toBe("ellipsis");
		await expect(style.overflowX).toBe("hidden");
		await expect(activity.scrollWidth).toBeGreaterThan(activity.clientWidth);
		await expect(activity.getBoundingClientRect().height).toBeLessThanOrEqual(
			Number.parseFloat(style.lineHeight) + 1,
		);
		await expect(canvas.getByTestId("composer-status-live")).toBeVisible();
	},
};

export const WorkingLight: Story = {
	...Working,
	globals: { theme: "light" },
};

export const OverAnHourLight: Story = {
	...OverAnHour,
	globals: { theme: "light" },
};

export const DetachedLight: Story = {
	...Detached,
	globals: { theme: "light" },
};

export const PhoneActivityLight: Story = {
	...PhoneActivity,
	globals: { theme: "light" },
};

export const CheckingGoal: Story = {
	args: {
		startedAt: null,
		goal: goalView(
			{
				sessionId: "checking-story",
				goal: {
					condition: "All 38 scenarios pass",
					iterations: 2,
					setAt: STORY_NOW,
					tokensAtStart: 0,
				},
			},
			"idle",
		),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("composer-status-header"),
		).toHaveTextContent("Checking goal · check 3");
		await expect(
			canvas.queryByTestId("composer-status-elapsed"),
		).not.toBeInTheDocument();
		await expect(
			canvas.queryByTestId("composer-status-activity"),
		).not.toBeInTheDocument();
		const spinner = canvas
			.getByTestId("composer-status-header")
			.querySelector("svg");
		await expect(spinner).toBeVisible();
		if (!spinner) throw new Error("Checking spinner is missing");
		await expect(getComputedStyle(spinner).animationName).toBe("spin");
		const heading = canvas.getByTestId("composer-status-checking");
		const style = getComputedStyle(heading);
		const expected = new Option().style;
		expected.color = style.getPropertyValue("--color-status-violet");
		await expect(style.color).toBe(expected.color);
		await expect(Number(style.fontWeight)).toBeGreaterThanOrEqual(600);
	},
};

export const NotYet: Story = {
	args: { goalReason: "35 of 38 scenarios pass" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("composer-status-elapsed"),
		).toHaveTextContent("Working 1:05");
		const reason = canvas.getByTestId("composer-status-goal-reason");
		await expect(reason).toHaveTextContent(
			"Not yet: 35 of 38 scenarios pass. Continuing.",
		);
		await expect(reason.querySelector("svg")).toBeVisible();
		const style = getComputedStyle(reason);
		const expected = new Option().style;
		expected.color = style.getPropertyValue("--color-status-amber");
		await expect(style.color).toBe(expected.color);
	},
};

export const CheckingGoalLight: Story = {
	...CheckingGoal,
	globals: { theme: "light" },
};
export const NotYetLight: Story = { ...NotYet, globals: { theme: "light" } };
