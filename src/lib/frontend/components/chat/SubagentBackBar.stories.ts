import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { clearSessionState } from "../../stores/session.svelte.js";
import { mockSession, mockSubagentSession } from "../../stories/mocks.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type { SessionInfo } from "../../types.js";
import SubagentBackBar from "./SubagentBackBar.svelte";

let sequence = 0;

type Row = Pick<SessionInfo, "id" | "title"> & Partial<SessionInfo>;

function seedSessions(rows: readonly Row[]): void {
	const sessions: SessionInfo[] = rows.map((row) => ({
		accountId: null,
		status: "idle",
		projectSlug: "conduit",
		...row,
	}));
	applySessionChange({
		_tag: "snapshot",
		rows: sessions,
		sequence: ++sequence,
	});
	applySessionChange({ _tag: "synchronized" });
}

const resetSessions = () => {
	clearSessionState();
	openSessionForSetup(null);
};

const meta = {
	title: "Chat/SubagentBackBar",
	component: SubagentBackBar,
	tags: ["autodocs"],
	beforeEach: resetSessions,
} satisfies Meta<typeof SubagentBackBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	beforeEach: () => {
		seedSessions([mockSession, mockSubagentSession]);
		openSessionForSetup(mockSubagentSession.id, "conduit");
	},
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByRole("button", {
			name: /Parent/,
		});
		const glyph = canvasElement.querySelector(".session-status-glyph");
		expect(glyph).toBeVisible();
		expect(glyph?.getBoundingClientRect().width).toBe(12);
		expect(button).toHaveTextContent("Parent");
		expect(button).not.toHaveTextContent("PARENT");
		expect(button.getBoundingClientRect().height).toBe(28);
		const style = getComputedStyle(button);
		expect(Number.parseFloat(style.borderRadius)).toBeGreaterThanOrEqual(
			button.getBoundingClientRect().height / 2,
		);
		expect(style.fontFamily).not.toMatch(/mono/i);
		const expected = document.createElement("span").style;
		expected.color = style.getPropertyValue("--color-accent");
		expect(style.color).toBe(expected.color);
		expect(style.backgroundColor).not.toBe(expected.color);
		const hint = button.querySelector("kbd");
		if (!hint) throw new Error("Missing Esc hint");
		expect(hint).toHaveTextContent("Esc");
		expected.color = style.getPropertyValue("--color-text-dimmer");
		expect(getComputedStyle(hint).color).toBe(expected.color);
	},
};

export const MissingParent: Story = {
	beforeEach: () => {
		seedSessions([
			{
				...mockSubagentSession,
				id: "sess_story_missing_parent",
				parentID: "sess_story_unavailable_parent",
			},
		]);
		openSessionForSetup("sess_story_missing_parent", "conduit");
	},
	play: async ({ canvasElement }) => {
		const glyph = canvasElement.querySelector(".session-status-glyph");
		await expect(glyph).toHaveAttribute("data-state", "idle");
		await expect(glyph?.getBoundingClientRect().width).toBe(12);
	},
};

function seedSideThread(parentStatus: SessionInfo["status"] = "idle"): void {
	const sideThread = {
		...mockSubagentSession,
		id: "sess_story_side_thread",
		title: "Why did you choose this approach?",
		sideThread: true,
		forkMessageId: "msg_story_fork_point",
		forkPointTimestamp: 1,
	};
	seedSessions([
		{
			...mockSession,
			status: parentStatus,
			attention: parentStatus === "busy" ? "working" : "idle",
		},
		{ ...sideThread, status: "busy" },
	]);
	openSessionForSetup(sideThread.id, "conduit");
}

export const SideThread: Story = {
	beforeEach: () => seedSideThread(),
};

export const SideThreadParentWorking: Story = {
	beforeEach: () => seedSideThread("busy"),
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
