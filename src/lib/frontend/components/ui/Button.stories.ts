import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import Button from "./Button.svelte";

/** Pass a plain text label as Button's `children` snippet from a .stories.ts. */
const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

const meta = {
	title: "UI/Button",
	component: Button,
	tags: ["autodocs"],
	args: { children: label("Button") },
	argTypes: {
		variant: {
			control: "select",
			options: ["primary", "secondary", "ghost", "ghost-accent", "danger"],
		},
		size: { control: "inline-radio", options: ["sm", "md"] },
		icon: { control: "text" },
		iconOnly: { control: "boolean" },
		loading: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
	args: { variant: "primary", children: label("Save changes") },
};
export const Secondary: Story = {
	args: { variant: "secondary", children: label("Cancel") },
};
export const Ghost: Story = {
	args: { variant: "ghost", children: label("Dismiss") },
};
export const GhostAccent: Story = {
	args: { variant: "ghost-accent", children: label("Learn more") },
};
export const Danger: Story = {
	args: { variant: "danger", children: label("Delete project") },
};

export const Small: Story = {
	args: { variant: "primary", size: "sm", children: label("Small") },
};

export const WithIcon: Story = {
	args: { variant: "primary", icon: "save", children: label("Save") },
};

export const IconOnly: Story = {
	args: {
		variant: "ghost",
		iconOnly: true,
		icon: "settings",
		ariaLabel: "Settings",
	},
};

export const Loading: Story = {
	args: { variant: "primary", loading: true, children: label("Saving…") },
};

export const Disabled: Story = {
	args: { variant: "primary", disabled: true, children: label("Unavailable") },
};

/** Asserting interaction: an enabled Button invokes its onclick. */
export const ClickInteraction: Story = {
	args: { variant: "primary", onclick: fn(), children: label("Click me") },
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole("button");
		await userEvent.click(button);
		await expect(args["onclick"]).toHaveBeenCalledOnce();
	},
};

/** Asserting interaction: a disabled Button swallows clicks. */
export const DisabledInteraction: Story = {
	args: {
		variant: "primary",
		disabled: true,
		onclick: fn(),
		children: label("No-op"),
	},
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole<HTMLButtonElement>("button");
		await expect(button).toBeDisabled();
		// Force past the pointer-events:none guard: the native `disabled` attribute
		// must still swallow the click, so onclick never fires.
		await userEvent.click(button, { pointerEventsCheck: 0 });
		await expect(args["onclick"]).not.toHaveBeenCalled();
	},
};

export const Hover: Story = {
	...Primary,
	parameters: { pseudo: { hover: true } },
};

export const FocusVisible: Story = {
	...Primary,
	parameters: { pseudo: { focusVisible: true } },
};
