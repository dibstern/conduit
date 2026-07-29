import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { destroyAll, handlePtyOutput } from "../../stores/terminal.svelte.js";
import { mockTerminalOutput } from "../../stories/mocks.js";
import TerminalTab from "./TerminalTab.svelte";

const PTY_ID = "pty-storybook-001";

const meta = {
	title: "Terminal/TerminalTab",
	component: TerminalTab,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	args: {
		ptyId: PTY_ID,
		active: true,
	},
	beforeEach: () => {
		destroyAll();
		return destroyAll;
	},
} satisfies Meta<typeof TerminalTab>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithOutput: Story = {
	beforeEach: () => {
		handlePtyOutput({
			type: "pty_output",
			ptyId: PTY_ID,
			data: mockTerminalOutput,
		});
	},
};

export const LargeFont: Story = {
	args: { fontSize: 18 },
	beforeEach: () => {
		handlePtyOutput({
			type: "pty_output",
			ptyId: PTY_ID,
			data: mockTerminalOutput,
		});
	},
};
