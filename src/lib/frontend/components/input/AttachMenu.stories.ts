import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, within } from "storybook/test";
import { handleModelInfo } from "../../stores/discovery.svelte.js";
import AttachMenu from "./AttachMenu.svelte";

const meta = {
	title: "Input/AttachMenu",
	component: AttachMenu,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	beforeEach: () => {
		handleModelInfo({ type: "model_info", model: "", provider: "opencode" });
	},
	args: {
		open: false,
		onCamera: fn(),
		onPhotos: fn(),
		onSetGoal: fn(),
	},
} satisfies Meta<typeof AttachMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Open: Story = {
	tags: ["viewport-capture"],
	args: { open: true },
};

export const Claude: Story = {
	tags: ["viewport-capture"],
	args: { open: true },
	beforeEach: () => {
		handleModelInfo({ type: "model_info", model: "", provider: "claude" });
	},
	play: async () => {
		const entry = within(document.body).getByTestId("attach-set-goal");
		await expect(entry).not.toHaveAttribute("aria-disabled", "true");
		await expect(entry).not.toHaveAttribute("data-disabled");
		await expect(entry).toHaveTextContent("Set goal");
	},
};

export const OpenCode: Story = {
	tags: ["viewport-capture"],
	args: { open: true },
	play: async () => {
		const entry = within(document.body).getByTestId("attach-set-goal");
		await expect(entry).toHaveAttribute("aria-disabled", "true");
		await expect(entry).toHaveAttribute("data-disabled");
		await expect(within(entry).getByText("Goal")).toBeVisible();
		await expect(within(entry).getByText("Claude only")).toBeVisible();
	},
};

export const Hover: Story = {
	...Open,
	// Storybook's indexer reads `tags` statically per export, so the spread above
	// does not carry Open's tag into the built index. Repeat it explicitly.
	tags: ["viewport-capture"],
	// `rootSelector: "body"` is load-bearing: since the move onto ui/Menu the
	// content portals out of #storybook-root, which is where the pseudo-states
	// addon starts walking, so a plain `hover: true` would reach nothing and this
	// frame would come out byte-identical to Open.
	parameters: { pseudo: { rootSelector: "body", hover: true } },
};
