import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fireEvent, fn, within } from "storybook/test";
import {
	mockForkSession,
	mockSession,
	mockSessionDoneUnread,
	mockSessionFailed,
	mockSessionIdle,
	mockSessionLongTitle,
	mockSessionNeedsApproval,
	mockSessionNeedsReply,
	mockSessionProcessing,
} from "../../stories/mocks.js";
import SessionItemWithContextMenu from "./__fixtures__/SessionItemWithContextMenu.svelte";
import SessionItem from "./SessionItem.svelte";

const meta = {
	title: "Session/SessionItem",
	component: SessionItem,
	tags: ["autodocs"],
	args: {
		oncontextmenu: fn(),
		onrename: fn(),
	},
} satisfies Meta<typeof SessionItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inactive: Story = {
	args: {
		session: mockSession,
		active: false,
	},
};

export const Active: Story = {
	args: {
		session: mockSession,
		active: true,
	},
};

export const Processing: Story = {
	args: {
		session: mockSessionProcessing,
		active: true,
	},
};

// A blocked approval shows its word and leads the row name with the spoken state.
export const NeedsApproval: Story = {
	args: {
		session: mockSessionNeedsApproval,
		active: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Approve")).toBeVisible();
		await expect(
			canvas.getByLabelText(/^Needs approval,/),
		).toHaveAccessibleName(/^Needs approval,/);
	},
};

// A waiting question shows its reply word and leads the row name with the spoken state.
export const NeedsReply: Story = {
	args: {
		session: mockSessionNeedsReply,
		active: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Reply")).toBeVisible();
		await expect(canvas.getByLabelText(/^Needs reply,/)).toHaveAccessibleName(
			/^Needs reply,/,
		);
	},
};

// A failed session shows its failure word and leads the row name with the spoken state.
export const Failed: Story = {
	args: {
		session: mockSessionFailed,
		active: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Failed")).toBeVisible();
		await expect(canvas.getByLabelText(/^Failed,/)).toHaveAccessibleName(
			/^Failed,/,
		);
	},
};

// A completed unread session shows Done and leads the row name with the spoken state.
export const DoneUnread: Story = {
	args: {
		session: mockSessionDoneUnread,
		active: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Done")).toBeVisible();
		await expect(canvas.getByLabelText(/^Done, unread,/)).toHaveAccessibleName(
			/^Done, unread,/,
		);
	},
};

// A quiet idle session has no visible status pill.
export const Idle: Story = {
	args: {
		session: mockSessionIdle,
		active: false,
	},
	play: async ({ canvasElement }) => {
		const row = within(canvasElement).getByLabelText(
			/^Plan documentation cleanup,/,
		);
		await expect(row.querySelector(".session-item-status")).toBeNull();
	},
};

export const LongTitle: Story = {
	args: {
		session: mockSessionLongTitle,
		active: false,
	},
};

// Project and branch share the second-line context slot.
export const WithBranch: Story = {
	args: {
		session: mockSession,
		active: false,
		projectLabel: "Conduit",
		branch: "main",
	},
};

// A pinned row appends the star glyph after its title.
export const Pinned: Story = {
	args: {
		session: mockSession,
		active: false,
		pinned: true,
	},
};

// A pinned fork keeps star and fork glyphs in their declared order.
export const PinnedAndForked: Story = {
	args: {
		session: mockForkSession,
		active: false,
		pinned: true,
	},
};

// A settled shelf row collapses context and uses its verbatim settled time.
export const Settled: Story = {
	args: {
		session: mockSession,
		active: false,
		projectLabel: "Conduit",
		settled: true,
		settledAt: "Mon 9:00",
	},
	play: async ({ canvasElement }) => {
		await expect(within(canvasElement).getByText("Mon 9:00")).toBeVisible();
	},
};

// A dense settled row uses the shortest declared shelf density.
export const SettledDense: Story = {
	args: {
		session: mockSession,
		active: false,
		settled: true,
		density: "dense",
	},
};

const WOKEN_STORY_NOW = new Date(2030, 9, 7, 9).getTime();
const wokenStory = (
	reason: "time" | "approval" | "question" | "error" | "turn",
): Story => ({
	args: {
		session: {
			id: `woken-${reason}`,
			title: `Woken by ${reason}`,
			attention: "idle",
			wokenAt: WOKEN_STORY_NOW,
			wokeBecause: reason,
		},
		now: WOKEN_STORY_NOW,
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("session-woke-pill"),
		).toBeVisible();
	},
});

export const WokenByTime: Story = wokenStory("time");
export const WokenByApproval: Story = wokenStory("approval");
export const WokenByQuestion: Story = wokenStory("question");
export const WokenByError: Story = wokenStory("error");
export const WokenByTurn: Story = wokenStory("turn");

// A dense row uses the compact two-line density.
export const Dense: Story = {
	args: {
		session: mockSession,
		active: false,
		projectLabel: "Conduit",
		density: "dense",
	},
};

export const WithContextMenu: Story = {
	// conduit-test-732b: SessionItem only emits a callback; the fixture renders its menu.
	render: (args) => ({ Component: SessionItemWithContextMenu, props: args }),
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		// Right-click, not the ⋯ button: since vik1.9 that button only exists on
		// real hover or focus at desktop width, and never on a phone.
		const row = canvasElement.querySelector<HTMLElement>(".session-item");
		if (!row) throw new Error("Session row is missing");
		await fireEvent.contextMenu(row);
		const body = within(canvasElement.ownerDocument.body);
		await expect(
			// menuitem, not button: since conduit-test-de3.35.4 the menu is
			// ui/Menu + ui/MenuItem, which render real menu roles.
			await body.findByRole("menuitem", { name: "Copy resume command" }),
			"More options must render the session context menu before capture",
		).toBeVisible();
	},
	args: {
		session: mockSession,
		active: false,
	},
};

export const Hover: Story = {
	...Inactive,
	parameters: { pseudo: { hover: true } },
};

export const HoverActions: Story = {
	name: "Hover actions",
	args: { session: mockSession, projectLabel: "Conduit", branch: "main" },
	parameters: { pseudo: { hover: true } },
};

export const SettledHoverActions: Story = {
	name: "Settled hover actions",
	args: {
		session: { ...mockSession, settledAt: 1 },
		settled: true,
		settledAt: "Mon 9:00",
		projectLabel: "Conduit",
	},
	parameters: { pseudo: { hover: true } },
};

export const SnoozedHoverActions: Story = {
	name: "Snoozed hover actions",
	args: {
		session: { ...mockSession, snoozedAt: 1 },
		snoozed: true,
		snoozedUntilText: "Tue 9:00",
		projectLabel: "Conduit",
	},
	parameters: { pseudo: { hover: true } },
};

function dragStory(
	direction: 1 | -1,
	fraction: number,
): NonNullable<Story["play"]> {
	return async ({ canvasElement }) => {
		const row = canvasElement.querySelector<HTMLAnchorElement>(".session-item");
		if (!row) throw new Error("Session row is missing");
		if (row.parentElement) row.parentElement.style.width = "300px";
		const startX = row.getBoundingClientRect().left + 20;
		const startY = row.getBoundingClientRect().top + 20;
		row.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerType: "touch",
				pointerId: 1,
				clientX: startX,
				clientY: startY,
			}),
		);
		window.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				pointerType: "touch",
				pointerId: 1,
				clientX:
					startX + direction * row.getBoundingClientRect().width * fraction,
				clientY: startY,
			}),
		);
		await expect(
			await within(canvasElement).findByTestId("session-swipe-action"),
		).toHaveAttribute("data-stage", fraction >= 0.55 ? "commit" : "reveal");
	};
}

export const MidSwipeSettle: Story = {
	name: "Mid-swipe settle",
	// A row swipes only when it has actions, which oncontextmenu signals.
	args: { session: mockSessionDoneUnread, onsettle: fn(), oncontextmenu: fn() },
	play: dragStory(1, 0.35),
};

export const MidSwipeSnooze: Story = {
	name: "Mid-swipe snooze",
	args: { session: mockSessionIdle, onsnooze: fn(), oncontextmenu: fn() },
	play: dragStory(-1, 0.35),
};

export const SwipeArmedToCommit: Story = {
	name: "Swipe armed to commit",
	args: { session: mockSessionDoneUnread, onsettle: fn(), oncontextmenu: fn() },
	play: dragStory(1, 0.65),
};

// The inline rename field had no baseline before conduit-test-de3.35.7, which
// is how it kept a bespoke recipe through three migration batches unnoticed.
export const Renaming: Story = {
	args: {
		session: mockSession,
		active: false,
		renaming: true,
	},
};

// Cleanup mode is the only state that renders the selection control, and it had
// no story at all -- which is how it kept a checkbox drawn entirely in glyphs,
// with no role and no checked state, through the whole migration
// (conduit-test-de3.35.9.3).
export const CleanupMode: Story = {
	args: {
		session: mockSession,
		active: false,
		cleanupMode: true,
	},
	play: async ({ canvasElement }) => {
		const box = within(canvasElement).getByRole("checkbox");
		await expect(box).toHaveAttribute("aria-checked", "false");
		await expect(box).toHaveAccessibleName(`Select ${mockSession.title}`);
	},
};

export const CleanupModeSelected: Story = {
	args: {
		session: mockSession,
		active: false,
		cleanupMode: true,
		selected: true,
	},
	play: async ({ canvasElement }) => {
		await expect(within(canvasElement).getByRole("checkbox")).toHaveAttribute(
			"aria-checked",
			"true",
		);
	},
};
