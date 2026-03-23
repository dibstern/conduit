import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { destroyAll, terminalState } from "../../stores/terminal.svelte.js";
import TerminalPanel from "./TerminalPanel.svelte";

function resetTerminal() {
	destroyAll();
}

/** Inject fake tab entries (bypasses XTerm.js for visual testing). */
function setTabs(
	entries: Array<{ ptyId: string; title: string; exited?: boolean }>,
	activeId?: string,
) {
	const tabs = new Map<
		string,
		{ ptyId: string; title: string; exited: boolean }
	>();
	for (const e of entries) {
		tabs.set(e.ptyId, {
			ptyId: e.ptyId,
			title: e.title,
			exited: e.exited ?? false,
		});
	}
	terminalState.tabs = tabs;
	terminalState.activeTabId = activeId ?? entries[0]?.ptyId ?? null;
	terminalState.panelOpen = true;
}

const meta = {
	title: "Terminal/TerminalPanel",
	component: TerminalPanel,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		resetTerminal();
	},
} satisfies Meta<typeof TerminalPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
	play: () => {
		resetTerminal();
		terminalState.panelOpen = true;
	},
};

export const SingleTab: Story = {
	play: () => {
		resetTerminal();
		setTabs([{ ptyId: "pty-001", title: "Terminal" }]);
	},
};

export const MultipleTabs: Story = {
	play: () => {
		resetTerminal();
		setTabs(
			[
				{ ptyId: "pty-001", title: "build" },
				{ ptyId: "pty-002", title: "test runner" },
				{ ptyId: "pty-003", title: "dev server" },
			],
			"pty-002",
		);
	},
};

export const TabExited: Story = {
	play: () => {
		resetTerminal();
		setTabs(
			[
				{ ptyId: "pty-001", title: "build", exited: true },
				{ ptyId: "pty-002", title: "Terminal" },
			],
			"pty-002",
		);
	},
};

export const WithStatusMessage: Story = {
	play: () => {
		resetTerminal();
		terminalState.panelOpen = true;
		terminalState.statusMessage = "Creating terminal...";
		terminalState.pendingCreate = true;
	},
};

export const MaxTabs: Story = {
	play: () => {
		resetTerminal();
		const entries = Array.from({ length: 10 }, (_, i) => ({
			ptyId: `pty-${String(i + 1).padStart(3, "0")}`,
			title: `Terminal ${i + 1}`,
		}));
		setTabs(entries, "pty-005");
	},
};
