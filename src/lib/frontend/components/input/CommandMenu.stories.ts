import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
import { menuOpensUpwardFrame } from "../../stories/frames";
import type { CommandInfo } from "../../types.js";
import CommandMenu from "./CommandMenu.svelte";

const mockCommands: CommandInfo[] = [
	{ name: "bug", description: "Report a bug or issue", args: "<description>" },
	{
		name: "compact",
		description: "Compact conversation history to save context",
	},
	{
		name: "config",
		description: "View or modify configuration",
		args: "<key> [value]",
	},
	{ name: "cost", description: "Show token usage and cost summary" },
	{ name: "clear", description: "Clear the conversation" },
	{
		name: "doctor",
		description: "Run diagnostics to check for common issues",
	},
	{ name: "help", description: "Show available commands" },
	{ name: "init", description: "Initialize a new CLAUDE.md file" },
	{
		name: "login",
		description: "Authenticate with your Anthropic account",
	},
	{ name: "logout", description: "Sign out of your account" },
	{
		name: "model",
		description: "Switch the AI model",
		args: "<model-name>",
	},
	{
		name: "permissions",
		description: "View or modify tool permissions",
	},
	{ name: "review", description: "Review a pull request", args: "<pr-url>" },
	{ name: "status", description: "Show session status and statistics" },
	{ name: "vim", description: "Toggle vim mode for input" },
];

const noopSelect = (_command: string) => {};
const noopClose = () => {};

const meta = {
	title: "Input/CommandMenu",
	component: CommandMenu,
	tags: ["autodocs"],
	parameters: {
		layout: "padded",
	},
	// Standalone stories render without InputArea, which owns the textarea that
	// points `aria-controls` here. A fixed id keeps the listbox named and stable.
	args: {
		listboxId: "command-menu-listbox",
	},
	// This menu opens upward (`absolute bottom-full`), so without a positioned
	// ancestor it renders above the viewport and the capture is a blank page.
	// See conduit-test-7jv.
	beforeEach: () => menuOpensUpwardFrame(),
} satisfies Meta<typeof CommandMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
	args: {
		query: "",
		visible: true,
		commands: mockCommands,
		onSelect: noopSelect,
		onClose: noopClose,
	},
};

export const Filtered: Story = {
	args: {
		query: "co",
		visible: true,
		commands: mockCommands,
		onSelect: noopSelect,
		onClose: noopClose,
	},
};

export const Empty: Story = {
	args: {
		query: "zzz",
		visible: true,
		commands: mockCommands,
		onSelect: noopSelect,
		onClose: noopClose,
	},
	// This baseline is a BLANK image, and that is the assertion: `isVisible` is
	// `visible && entries.length > 0`, so with no matches the menu renders
	// nothing at all. A blank PNG compares equal to any other blank PNG, so the
	// pixels alone would still pass if the component started rendering the wrong
	// thing off-screen — this play() is what makes the emptiness meaningful.
	// (The component does contain "no results" markup, but it is unreachable in
	// every state; see conduit-test-7jv.)
	play: ({ canvasElement }) => {
		expect(canvasElement.querySelector('[role="listbox"]')).toBeNull();
	},
};

export const SingleResult: Story = {
	args: {
		query: "bug",
		visible: true,
		commands: mockCommands,
		onSelect: noopSelect,
		onClose: noopClose,
	},
};
