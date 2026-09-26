import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
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
		// Regex, not an exact string: since conduit-test-de3.35.9.3 the name
		// carries the session title, because a screen reader hears this same
		// control once per row and "More options" alone identifies nothing.
		await userEvent.click(
			within(canvasElement).getByRole("button", { name: /^More options for / }),
		);
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
