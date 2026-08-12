import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import Pill from "./Pill.svelte";

/** Pass a plain text label as Pill's `children` snippet from a .stories.ts. */
const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

const meta = {
	title: "UI/Pill",
	component: Pill,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { children: label("Pill") },
	argTypes: {
		variant: {
			control: "inline-radio",
			options: ["neutral", "warning"],
		},
	},
} satisfies Meta<typeof Pill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {
	args: { children: label("Default model") },
};

export const Warning: Story = {
	args: { variant: "warning", children: label("Elevated access") },
};

/** Asserting behavior: native semantics, passthrough ARIA, and click callback. */
export const ClickInteraction: Story = {
	args: {
		"aria-expanded": true,
		onclick: fn(),
		children: label("Open models"),
	},
	play: async ({ canvasElement, args }) => {
		const pill = within(canvasElement).getByRole<HTMLButtonElement>("button");
		await expect(pill.tagName).toBe("BUTTON");
		await expect(pill).toHaveAttribute("type", "button");
		await expect(pill).toHaveAttribute("aria-expanded", "true");
		await userEvent.click(pill);
		await expect(args["onclick"]).toHaveBeenCalledOnce();
	},
};

/** Asserting behavior: native disabled state suppresses the callback. */
export const DisabledInteraction: Story = {
	args: {
		disabled: true,
		onclick: fn(),
		children: label("Unavailable"),
	},
	play: async ({ canvasElement, args }) => {
		const pill = within(canvasElement).getByRole<HTMLButtonElement>("button");
		await expect(pill).toBeDisabled();
		await userEvent.click(pill, { pointerEventsCheck: 0 });
		await expect(args["onclick"]).not.toHaveBeenCalled();
	},
};

export const Hover: Story = {
	...Neutral,
	parameters: { pseudo: { hover: true } },
};

export const FocusVisible: Story = {
	...Neutral,
	parameters: { pseudo: { focusVisible: true } },
};

export const Disabled: Story = {
	...Neutral,
	args: { ...Neutral.args, disabled: true },
};
