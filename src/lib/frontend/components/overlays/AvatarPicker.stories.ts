import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { avatarState } from "../../stores/avatar.svelte.js";
import {
	type AvatarStoryKind,
	prepareAvatarStory,
} from "../../stories/avatar.js";
import { failRpc } from "../../stories/sockets.js";
import AvatarStory from "../ui/__fixtures__/AvatarStory.svelte";

const meta = {
	title: "Overlays/AvatarPicker",
	component: AvatarStory,
	tags: ["autodocs", "viewport-capture"],
	parameters: { docs: { story: { inline: false } } },
	args: { scene: "picker", kind: "initial" },
	beforeEach: ({ args }) => prepareAvatarStory(args.kind),
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByTestId("avatar-change"));
		await expect(body.getByTestId("avatar-picker")).toBeVisible();
		await Promise.all(
			[...body.getByTestId("avatar-picker").querySelectorAll("img")].map(
				(image) => image.decode(),
			),
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

export const CancelKeepsAvatar: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByTestId("avatar-change"));
		await userEvent.click(body.getByRole("radio", { name: "Preset" }));
		await userEvent.click(body.getByRole("radio", { name: "Whale" }));
		await expect(
			within(body.getByTestId("avatar-preview")).getByTestId("user-avatar"),
		).toHaveAttribute("data-kind", "preset");
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(body.queryByTestId("avatar-picker")).not.toBeInTheDocument(),
		);
		await expect(avatarState.current.choice).toEqual({ kind: "initial" });
	},
};
export const SaveShape: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByTestId("avatar-change"));
		await userEvent.click(body.getByRole("radio", { name: "Shape" }));
		await userEvent.click(body.getByRole("radio", { name: "Shape 4" }));
		await userEvent.click(body.getByRole("button", { name: "Done" }));
		await waitFor(() =>
			expect(avatarState.current.choice).toEqual({ kind: "shape", seed: 4 }),
		);
		await waitFor(() =>
			expect(body.queryByTestId("avatar-picker")).not.toBeInTheDocument(),
		);
	},
};
export const SaveFailure: Story = {
	beforeEach: () => {
		const restore = prepareAvatarStory();
		const restoreFailure = failRpc("SetAvatar");
		return () => {
			restoreFailure();
			restore();
		};
	},
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByTestId("avatar-change"));
		await userEvent.click(body.getByRole("button", { name: "Done" }));
		await expect(await body.findByRole("alert")).toHaveTextContent(
			"Couldn't save your avatar",
		);
		await expect(body.getByTestId("avatar-picker")).toBeVisible();
	},
};
export const SaveFailureLight: Story = {
	...SaveFailure,
	globals: { theme: "light" },
};
