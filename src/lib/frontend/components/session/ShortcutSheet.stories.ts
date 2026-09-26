import type { Meta, StoryObj } from "@storybook/svelte-vite";
import ShortcutSheet from "./ShortcutSheet.svelte";

const meta = {
	title: "Session/ShortcutSheet",
	component: ShortcutSheet,
	tags: ["autodocs", "viewport-capture"],
	args: { open: true, onclose: () => {} },
} satisfies Meta<typeof ShortcutSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
