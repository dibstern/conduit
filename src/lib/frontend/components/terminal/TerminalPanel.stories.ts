import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	beginCreateTab,
	destroyAll,
	handlePtyList,
	openPanel,
	renameTab,
	switchTab,
} from "../../stores/terminal.svelte.js";
import TerminalPanel from "./TerminalPanel.svelte";

function resetTerminal() {
	destroyAll();
}

/** Inject fake tab entries (bypasses XTerm.js for visual testing).
 *  Rows go in the way the server sends them; the labels are set the way the
 *  user would set them. */
function setTabs(
	entries: Array<{ ptyId: string; title: string; exited?: boolean }>,
	activeId?: string,
) {
	handlePtyList({
		type: "pty_list",
		ptys: entries.map((e) => ({
			id: e.ptyId,
			title: e.title,
			command: "bash",
			cwd: "/repo",
			status: e.exited ? ("exited" as const) : ("running" as const),
			pid: 1000,
		})),
	});
	for (const e of entries) renameTab(e.ptyId, e.title);
	const active = activeId ?? entries[0]?.ptyId;
	if (active) switchTab(active);
	openPanel();
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
	beforeEach: () => {
		openPanel();
	},
};

export const SingleTab: Story = {
	beforeEach: () => {
		setTabs([{ ptyId: "pty-001", title: "Terminal" }]);
	},
};

export const MultipleTabs: Story = {
	beforeEach: () => {
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
	beforeEach: () => {
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
	beforeEach: () => {
		openPanel();
		beginCreateTab();
	},
};

export const MaxTabs: Story = {
	beforeEach: () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({
			ptyId: `pty-${String(i + 1).padStart(3, "0")}`,
			title: `Terminal ${i + 1}`,
		}));
		setTabs(entries, "pty-005");
	},
};
