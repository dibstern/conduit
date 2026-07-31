import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import SurfaceStoryGallery from "./__fixtures__/SurfaceStoryGallery.svelte";
import Surface from "./Surface.svelte";

/** Pass plain text content as Surface's `children` snippet from a .stories.ts. */
const content = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

const meta = {
	title: "UI/Surface",
	component: Surface,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { children: content("Surface") },
	argTypes: {
		variant: {
			control: "select",
			options: ["card", "inset", "floating", "plain"],
		},
		padding: {
			control: "inline-radio",
			options: ["none", "sm", "md", "lg"],
		},
		elevation: {
			control: "inline-radio",
			options: ["none", "menu", "panel", "modal"],
		},
	},
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every visual variant, rendered in flow. */
export const Variants: Story = {
	render: () => ({
		Component: SurfaceStoryGallery,
		props: { axis: "variants", children: content("Surface") },
	}),
};

/** Every padding and elevation combination, rendered in flow. */
export const PaddingAndElevation: Story = {
	render: () => ({
		Component: SurfaceStoryGallery,
		props: {
			axis: "padding-elevation",
			children: content("Surface"),
		},
	}),
};

/** Asserting semantics: Surface is a div and preserves additive consumer classes. */
export const Semantics: Story = {
	args: {
		"data-testid": "surface-root",
		class: "story-surface",
		children: content("Surface content"),
	},
	play: async ({ canvasElement }) => {
		const surface = within(canvasElement).getByTestId("surface-root");
		await expect(surface.tagName).toBe("DIV");
		await expect(surface).toHaveClass("story-surface");
	},
};
