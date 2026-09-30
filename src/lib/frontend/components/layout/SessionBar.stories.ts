import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { tick } from "svelte";
import { instanceState } from "../../stores/instance.svelte.js";
import {
	dispatch,
	resetNotifState,
} from "../../stores/notification-reducer.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../stores/router.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import {
	noteReadStateChanged,
	noteSessionOpened,
} from "../../stores/session-unread-hold.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import {
	handlePtyOutput,
	openPanel,
	terminalState,
} from "../../stores/terminal.svelte.js";
import { mockSession, mockSessionLongTitle } from "../../stories/mocks.js";
import type { OpenCodeInstance } from "../../types.js";
import SessionBarPhoneFrame from "./__fixtures__/SessionBarPhoneFrame.svelte";

// Rendered through a phone-width frame; see the fixture for why.
const meta = {
	title: "Layout/SessionBar",
	component: SessionBarPhoneFrame,
	tags: ["autodocs"],
	// `a11y.test` is "todo" globally, which only warns. The bar is the entire
	// chrome of a phone session, so an axe regression here has nowhere else to
	// be caught: gate it.
	parameters: { layout: "fullscreen", a11y: { test: "error" } },
	beforeEach: () => {
		noteSessionOpened("__storybook_reset__");
		resetNotifState();
		// Storybook shares module-level stores across stories.
		instanceState.instances = [];
		routerState.path = `/s/${mockSession.id}`;
		routerState.search = "";
		attachedProjectState.slug = "conduit";
		projectState.projects = [
			{ slug: "conduit", title: "conduit", directory: "/src/conduit" },
		];
		sessionState.familySessions = [mockSession, mockSessionLongTitle];
		sessionState.rootSessions = sessionState.familySessions;
		sessionState.currentId = mockSession.id;
		// The bar reads its collapse rule from this store, and Storybook shares
		// module-level state across story files. Pin the expanded state so only
		// the story that wants the collapse gets it.
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.forcedOpen = true;
		sessionViewState.filesOpen = false;
		sessionViewState.filesEverOpened = false;
		terminalState.panelOpen = false;
		terminalState.unreadPtyIds = new Set();
		return () => {
			attachedProjectState.slug = null;
		};
	},
} satisfies Meta<typeof SessionBarPhoneFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);

		// The back control is the only way off this screen on a phone, so its
		// accessible name and its wiring are both worth pinning.
		const back = canvas.getByRole("button", { name: /Sessions/ });
		await userEvent.click(back);
		expect(routerState.path).toBe("/");

		expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
			"Test Session",
		);
		expect(canvas.getByTestId("session-bar-identity")).toHaveTextContent(
			"conduit",
		);
		expect(canvas.queryByTestId("session-bar-attention")).toBeNull();
		expect(canvas.getByTestId("session-bar-title-menu")).toBeVisible();
		expect(canvas.getByTestId("session-bar-views-button")).toBeVisible();
		expect(canvas.queryByTestId("session-bar-overflow")).toBeNull();
		expect(canvas.queryByTestId("session-bar-views")).toBeNull();
		expect(canvas.queryByTestId("instance-badge")).toBeNull();
	},
};

export const ViewsSheetOpen: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-views-button"));
		const sheet = await within(document.body).findByTestId(
			"session-bar-views-sheet",
		);
		await expect(sheet).toBeVisible();
		// Accessible names, in order: the shortcut hints are aria-hidden.
		const items = ["Chat", "Terminal", "Diff", "Files"].map((name) =>
			within(sheet).getByRole("menuitemradio", { name }),
		);
		expect(within(sheet).getAllByRole("menuitemradio")).toEqual(items);
		await expect(items[0]).toHaveAttribute("aria-checked", "true");
		await expect(items[2]).toHaveAttribute("aria-disabled", "true");
	},
};

function emitOutputFromTwoTerminals() {
	handlePtyOutput({ type: "pty_output", ptyId: "pty-1", data: "one" });
	handlePtyOutput({ type: "pty_output", ptyId: "pty-1", data: "two" });
	handlePtyOutput({ type: "pty_output", ptyId: "pty-2", data: "three" });
}

export const WithViewBadge: Story = {
	beforeEach: emitOutputFromTwoTerminals,
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId(
			"session-bar-views-button",
		);
		await expect(button).toHaveTextContent("2");
	},
};

export const OpeningTerminalClearsBadge: Story = {
	tags: ["viewport-capture"],
	beforeEach: emitOutputFromTwoTerminals,
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId(
			"session-bar-views-button",
		);
		await expect(button).toHaveTextContent("2");
		openPanel();
		await tick();
		await expect(button).not.toHaveTextContent("2");
		await userEvent.click(button);
		const sheet = await within(document.body).findByTestId(
			"session-bar-views-sheet",
		);
		await expect(
			within(sheet).getByTestId("session-bar-view-terminal"),
		).toHaveAttribute("aria-checked", "true");
		expect(terminalState.unreadPtyIds.size).toBe(0);
	},
};

function showState(overrides: Partial<typeof mockSession>) {
	const session = { ...mockSession, ...overrides };
	sessionState.familySessions = [session];
	sessionState.rootSessions = [session];
	sessionState.currentId = session.id;
}

export const Settled: Story = {
	beforeEach: () => showState({ settledAt: Date.now() - 3_600_000 }),
};

export const AutoSettled: Story = {
	beforeEach: () =>
		showState({
			settledAt: Date.now() - 3_600_000,
			settledAutomatically: true,
		}),
};

export const Snoozed: Story = {
	beforeEach: () =>
		showState({ snoozedAt: Date.now(), snoozedUntil: Date.now() + 3_600_000 }),
};

export const Woke: Story = {
	beforeEach: () => showState({ wokenAt: Date.now(), wokeBecause: "error" }),
};

export const AutoSettledCollapsed: Story = {
	beforeEach: () => {
		showState({
			settledAt: Date.now() - 3_600_000,
			settledAutomatically: true,
		});
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.forcedOpen = false;
	},
};

export const NeedsAttention: Story = {
	beforeEach: () => {
		// Attention elsewhere, deliberately not in the open session: the badge
		// counts what the back control would take you to, not what you can see.
		dispatch({ type: "question_appeared", sessionId: "sess_other_a" });
		dispatch({ type: "permission_appeared", sessionId: "sess_other_b" });
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		expect(canvas.getByTestId("session-bar-attention")).toHaveTextContent("2");
	},
};

export const LongTitle: Story = {
	beforeEach: () => {
		sessionState.currentId = mockSessionLongTitle.id;
		routerState.path = `/s/${mockSessionLongTitle.id}`;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const label = within(canvas.getByTestId("session-bar-title")).getByText(
			/Investigate memory leak/,
		);
		// Asserting the ellipsis actually happens, not just that `truncate` is in
		// the class list: a flex parent without `min-w-0` renders the same classes
		// and still overflows.
		expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
	},
};

/**
 * 320px is the narrowest viewport the bar has to survive. Both of the design's
 * shrink rules are contested here: the title stays above its 110px floor while
 * still ellipsing, and the identity gives way rather than squeezing the back
 * control, which is the only way off the screen.
 */
export const NarrowestPhone: Story = {
	args: { width: 320 },
	beforeEach: () => {
		sessionState.currentId = mockSessionLongTitle.id;
		routerState.path = `/s/${mockSessionLongTitle.id}`;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);

		const back = canvas.getByRole("button", { name: /Sessions/ });
		const label = within(canvas.getByTestId("session-bar-title")).getByText(
			/Investigate memory leak/,
		);

		expect(label.clientWidth).toBeGreaterThanOrEqual(110);
		expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
		// Bounded first, and never shrunk: the back control still renders at its
		// full intrinsic width at the narrowest width in support.
		expect(back.scrollWidth).toBe(back.clientWidth);
	},
};

// Two instances minimum: the badge is a picker, and a picker with one option is
// noise.
const mockInstances: OpenCodeInstance[] = [
	{
		id: "inst-personal",
		name: "Personal",
		port: 4096,
		managed: true,
		status: "healthy",
		restartCount: 0,
		createdAt: 0,
	},
	{
		id: "inst-work",
		name: "Work",
		port: 4097,
		managed: true,
		status: "unhealthy",
		restartCount: 1,
		createdAt: 0,
	},
];

/**
 * The instance badge stays in the bar rather than moving into a menu
 * menu: it says where this project's work runs, which is identity, and a status
 * dot that only exists behind a closed menu reports nothing.
 */
export const WithInstanceBadge: Story = {
	beforeEach: () => {
		instanceState.instances = [...mockInstances];
		projectState.projects = [
			{
				slug: "conduit",
				title: "conduit",
				directory: "/src/conduit",
				instanceId: "inst-personal",
			},
		];
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const badge = canvas.getByTestId("instance-badge");
		await expect(badge).toHaveTextContent("Personal");
		// The back control is still whole with identity, badge and overflow all
		// competing for a 393px row.
		const back = canvas.getByRole("button", { name: /Sessions/ });
		expect(back.scrollWidth).toBe(back.clientWidth);
	},
};

/**
 * The collapsed bar keeps its overflow while the expanded bar uses the title
 * and Views sheets.
 */
export const OverflowMenuOpen: Story = {
	args: { island: true },
	// The menu portals to <body>, so the capture has to frame the page.
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.forcedOpen = false;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-island-overflow"));

		const menu = await within(document.body).findByTestId(
			"session-bar-island-menu",
		);
		for (const name of ["Chat", "Terminal", "Diff", "Files"]) {
			await expect(
				within(menu).getByRole("menuitemradio", { name }),
			).toBeVisible();
		}
		await expect(within(menu).getByTestId("session-ctx-snooze")).toBeVisible();
		await expect(within(menu).getByTestId("session-ctx-delete")).toBeVisible();
		for (const name of ["Share", "Settings"])
			await expect(within(menu).getByRole("menuitem", { name })).toBeVisible();
		await expect(menu).toHaveClass(/bottom-0/);
		await expect(
			within(menu).getByRole("menuitemradio", { name: "Chat" }),
		).toHaveAttribute("aria-checked", "true");
		// Debug is behind its feature flag.
		expect(within(menu).queryByTestId("overflow-debug")).toBeNull();
	},
};

export const TitleChevronSheet: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-title-menu"));
		const menu = await within(document.body).findByTestId(
			"session-action-sheet",
		);
		await expect(menu).toHaveClass(/bottom-0/);
		await expect(within(menu).getByTestId("session-ctx-settle")).toBeVisible();
		await expect(within(menu).getByTestId("session-title-share")).toBeVisible();
	},
};

/**
 * The bar at the bottom of the transcript: one 46px row carrying back, the
 * name, the way to get the bar back, and the overflow. Mode glyphs are exactly
 * what you should not have to decode at the moment the bar is smallest, so the
 * view switcher is not duplicated here.
 */
export const Collapsed: Story = {
	args: { island: true },
	beforeEach: () => {
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.forcedOpen = false;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("session-bar");

		// The collapsed row's height and its touch targets are literal geometry
		// from the design, so they are measured rather than inferred from class
		// names: `min-h-[44px]` and a 46px row are both claims about pixels.
		expect(bar.getBoundingClientRect().height).toBe(46);
		for (const id of ["session-bar-expand", "session-bar-island-overflow"]) {
			const box = canvas.getByTestId(id).getBoundingClientRect();
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(box.width).toBeGreaterThanOrEqual(44);
		}

		// The title moved up into the row rather than being replaced: same
		// heading element, so there is still exactly one h1 across the collapse.
		const heading = canvas.getByRole("heading", { level: 1 });
		expect(heading).toHaveTextContent("Test Session");
		expect(heading.getBoundingClientRect().top).toBeLessThan(
			bar.getBoundingClientRect().bottom,
		);

		// Where you are shrinks to the name alone: the identity and the instance
		// badge are both out of the smallest row.
		expect(canvas.queryByTestId("session-bar-identity")).not.toBeVisible();

		// The word goes but the accessible name does not — this is the only way
		// off the screen.
		const back = canvas.getByRole("button", { name: /Sessions/ });
		expect(back.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
	},
};

/**
 * Pressing the chevron expands the bar. It also unmounts the chevron, so this
 * pins where focus lands: on the named region, which announces as a state
 * change rather than as the control the user just pressed disappearing.
 */
export const ExpandedByChevron: Story = {
	beforeEach: () => {
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.forcedOpen = false;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-expand"));

		expect(canvas.queryByTestId("session-bar-expand")).toBeNull();
		expect(canvas.getByTestId("session-bar-identity")).toBeVisible();
		expect(canvas.getByTestId("session-bar")).toHaveFocus();
		// Still at the bottom: the chevron overrides the rule, it does not move
		// the transcript.
		expect(sessionViewState.atBottom).toBe(true);
	},
};

export const DesktopGitIdentity: Story = {
	args: { width: 900 },
	beforeEach: () => {
		sessionViewState.compact = false;
		projectState.projects = [
			{
				slug: "conduit",
				title: "conduit",
				directory: "/src/conduit",
				git: { branch: "feature/17xt", worktree: "linked-15", dirty: true },
			},
		];
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("session-bar");
		await expect(bar).toHaveAttribute("data-compact", "false");
		await expect(canvas.getByTestId("session-bar-identity")).toHaveTextContent(
			/conduit.*feature\/17xt.*linked-15/,
		);
		await expect(canvas.getByTitle("Uncommitted changes")).toBeVisible();
		await expect(canvas.getByTestId("session-bar-settle")).toBeVisible();
		await expect(canvas.getByTestId("session-bar-overflow")).toBeVisible();
	},
};

export const DesktopLongTitleNarrow: Story = {
	args: { width: 480 },
	beforeEach: () => {
		sessionViewState.compact = false;
		sessionState.currentId = mockSessionLongTitle.id;
		routerState.path = `/s/${mockSessionLongTitle.id}`;
	},
	play: async ({ canvasElement }) => {
		const bar = within(canvasElement).getByTestId("session-bar");
		const title = within(bar).getByTestId("session-bar-title");
		const label = title.querySelector("span");
		expect(title.clientWidth).toBeGreaterThanOrEqual(110);
		expect(label?.scrollWidth).toBeGreaterThan(label?.clientWidth ?? 0);
		expect(bar.scrollWidth).toBe(bar.clientWidth);
	},
};

export const DesktopSettled: Story = {
	args: { width: 900 },
	beforeEach: () => {
		sessionViewState.compact = false;
		showState({ settledAt: Date.now() - 3_600_000 });
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-bar-state-chip")).toHaveAttribute(
			"data-state",
			"settled",
		);
		await expect(canvas.getByTestId("session-bar-settle")).toHaveTextContent(
			"Un-settle",
		);
	},
};

export const DesktopNoSession: Story = {
	args: { width: 900 },
	beforeEach: () => {
		sessionViewState.compact = false;
		sessionState.currentId = null;
		routerState.path = "/";
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-bar-identity")).toBeVisible();
		await expect(canvas.getByTestId("session-bar-overflow")).toBeVisible();
		expect(canvas.queryByTestId("session-bar-title")).toBeNull();
		expect(canvas.queryByTestId("session-bar-settle")).toBeNull();
	},
};

export const DesktopUnread: Story = {
	args: { width: 900 },
	beforeEach: () => {
		sessionViewState.compact = false;
		const session = { ...mockSession, unread: true };
		showState(session);
		noteReadStateChanged(session, true);
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("session-bar-unread-chip"),
		).toBeVisible();
	},
};

export const DesktopUnreadAndSettled: Story = {
	args: { width: 900 },
	beforeEach: () => {
		sessionViewState.compact = false;
		const session = {
			...mockSession,
			unread: true,
			settledAt: Date.now() - 3_600_000,
		};
		showState(session);
		noteReadStateChanged(session, true);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-bar-unread-chip")).toBeVisible();
		await expect(canvas.getByTestId("session-bar-state-chip")).toBeVisible();
	},
};
