import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
	clearDiscoveryState,
	handleModelList,
} from "../../stores/discovery.svelte.js";
import { mockAssistantSimple } from "../../stories/mocks.js";
import AssistantHeader from "./AssistantHeader.svelte";

const meta = {
	title: "Chat/AssistantHeader",
	component: AssistantHeader,
	tags: ["autodocs"],
	args: {
		message: {
			...mockAssistantSimple,
			createdAt: Date.UTC(2026, 1, 25, 10, 58),
		},
		modelExecution: { actualModel: "Sonnet 5" },
		providerId: "claude",
		forkMessageId: "message-before-reply",
	},
} satisfies Meta<typeof AssistantHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

// The title and time must share a baseline, not a box centre.
const baselines = (root: Element) =>
	[...root.querySelectorAll("span, time")]
		.filter((el) => el.childElementCount === 0 && el.textContent?.trim())
		.map((el) => {
			const mark = el.ownerDocument.createElement("span");
			mark.style.cssText = "display:inline-block;width:0;height:0";
			el.append(mark);
			const y = mark.getBoundingClientRect().top;
			mark.remove();
			return y;
		});

export const Default: Story = {
	play: async ({ canvasElement }) => {
		await canvasElement.ownerDocument.fonts.ready;
		const [label, ...rest] = baselines(canvasElement);
		await expect(rest).toHaveLength(2);
		for (const y of rest) await expect(y).toBeCloseTo(label ?? 0, 1);
		const tile = canvasElement.querySelector(".assistant-header > span");
		const name = canvasElement.querySelector(
			".assistant-header > div > span > span",
		);
		if (!tile || !name) throw new Error("Missing assistant identity");
		const mark = tile.getBoundingClientRect();
		const text = name.getBoundingClientRect();
		await expect(
			Math.abs(mark.top + mark.height / 2 - text.top - text.height / 2),
		).toBeLessThan(0.5);
		await expect(tile.querySelector("svg")?.getBoundingClientRect().width).toBe(
			window.innerWidth < 768 ? 12 : 14,
		);
		await expect(name).toHaveTextContent("Sonnet 5");
		await expect(name).not.toHaveAttribute("tabindex");
		await expect(name).not.toHaveAttribute("data-tooltip-trigger");
		await userEvent.hover(name);
		await expect(
			within(canvasElement.ownerDocument.body).queryByRole("tooltip"),
		).not.toBeInTheDocument();
	},
};
export const DefaultLight: Story = { ...Default, globals: { theme: "light" } };
export const TurnSettings: Story = {
	tags: ["viewport-capture"],
	args: {
		modelExecution: {
			requestedModel: "opus[1m]",
			actualModel: "claude-opus-5-5[1m]",
			effort: "high",
			contextWindow: "1m",
		},
	},
	play: async ({ canvasElement }) => {
		const name = within(canvasElement).getByText("Opus 5.5", { exact: true });
		const page = within(canvasElement.ownerDocument.body);
		await expect(name).toHaveAttribute("tabindex", "0");
		await expect(
			within(canvasElement).queryByText("Claude", { exact: true }),
		).not.toBeInTheDocument();
		await userEvent.hover(name);
		await expect(await page.findByRole("tooltip")).toHaveTextContent(
			"Opus 5.5 · 1M · High",
		);
		await userEvent.unhover(name);
		await waitFor(() =>
			expect(page.queryByRole("tooltip")).not.toBeInTheDocument(),
		);
		name.focus();
		await expect(await page.findByRole("tooltip")).toHaveTextContent(
			"Opus 5.5 · 1M · High",
		);
		await userEvent.keyboard("{Escape}");
		name.blur();
		// End on hover so the viewport baseline records the tooltip.
		await userEvent.hover(name);
		await expect(await page.findByRole("tooltip")).toBeVisible();
	},
};
export const NoModel: Story = {
	args: { modelExecution: undefined },
	play: async ({ canvasElement }) => {
		const name = within(canvasElement).getByText("Claude", { exact: true });
		await expect(name).not.toHaveAttribute("tabindex");
	},
};
export const CombinedVariant: Story = {
	tags: ["viewport-capture"],
	args: {
		providerId: "cursor",
		modelExecution: {
			requestedModel: "cursor-auto",
			actualModel: "cursor-gpt-6",
			effort: "high · Fast",
		},
	},
	beforeEach: () => {
		clearDiscoveryState();
		handleModelList({
			providers: [
				{
					id: "cursor",
					name: "Cursor",
					configured: true,
					models: [
						{
							id: "cursor-gpt-6",
							name: "GPT-6",
							provider: "cursor",
							parameters: {
								rows: [
									{
										id: "effort",
										label: "Effort",
										values: [{ value: "high", label: "High" }],
									},
									{
										id: "fast",
										label: "Fast",
										values: [{ value: "true", label: "On" }],
									},
								],
								combinations: [
									{
										variant: "high · Fast",
										values: { effort: "high", fast: "true" },
									},
								],
							},
						},
					],
				},
			],
		});
		return clearDiscoveryState;
	},
	play: async ({ canvasElement }) => {
		await userEvent.hover(
			within(canvasElement).getByText("GPT-6", { exact: true }),
		);
		await expect(
			await within(canvasElement.ownerDocument.body).findByRole("tooltip"),
		).toHaveTextContent(/^GPT-6 · High$/);
	},
};
export const OpenCode: Story = {
	args: { providerId: "opencode", modelExecution: { actualModel: "GPT-6" } },
};
export const Cursor: Story = {
	args: { providerId: "cursor", modelExecution: undefined },
};
export const UnknownProvider: Story = {
	args: { providerId: undefined, modelExecution: undefined },
};
export const Working: Story = {
	args: { message: undefined, forkMessageId: undefined },
};
export const WorkingLight: Story = { ...Working, globals: { theme: "light" } };
export const Actions: Story = {
	tags: ["visual-pointer-hover"],
	play: async ({ canvasElement }) => {
		const buttons = [...canvasElement.querySelectorAll(".msg-actions button")];
		await expect(buttons).toHaveLength(3);
		for (const [index, button] of buttons.entries()) {
			await expect(
				button.querySelector("svg")?.getBoundingClientRect().width,
			).toBe(14);
			if (index > 0)
				await expect(
					button.getBoundingClientRect().left -
						(buttons[index - 1]?.getBoundingClientRect().left ?? 0),
				).toBe(26);
		}
	},
};

export const UnpaddedLocalTime: Story = {
	args: { createdAt: Date.UTC(2026, 1, 25, 9, 14) },
	play: async ({ canvasElement }) => {
		const time = canvasElement.querySelector("time");
		await expect(time).not.toBeNull();
		if (
			new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
				.hour12
		) {
			await expect(time?.textContent).not.toMatch(/^0\d:/);
		}
	},
};
export const ActionsLight: Story = {
	...Actions,
	tags: ["visual-pointer-hover"],
	globals: { theme: "light" },
};
export const MoreActions: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: "More message actions",
			}),
		);
		const page = within(canvasElement.ownerDocument.body);
		expect(page.getAllByRole("menuitem")).toHaveLength(2);
		expect(page.getByRole("menuitem", { name: "Copy message" })).toBeVisible();
		expect(
			page.getByRole("menuitem", { name: "Fork from here" }),
		).toBeVisible();
	},
};
export const MoreActionsLight: Story = {
	...MoreActions,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
