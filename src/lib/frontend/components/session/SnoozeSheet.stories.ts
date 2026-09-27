import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import SnoozeSheet from "./SnoozeSheet.svelte";

const meta = {
	title: "Session/SnoozeSheet",
	component: SnoozeSheet,
	tags: ["autodocs"],
	args: {
		open: true,
		sessionTitle: "Review build logs",
		now: new Date(2030, 9, 7, 9).getTime(),
		onclose: fn(),
		onsnooze: fn(),
	},
} satisfies Meta<typeof SnoozeSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Morning: Story = {};
