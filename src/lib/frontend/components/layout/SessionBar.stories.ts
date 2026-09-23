import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
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
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
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
		resetNotifState();
		// Layout/Header seeds this same module-level store, and Storybook shares
		// it across story files. Reset or the badge appears in every story.
		instanceState.instances = [];
		uiState.mobileSidebarOpen = false;
		uiState.sidebarPanel = "files";
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
		sessionViewState.compact = false;
		sessionViewState.atBottom = true;
		sessionViewState.forcedOpen = true;
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
		expect(uiState.mobileSidebarOpen).toBe(true);
		expect(uiState.sidebarPanel).toBe("sessions");

		expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
			"Test Session",
		);
		expect(canvas.getByTestId("session-bar-identity")).toHaveTextContent(
			"conduit",
		);
		expect(canvas.queryByTestId("session-bar-attention")).toBeNull();
		// The overflow trigger is the only route to settings, share and the
		// terminal at this width, so its presence is not cosmetic.
		expect(canvas.getByTestId("session-bar-overflow")).toBeVisible();
		expect(canvas.queryByTestId("instance-badge")).toBeNull();
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
// noise. Mirrors Layout/Header's fixture so the two bars can be compared.
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
 * The instance badge stays in the bar rather than moving into the overflow
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
 * Everything the replaced global header used to offer. Without this menu those
 * actions have no route on a phone at all — the sidebar has never carried a
 * settings entry.
 */
export const OverflowMenuOpen: Story = {
	// The menu portals to <body>, so the capture has to frame the page.
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-overflow"));

		const menu = await within(document.body).findByTestId(
			"session-bar-overflow-menu",
		);
		for (const name of ["Terminal", "Share", "Settings"]) {
			await expect(within(menu).getByRole("menuitem", { name })).toBeVisible();
		}
		// Debug is behind its feature flag, as it is in the header.
		expect(within(menu).queryByTestId("overflow-debug")).toBeNull();
	},
};

/**
 * The bar at the bottom of the transcript: one 46px row carrying back, the
 * name, the way to get the bar back, and the overflow. Mode glyphs are exactly
 * what you should not have to decode at the moment the bar is smallest, so the
 * view switcher is not duplicated here.
 */
export const Collapsed: Story = {
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
		for (const id of ["session-bar-expand", "session-bar-overflow"]) {
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
		expect(back.getBoundingClientRect().width).toBeLessThan(44);
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
