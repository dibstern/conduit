import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import DisclosureStoryGallery from "./__fixtures__/DisclosureStoryGallery.svelte";
import Disclosure from "./Disclosure.svelte";

/** Pass a plain text label as Disclosure's `children` snippet from a .stories.ts. */
const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

const meta = {
	title: "UI/Disclosure",
	component: Disclosure,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: {
		expanded: false,
		onToggle: () => {},
		children: label("Disclosure row"),
	},
	argTypes: {
		density: {
			control: "inline-radio",
			options: ["default", "compact", "tight", "roomy", "split"],
		},
		look: {
			control: "inline-radio",
			options: ["card", "section", "row"],
		},
		chevron: { control: "boolean" },
		selectable: { control: "boolean" },
	},
} satisfies Meta<typeof Disclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every density in both states, the chevron-less variant, and every `look`. */
export const Densities: Story = {
	render: () => ({ Component: DisclosureStoryGallery }),
};

/**
 * The reason the primitive exists: not one of the five hand-written headers it
 * replaced set `aria-expanded`, so this asserts the state is announced and that
 * it actually tracks the prop rather than being hardcoded.
 */
export const AnnouncesState: Story = {
	args: { expanded: true, children: label("Expanded row") },
	play: async ({ canvasElement }) => {
		const row = within(canvasElement).getByRole("button", {
			expanded: true,
		});
		await expect(row).toHaveAttribute("aria-expanded", "true");
		// The chevron is decorative; aria-expanded is what reports the state.
		await expect(row.querySelector("[aria-hidden='true']")).not.toBeNull();
	},
};

/**
 * The row is a real button, so it toggles on click and on Enter for free.
 * Disclosure takes no rest props, so there is no `data-testid` to query by:
 * the role IS the contract, and querying by it proves the contract holds.
 */
export const TogglesOnClick: Story = (() => {
	let toggles = 0;
	return {
		args: { onToggle: () => (toggles += 1) },
		play: async ({ canvasElement }) => {
			toggles = 0;
			const row = within(canvasElement).getByRole("button", {
				expanded: false,
			});

			await userEvent.click(row);
			row.focus();
			await userEvent.keyboard("{Enter}");
			await expect(toggles).toBe(2);
		},
	};
})();
