import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
	beginCreateTab,
	destroyAll,
	handlePtySnapshot,
	openPanel,
	renameTab,
	switchTab,
} from "../../stores/terminal.svelte.js";
import TerminalPanelHost from "./__fixtures__/TerminalPanelHost.svelte";

function resetTerminal() {
	destroyAll();
}

/** Inject fake tab entries (bypasses XTerm.js for visual testing).
 *  Rows go in the way the server sends them; the labels are set the way the
 *  user would set them. */
function setTabs(
	entries: Array<{
		ptyId: string;
		title: string;
		exited?: boolean;
		cwd?: string;
	}>,
	activeId?: string,
) {
	handlePtySnapshot(
		entries.map((e) => ({
			pty: {
				id: e.ptyId,
				title: e.title,
				command: "bash",
				cwd: e.cwd ?? "/repo",
				status: e.exited ? ("exited" as const) : ("running" as const),
				pid: 1000,
			},
			scrollback: "",
		})),
	);
	for (const e of entries) renameTab(e.ptyId, e.title);
	const active = activeId ?? entries[0]?.ptyId;
	if (active) switchTab(active);
	openPanel();
}

const meta = {
	title: "Terminal/TerminalPanel",
	component: TerminalPanelHost,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		resetTerminal();
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvasElement.ownerDocument.fonts.ready;
		await waitFor(() => {
			for (const control of [
				canvas.queryByTitle("New terminal", { exact: true }),
				canvas.getByRole("button", { name: "Decrease font size" }),
				canvas.getByRole("button", { name: "Increase font size" }),
				canvas.getByRole("button", { name: "Close terminal panel" }),
				canvas.queryByRole("button", { name: /^Keys$/ }),
				canvas.queryByRole("button", { name: "New terminal in folder" }),
			]) {
				if (!control) continue;
				const bounds = control.getBoundingClientRect();
				expect(bounds.left).toBeGreaterThanOrEqual(0);
				expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
			}
			const active = canvas.queryByRole("tab", { selected: true });
			if (active) {
				const list = canvas.getByRole("tablist", { name: "Terminal sessions" });
				const bounds = list.getBoundingClientRect();
				const selected = active.getBoundingClientRect();
				expect(selected.left).toBeGreaterThanOrEqual(bounds.left - 1);
				expect(selected.right).toBeLessThanOrEqual(bounds.right + 1);
			}
		});
	},
} satisfies Meta<typeof TerminalPanelHost>;

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

export const SessionWorktreeTerminals: Story = {
	beforeEach: () => {
		setTabs(
			[
				{ ptyId: "pty-main", title: "Existing terminal", cwd: "/repo" },
				{ ptyId: "pty-worktree", title: "New terminal", cwd: "/repo-worktree" },
			],
			"pty-worktree",
		);
	},
};

export const MultiFolderPickerClosed: Story = {
	tags: ["viewport-capture"],
	args: {
		folders: [
			{ root: "/workspace/web", label: "web" },
			{ root: "/workspace/api", label: "api" },
		],
	},
	beforeEach: () => {
		setTabs([{ ptyId: "pty-web", title: "Terminal", cwd: "/workspace/web" }]);
	},
};

export const MultiFolderPickerOpen: Story = {
	...MultiFolderPickerClosed,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		// The active tab focuses its terminal once the font loads. Open the menu
		// after that, or the late focus takes it back from the open menu.
		await waitFor(() =>
			expect(
				canvasElement.querySelector(".xterm-helper-textarea"),
			).toHaveFocus(),
		);
		await userEvent.click(
			canvas.getByRole("button", { name: "New terminal in folder" }),
		);
		await expect(
			body.getByRole("menu", { name: "New terminal in folder" }),
		).toBeVisible();
		await expect(body.getByRole("menuitem", { name: "web" })).toBeVisible();
		await expect(body.getByRole("menuitem", { name: "api" })).toBeVisible();
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

/** The first terminal, while the server is still starting it. */
export const Starting: Story = {
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

export const Hover: Story = {
	...SingleTab,
	parameters: { pseudo: { hover: true } },
};

export const Disabled: Story = {
	...SingleTab,
	beforeEach: () => {
		localStorage.setItem("terminal-font-size", "6");
		setTabs([{ ptyId: "pty-001", title: "Terminal" }]);
		return () => localStorage.removeItem("terminal-font-size");
	},
};
