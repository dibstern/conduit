import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import TextInput from "./TextInput.svelte";

const meta = {
	title: "UI/TextInput",
	component: TextInput,
	tags: ["autodocs"],
	args: { "aria-label": "Text input" },
	argTypes: {
		size: { control: "inline-radio", options: ["sm", "md", "content"] },
		chrome: { control: "inline-radio", options: ["bordered", "bare"] },
		invalid: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof TextInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
	args: { size: "sm" },
};

export const Placeholder: Story = {
	args: { placeholder: "Project name" },
};

export const Invalid: Story = {
	args: { invalid: true },
	play: async ({ canvasElement }) => {
		const input = within(canvasElement).getByRole("textbox");
		await expect(input).toHaveAttribute("aria-invalid", "true");
	},
};

export const Disabled: Story = {
	args: { disabled: true },
};

export const Typing: Story = {
	play: async ({ canvasElement }) => {
		const input = within(canvasElement).getByRole("textbox");
		await userEvent.type(input, "hello");
		await expect((input as HTMLInputElement).value).toBe("hello");
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
 * `chrome="bare"` for a field whose affordance is the row AROUND it: the
 * terminal tab-rename box and the model picker's search. It emits no border,
 * background, radius or placeholder colour, and pairs with `size="content"`,
 * which emits no height, padding or type scale.
 *
 * The play function asserts the actual claim by MEASUREMENT rather than by
 * class name. Two utilities from one Tailwind group are resolved by stylesheet
 * order, not class order, so "the consumer class is present" proves nothing
 * about which declaration won. Probes carrying the reference class are appended
 * live and compared with getComputedStyle: if the primitive ever starts
 * emitting a background, a radius or a width again, the call site silently
 * loses and these go red.
 */
export const Bare: Story = {
	args: {
		chrome: "bare",
		size: "content",
		value: "rename me",
		class: "bg-accent rounded-full w-[100px] px-2 text-xs",
	},
	play: async ({ canvasElement }) => {
		const input = within(canvasElement).getByRole("textbox");

		const bgProbe = document.createElement("div");
		bgProbe.className = "bg-accent";
		const radiusProbe = document.createElement("div");
		radiusProbe.className = "rounded-full";
		canvasElement.append(bgProbe, radiusProbe);

		try {
			const style = getComputedStyle(input);
			await expect(style.backgroundColor).toBe(
				getComputedStyle(bgProbe).backgroundColor,
			);
			await expect(style.borderRadius).toBe(
				getComputedStyle(radiusProbe).borderRadius,
			);
			await expect(style.width).toBe("100px");
			// Load-bearing, unlike the three preflight no-ops the call sites
			// dropped: this is what suppresses the UA focus ring.
			await expect(style.outlineStyle).toBe("none");
		} finally {
			bgProbe.remove();
			radiusProbe.remove();
		}
	},
};
