import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import {
	type AvatarStoryKind,
	prepareAvatarStory,
} from "../../stories/avatar.js";
import AvatarStory from "./__fixtures__/AvatarStory.svelte";

const meta = {
	title: "UI/UserAvatar",
	component: AvatarStory,
	tags: ["autodocs"],
	args: { kind: "initial" },
	beforeEach: ({ args }) => prepareAvatarStory(args.kind),
	play: async ({ canvasElement, args }) => {
		const drawing = within(canvasElement).getAllByTestId("user-avatar")[0];
		await expect(drawing).toHaveAttribute(
			"data-kind",
			args.kind === "initial" || args.kind === "missing-mac"
				? "letter"
				: args.kind === "mac"
					? "image"
					: (args.kind ?? "letter"),
		);
		await Promise.all(
			[...canvasElement.querySelectorAll("img")].map((image) => image.decode()),
		);
	},
} satisfies Meta<{
	scene?: "chat" | "picker" | "first-run";
	kind?: AvatarStoryKind;
}>;
export default meta;
type Story = StoryObj<typeof meta>;

// The visual runner captures every story on desktop and phone.
export const Initial: Story = {};
export const InitialLight: Story = { globals: { theme: "light" } };
export const MacPicture: Story = { args: { kind: "mac" } };
export const MacPictureLight: Story = {
	...MacPicture,
	globals: { theme: "light" },
};
export const Preset: Story = { args: { kind: "preset" } };
export const PresetLight: Story = { ...Preset, globals: { theme: "light" } };
export const Shape: Story = { args: { kind: "shape" } };
export const ShapeLight: Story = { ...Shape, globals: { theme: "light" } };
export const MissingMacPicture: Story = { args: { kind: "missing-mac" } };
export const MissingMacPictureLight: Story = {
	...MissingMacPicture,
	globals: { theme: "light" },
};
