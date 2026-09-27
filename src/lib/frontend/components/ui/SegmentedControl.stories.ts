import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import SegmentedControl from "./SegmentedControl.svelte";

const DRIVERS = [
	{ value: "opencode", label: "OpenCode" },
	{ value: "claude", label: "Claude" },
];

const meta = {
	title: "UI/SegmentedControl",
	component: SegmentedControl,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { value: "opencode", options: DRIVERS, label: "Driver" },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

/** SettingsPanel's driver picker, its only consumer. */
export const Default: Story = {};

export const SecondSelected: Story = {
	args: { value: "claude" },
};

/**
 * A value picker, not a tab strip, and specifically a RADIO group rather than a
 * bag of pressed buttons. The distinction is the point of the migration: only
 * a `radiogroup` ancestor makes the set announce as exclusive, and it is the
 * thing both the hand-written original and bits' ToggleGroup get wrong.
 */
export const AnnouncesRadioGroupSemantics: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);

		await expect(canvas.getByRole("radiogroup")).toHaveAccessibleName("Driver");

		const options = canvas.getAllByRole("radio");
		await expect(options).toHaveLength(2);
		await expect(options[0]).toHaveAttribute("aria-checked", "true");
		await expect(options[1]).toHaveAttribute("aria-checked", "false");
		// Not a tablist: this control sets a value, it does not swap a panel.
		await expect(canvas.queryByRole("tab")).toBeNull();
		// bits does not set this on RadioGroup.Item; the component does.
		await expect(options[0]).toHaveAttribute("type", "button");
	},
};

/**
 * Radios cannot be un-checked by pressing the checked one, which is why this
 * control is built on RadioGroup. The failure mode it rules out is invisible:
 * a form silently losing its driver rather than anything you could see.
 */
export const PressingTheSelectedOptionKeepsIt: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const selected = canvas.getAllByRole("radio")[0];

		await userEvent.click(selected as HTMLElement);

		await expect(selected).toHaveAttribute("aria-checked", "true");
	},
};

/**
 * The keyboard behaviour the hand-written version lacked, and the reason for
 * taking a dependency rather than adding `role` attributes by hand: exactly one
 * option is tabbable, and arrows move between them.
 */
export const ArrowKeysMoveSelection: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const options = canvas.getAllByRole("radio");

		await expect(
			options.filter((option) => option.tabIndex === 0),
		).toHaveLength(1);

		(options[0] as HTMLElement).focus();
		await userEvent.keyboard("{ArrowRight}");

		await expect(options[1]).toHaveAttribute("aria-checked", "true");
		await expect(options[0]).toHaveAttribute("aria-checked", "false");
	},
};
