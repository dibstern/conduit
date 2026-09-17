import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import AttachMenu from "./AttachMenu.svelte";

const meta = {
	title: "Input/AttachMenu",
	component: AttachMenu,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		open: false,
		onCamera: fn(),
		onPhotos: fn(),
	},
} satisfies Meta<typeof AttachMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Open: Story = {
	tags: ["viewport-capture"],
	args: { open: true },
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
