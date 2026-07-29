import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import BadgeStoryGallery from "./__fixtures__/BadgeStoryGallery.svelte";
import Badge from "./Badge.svelte";

/** Pass a plain text label as Badge's `children` snippet from a .stories.ts. */
const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

const meta = {
	title: "UI/Badge",
	component: Badge,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { children: label("Badge") },
	argTypes: {
		variant: {
			control: "inline-radio",
			options: ["neutral", "accent", "success"],
		},
		size: { control: "inline-radio", options: ["xs", "sm"] },
	},
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every variant and size combination, rendered in flow. */
export const VariantsAndSizes: Story = {
	render: () => ({ Component: BadgeStoryGallery }),
};

/** Asserting semantics: Badge is a span and renders its snippet text. */
export const Semantics: Story = {
	args: {
		"data-testid": "badge-root",
		children: label("Connected clients"),
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("badge-root");
		await expect(badge.tagName).toBe("SPAN");
		await expect(badge).toHaveTextContent("Connected clients");
	},
};
