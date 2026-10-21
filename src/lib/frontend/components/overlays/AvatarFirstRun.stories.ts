import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	type AvatarStoryKind,
	prepareAvatarStory,
} from "../../stories/avatar.js";
import AvatarStory from "../ui/__fixtures__/AvatarStory.svelte";

const meta = {
	title: "Overlays/AvatarFirstRun",
	component: AvatarStory,
	tags: ["autodocs", "viewport-capture"],
	parameters: { docs: { story: { inline: false } } },
	args: { scene: "first-run", kind: "initial" },
	beforeEach: ({ args }) => prepareAvatarStory(args.kind, true),
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByTestId(
			"avatar-first-run",
		);
		await expect(dialog).toBeVisible();
		await Promise.all(
			[...dialog.querySelectorAll("img")].map((image) => image.decode()),
		);
	},
} satisfies Meta<{
	scene?: "chat" | "picker" | "first-run";
	kind?: AvatarStoryKind;
}>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Initial: Story = {};
export const InitialLight: Story = { globals: { theme: "light" } };
export const MacPicture: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByRole("radio", { name: "Mac picture" }));
		await expect(
			body.getByRole("radio", { name: "Mac picture" }),
		).toBeChecked();
	},
};
export const MacPictureLight: Story = {
	...MacPicture,
	globals: { theme: "light" },
};
export const WithoutMacPicture: Story = { args: { kind: "missing-mac" } };
export const WithoutMacPictureLight: Story = {
	...WithoutMacPicture,
	globals: { theme: "light" },
};
export const Preset: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByRole("radio", { name: "Preset" }));
		await expect(
			body
				.getAllByRole("radio", { name: "Fox" })
				.some((radio) => radio.checkVisibility()),
		).toBe(true);
	},
};
export const PresetLight: Story = { ...Preset, globals: { theme: "light" } };
export const Shape: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByRole("radio", { name: "Shape" }));
		await expect(body.getByRole("radio", { name: "Shape" })).toBeChecked();
		await expect(
			body.getByRole("group", { name: "Generated shapes" }),
		).toBeVisible();
		await expect(
			body
				.getAllByRole("button", { name: "Shuffle" })
				.some((button) => button.checkVisibility()),
		).toBe(true);
	},
};
export const ShapeLight: Story = { ...Shape, globals: { theme: "light" } };
