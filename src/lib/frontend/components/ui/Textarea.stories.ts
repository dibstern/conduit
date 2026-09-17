import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import Textarea from "./Textarea.svelte";

const meta = {
	title: "UI/Textarea",
	component: Textarea,
	tags: ["autodocs"],
	args: { "aria-label": "Text area", rows: 4 },
	argTypes: {
		size: { control: "inline-radio", options: ["sm", "md", "content"] },
		chrome: { control: "inline-radio", options: ["bordered", "bare"] },
		invalid: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
	args: { size: "sm" },
};

export const Invalid: Story = {
	args: { invalid: true },
	play: async ({ canvasElement }) => {
		const textarea = within(canvasElement).getByRole("textbox");
		await expect(textarea).toHaveAttribute("aria-invalid", "true");
	},
};

export const Disabled: Story = {
	args: { disabled: true },
};

export const Typing: Story = {
	play: async ({ canvasElement }) => {
		const textarea = within(canvasElement).getByRole("textbox");
		await userEvent.type(textarea, "First line{enter}Second line");
		await expect((textarea as HTMLTextAreaElement).value).toBe(
			"First line\nSecond line",
		);
	},
};

// The house focus ring is the only thing that marks the keyboard-focused
// field, and it is a box-shadow painted outside the border box — so without a
// story that forces the state, nothing in the suite would notice it vanishing.
// The visual spec pads the capture root for any story whose id says "focus".
export const FocusVisible: Story = {
	parameters: { pseudo: { focusVisible: true } },
};

/**
 * `chrome="bare"` for the composer, whose affordance is `#input-row`'s border
 * and focus-within ring rather than the field. It emits nothing but
 * `outline-none`, deliberately including no text colour: the composer swaps
 * between `text-transparent` and `text-text` on every IME composition, and a
 * primitive `text-text` would have contested that in the same Tailwind group,
 * where stylesheet order decides and the call site loses.
 *
 * Asserted by MEASUREMENT against live probes, not by class name, for exactly
 * that reason.
 */
export const Bare: Story = {
	args: {
		chrome: "bare",
		size: "content",
		value: "Ask anything.",
		class: "bg-bg-alt text-accent px-3 py-2 w-[240px]",
	},
	play: async ({ canvasElement }) => {
		const textarea = within(canvasElement).getByRole("textbox");

		const bgProbe = document.createElement("div");
		bgProbe.className = "bg-bg-alt";
		const colourProbe = document.createElement("div");
		colourProbe.className = "text-accent";
		canvasElement.append(bgProbe, colourProbe);

		try {
			const style = getComputedStyle(textarea);
			await expect(style.backgroundColor).toBe(
				getComputedStyle(bgProbe).backgroundColor,
			);
			await expect(style.color).toBe(getComputedStyle(colourProbe).color);
			await expect(style.borderRadius).toBe("0px");
			await expect(style.outlineStyle).toBe("none");
		} finally {
			bgProbe.remove();
			colourProbe.remove();
		}
	},
};
