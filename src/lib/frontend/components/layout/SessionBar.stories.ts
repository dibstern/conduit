import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { tick } from "svelte";
import type { SessionGoalChangedPayload } from "../../../contracts/stored-event.js";
import {
	getOrCreateSessionActivity,
	phaseToIdle,
} from "../../stores/chat.svelte.js";
import {
	applyGetAgentsResponse,
	discoveryState,
	handleModelInfo,
} from "../../stores/discovery.svelte.js";
import {
	goalDetails,
	handleGoalChanged,
	sessionGoals,
} from "../../stores/goal.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../stores/session.svelte.js";
import { sessionSkillsState } from "../../stores/session-skills.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import {
	destroyAll,
	handlePtyOutput,
	openPanel,
	terminalState,
} from "../../stores/terminal.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { mockSession, mockSessionLongTitle } from "../../stories/mocks.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type {
	GoalDetails,
	getGoalDetailsRpc,
} from "../../transport/ws-rpc-client.js";
import type {
	BannerConfig,
	OpenCodeInstance,
	SessionInfo,
} from "../../types.js";
import { sideThreadsPanel } from "../session/side-threads.svelte.js";
import SessionBarPhoneFrame from "./__fixtures__/SessionBarPhoneFrame.svelte";

let sequence = 0;

type Row = Pick<SessionInfo, "id" | "title"> & Partial<SessionInfo>;

function seedSessions(rows: readonly Row[]): void {
	const sessions: SessionInfo[] = rows.map((row) => ({
		status: "idle",
		...row,
	}));
	applySessionChange({
		_tag: "snapshot",
		rows: sessions,
		sequence: ++sequence,
	});
	applySessionChange({ _tag: "synchronized" });
}

const goalCheckFixtures = [
	{ minutes: 8, reason: "29/38 pass. Three baselines are stale." },
	{ minutes: 19, reason: "33/38. Focus ring regressed." },
	{ minutes: 31, reason: "35/38. jump-to-live fails." },
	{ minutes: 36, reason: "38/38 once. Needs a second run." },
];

const getGoalDetails = fn<typeof getGoalDetailsRpc>(
	async ({ sessionId }): Promise<GoalDetails> => {
		const facts = sessionGoals.get(sessionId);
		const goal = facts?.goal ?? facts?.endedGoal;
		if (!goal) return { checks: [], tokensSinceStart: null };
		const count = facts?.ended === "met" ? 4 : Math.min(goal.iterations, 3);
		return {
			checks: goalCheckFixtures.slice(0, count).map((check, index) => ({
				iteration: index + 1,
				at: goal.setAt + check.minutes * 60_000,
				reason: check.reason,
			})),
			tokensSinceStart: goal.iterations === 0 ? 0 : 1_240_000,
		};
	},
);

// Rendered through a phone-width frame; see the fixture for why.
const meta = {
	title: "Layout/SessionBar",
	component: SessionBarPhoneFrame,
	tags: ["autodocs"],
	// `a11y.test` is "todo" globally, which only warns. The bar is the entire
	// chrome of a phone session, so an axe regression here has nowhere else to
	// be caught: gate it.
	parameters: { layout: "fullscreen", a11y: { test: "error" } },
	args: { getGoalDetails },
	beforeEach: () => {
		const detailsOpen = goalDetails.open;
		const now = sessionState.now;
		goalDetails.open = false;
		getGoalDetails.mockClear();
		clearSessionState();
		// Layout/Header seeds this same module-level store, and Storybook shares
		// it across story files. Reset or the badge appears in every story.
		instanceState.instances = [];
		routerState.path = `/s/${mockSession.id}`;
		routerState.search = "";
		attachedProjectState.slug = "conduit";
		projectState.projects = [
			{ slug: "conduit", title: "conduit", folders: ["/src/conduit"] },
		];
		seedSessions([mockSession, mockSessionLongTitle]);
		sessionState.currentId = mockSession.id;
		// The bar reads its collapse rule from this store, and Storybook shares
		// module-level state across story files. Pin the expanded state so only
		// the story that wants the collapse gets it.
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.forcedOpen = true;
		sessionViewState.filesOpen = false;
		sessionViewState.filesEverOpened = false;
		sessionSkillsState.sessionId = null;
		sessionSkillsState.loads = [];
		uiState.clientCount = 1;
		destroyAll();
		return () => {
			attachedProjectState.slug = null;
			goalDetails.open = detailsOpen;
			sessionState.now = now;
			getGoalDetails.mockClear();
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
		expect(canvas.getByTestId("session-bar-island-overflow")).toBeVisible();
		expect(canvas.queryByTestId("session-bar-overflow")).toBeNull();
		expect(canvas.queryByTestId("session-bar-views")).toBeNull();
		expect(canvas.queryByTestId("instance-badge")).toBeNull();
	},
};

// 30s of slack: each story bumps setAt by 1ms to stay unique, and under the
// pinned visual clock that drift would otherwise floor the age to 40m.
let goalStorySetAt = Date.now() - 41 * 60_000 - 30_000;

function setupGoal(
	state: "checking" | "not_yet" | "paused" | "met" | "cleared",
) {
	const previous = sessionGoals.get(mockSession.id);
	const model = discoveryState.currentModelId;
	const provider = discoveryState.currentProviderId;
	handleModelInfo({ model, provider: "claude" });
	phaseToIdle(getOrCreateSessionActivity(mockSession.id));
	goalStorySetAt = Math.max(
		goalStorySetAt + 1,
		Date.now() - 41 * 60_000 - 30_000,
	);
	const activeGoal = {
		condition: "All 38 scenarios pass",
		iterations: 2,
		setAt: goalStorySetAt,
		tokensAtStart: 0,
	};
	const facts: SessionGoalChangedPayload =
		state === "met" || state === "cleared"
			? {
					sessionId: mockSession.id,
					goal: null,
					ended: state,
					endedGoal: { ...activeGoal, iterations: 7 },
					endedAt: activeGoal.setAt + 41 * 60_000,
				}
			: {
					sessionId: mockSession.id,
					goal: {
						...activeGoal,
						...(state === "not_yet"
							? { lastReason: "35 of 38 scenarios pass" }
							: {}),
					},
					...(state === "paused"
						? { pausedReason: "Goal check interrupted" }
						: {}),
				};
	seedSessions([{ ...mockSession, status: "idle" }]);
	handleGoalChanged(facts);
	return () => {
		if (previous) handleGoalChanged(previous);
		else sessionGoals.delete(mockSession.id);
		handleModelInfo({ model, provider });
	};
}

async function assertGoalSubtitle(
	canvasElement: HTMLElement,
	text: string,
	token: string,
) {
	const subtitle = within(canvasElement).getByTestId("session-goal-subtitle");
	await expect(subtitle).toHaveTextContent(text);
	await expect(subtitle.querySelector("svg")).toBeVisible();
	const style = getComputedStyle(subtitle);
	const expected = new Option().style;
	// Tailwind publishes these theme tokens on the component's inherited style.
	expected.color = style.getPropertyValue(token);
	await expect(style.color).toBe(expected.color);
	return subtitle;
}

export const GoalChecking: Story = {
	beforeEach: () => setupGoal("checking"),
	play: async ({ canvasElement }) => {
		const subtitle = await assertGoalSubtitle(
			canvasElement,
			"Checking goal · check 3",
			"--color-status-violet",
		);
		const spinner = subtitle.querySelector("svg");
		if (!spinner) throw new Error("Checking spinner is missing");
		await expect(getComputedStyle(spinner).animationName).toBe("spin");
	},
};

export const GoalNotYet: Story = {
	beforeEach: () => setupGoal("not_yet"),
	play: async ({ canvasElement }) => {
		await assertGoalSubtitle(
			canvasElement,
			"All 38 scenarios pass · 2 checks",
			"--color-status-amber",
		);
	},
};

export const GoalPaused: Story = {
	beforeEach: () => setupGoal("paused"),
	play: async ({ canvasElement }) => {
		const subtitle = await assertGoalSubtitle(
			canvasElement,
			"Goal paused · All 38 scenarios pass",
			"--color-status-violet",
		);
		await expect(subtitle).toHaveAttribute(
			"title",
			expect.stringContaining("Goal check interrupted"),
		);
	},
};

export const GoalMet: Story = {
	beforeEach: () => setupGoal("met"),
	play: async ({ canvasElement }) => {
		await assertGoalSubtitle(
			canvasElement,
			"Goal met · 7 checks · 41m",
			"--color-status-green",
		);
	},
};

export const GoalCleared: Story = {
	beforeEach: () => setupGoal("cleared"),
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).queryByTestId("session-goal-subtitle"),
		).not.toBeInTheDocument();
	},
};

export const GoalCheckingLight: Story = {
	...GoalChecking,
	globals: { theme: "light" },
};
export const GoalNotYetLight: Story = {
	...GoalNotYet,
	globals: { theme: "light" },
};
export const GoalPausedLight: Story = {
	...GoalPaused,
	globals: { theme: "light" },
};
export const GoalMetLight: Story = { ...GoalMet, globals: { theme: "light" } };
export const GoalClearedLight: Story = {
	...GoalCleared,
	globals: { theme: "light" },
};

function setupGoalDetails(
	state: "not_yet" | "checking" | "paused" | "met" | "starting",
) {
	const cleanup = setupGoal(state === "starting" ? "checking" : state);
	const facts = sessionGoals.get(mockSession.id);
	const currentGoal = facts?.goal ?? facts?.endedGoal;
	if (!facts || !currentGoal) {
		expect(currentGoal).toBeDefined();
		return cleanup;
	}
	const goal = {
		...currentGoal,
		iterations: state === "starting" ? 0 : state === "met" ? 5 : 3,
		...(state === "not_yet"
			? { lastReason: "35/38. jump-to-live fails." }
			: state === "met"
				? { lastReason: "38/38 on two runs in a row." }
				: {}),
	};
	if (state === "starting") {
		seedSessions([{ ...mockSession, status: "busy" }]);
	}
	handleGoalChanged({
		...facts,
		...(state === "met" ? { endedGoal: goal } : { goal }),
	});
	sessionState.now = goal.setAt + 41 * 60_000;
	goalDetails.open = true;
	return cleanup;
}

async function assertGoalDetails(
	canvasElement: HTMLElement,
	phase: string,
	checkCount: number,
) {
	const canvas = within(canvasElement);
	const details = await canvas.findByTestId("goal-details");
	await expect(details).toBeVisible();
	await expect(canvas.getByTestId("session-goal-subtitle")).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(getGoalDetails).toHaveBeenCalledWith({
		projectSlug: "conduit",
		sessionId: mockSession.id,
	});
	const panel = within(details);
	await expect(panel.getByTestId("goal-details-condition")).toHaveTextContent(
		"All 38 scenarios pass",
	);
	await expect(details).toHaveTextContent(phase);
	const history = within(panel.getByTestId("goal-details-history"));
	await waitFor(() =>
		expect(history.queryAllByTestId("goal-details-check")).toHaveLength(
			checkCount,
		),
	);
	const checks = history.queryAllByTestId("goal-details-check");
	for (const [index, fixture] of goalCheckFixtures
		.slice(0, Math.min(checkCount, 3))
		.entries()) {
		await expect(checks[index]).toHaveTextContent(`${fixture.minutes}m`);
		await expect(checks[index]).toHaveTextContent(fixture.reason);
	}
	return { panel, checks };
}

export const GoalDetailsOpen: Story = {
	tags: ["viewport-capture"],
	parameters: { docs: { story: { inline: false } } },
	beforeEach: () => setupGoalDetails("not_yet"),
	play: async ({ canvasElement }) => {
		const { panel } = await assertGoalDetails(canvasElement, "Not yet", 3);
		await expect(panel.getByTestId("goal-details-meta")).toHaveTextContent(
			"Set 41m ago · 3 checks · 1.24M tokens",
		);
		await expect(panel.getByTestId("goal-details-pause")).toBeVisible();
		await expect(panel.getByTestId("goal-details-edit")).toBeVisible();
		await expect(panel.getByTestId("goal-details-clear")).toBeVisible();
	},
};

export const GoalDetailsChecking: Story = {
	...GoalDetailsOpen,
	tags: ["viewport-capture"],
	beforeEach: () => setupGoalDetails("checking"),
	play: async ({ canvasElement }) => {
		const { checks } = await assertGoalDetails(canvasElement, "Checking", 4);
		await expect(checks[3]).toHaveTextContent("now");
		await expect(checks[3]).toHaveTextContent("Checking…");
		const spinner = checks[3]?.querySelector("svg");
		await expect(spinner).toBeVisible();
		if (!spinner) return;
		await expect(getComputedStyle(spinner).animationName).toBe("spin");
	},
};

export const GoalDetailsPaused: Story = {
	...GoalDetailsOpen,
	tags: ["viewport-capture"],
	beforeEach: () => setupGoalDetails("paused"),
	play: async ({ canvasElement }) => {
		const { panel } = await assertGoalDetails(canvasElement, "Paused", 3);
		await expect(panel.getByTestId("goal-details-resume")).toBeVisible();
		await expect(panel.queryByTestId("goal-details-pause")).toBeNull();
		await expect(panel.getByTestId("goal-details-edit")).toBeVisible();
		await expect(panel.getByTestId("goal-details-clear")).toBeVisible();
	},
};

export const GoalDetailsMet: Story = {
	...GoalDetailsOpen,
	tags: ["viewport-capture"],
	beforeEach: () => setupGoalDetails("met"),
	play: async ({ canvasElement }) => {
		const { panel, checks } = await assertGoalDetails(canvasElement, "Met", 5);
		await expect(checks[3]).toHaveTextContent("36m");
		await expect(checks[3]).toHaveTextContent(
			"38/38 once. Needs a second run.",
		);
		await expect(checks[4]).toHaveTextContent("41m");
		await expect(checks[4]).toHaveTextContent("38/38 on two runs in a row.");
		const icon = checks[4]?.querySelector("svg");
		await expect(icon).toBeVisible();
		if (!icon) return;
		const expected = new Option().style;
		expected.color = getComputedStyle(icon).getPropertyValue(
			"--color-status-green",
		);
		await expect(getComputedStyle(icon).color).toBe(expected.color);
		await expect(panel.getByTestId("goal-details-new")).toBeVisible();
		await expect(panel.getByTestId("goal-details-dismiss")).toBeVisible();
		await expect(panel.queryByTestId("goal-details-pause")).toBeNull();
		await expect(panel.queryByTestId("goal-details-edit")).toBeNull();
		await expect(panel.queryByTestId("goal-details-clear")).toBeNull();
	},
};

export const GoalDetailsEmpty: Story = {
	...GoalDetailsOpen,
	tags: ["viewport-capture"],
	beforeEach: () => setupGoalDetails("starting"),
	play: async ({ canvasElement }) => {
		const { panel } = await assertGoalDetails(canvasElement, "Starting", 0);
		await expect(panel.getByTestId("goal-details-history")).toHaveTextContent(
			"No checks yet. The first runs when Claude finishes a turn.",
		);
		await expect(panel.getByTestId("goal-details-meta")).toHaveTextContent(
			"0 checks",
		);
	},
};

export const GoalDetailsOpenLight: Story = {
	...GoalDetailsOpen,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const GoalDetailsCheckingLight: Story = {
	...GoalDetailsChecking,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const GoalDetailsPausedLight: Story = {
	...GoalDetailsPaused,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const GoalDetailsMetLight: Story = {
	...GoalDetailsMet,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const GoalDetailsEmptyLight: Story = {
	...GoalDetailsEmpty,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const ViewsSheetOpen: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-island-overflow"));
		const sheet = await within(document.body).findByTestId(
			"session-bar-island-menu",
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
	handlePtyOutput({ _tag: "output", ptyId: "pty-1", data: "one" });
	handlePtyOutput({ _tag: "output", ptyId: "pty-1", data: "two" });
	handlePtyOutput({ _tag: "output", ptyId: "pty-2", data: "three" });
}

export const WithViewBadge: Story = {
	beforeEach: emitOutputFromTwoTerminals,
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId(
			"session-bar-island-overflow",
		);
		await expect(button).toHaveTextContent("2");
	},
};

export const OpeningTerminalClearsBadge: Story = {
	tags: ["viewport-capture"],
	beforeEach: emitOutputFromTwoTerminals,
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId(
			"session-bar-island-overflow",
		);
		await expect(button).toHaveTextContent("2");
		openPanel();
		await tick();
		await expect(button).not.toHaveTextContent("2");
		await userEvent.click(button);
		const sheet = await within(document.body).findByTestId(
			"session-bar-island-menu",
		);
		await expect(
			within(sheet).getByTestId("overflow-view-terminal"),
		).toHaveAttribute("aria-checked", "true");
		expect(terminalState.unreadPtyIds.size).toBe(0);
	},
};

function showState(overrides: Partial<typeof mockSession>) {
	const session = { ...mockSession, ...overrides };
	seedSessions([session]);
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
		seedSessions([
			mockSession,
			mockSessionLongTitle,
			{ ...mockSession, id: "sess_other_a", pendingQuestionCount: 1 },
			{ ...mockSession, id: "sess_other_b", pendingPermissionCount: 1 },
		]);
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
		// The bar shows the badge only once the open session's provider is known.
		applyGetAgentsResponse(
			{
				projectSlug: "conduit",
				providerScope: { id: "opencode", name: "OpenCode" },
				agents: [],
			},
			mockSession.id,
		);
		projectState.projects = [
			{
				slug: "conduit",
				title: "conduit",
				folders: ["/src/conduit"],
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
		uiState.clientCount = 2;
		projectState.projects = [
			{
				slug: "conduit",
				title: "conduit",
				folders: ["/src/conduit"],
				git: { branch: "feature/17xt", worktree: "linked-15", dirty: true },
			},
		];
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("session-bar");
		await expect(bar).toHaveAttribute("data-compact", "false");
		await expect(canvas.getByTestId("session-bar-identity")).toHaveTextContent(
			/conduit.*feature\/17xt/,
		);
		await expect(canvas.getByTitle("Uncommitted changes")).toBeVisible();
		await expect(canvas.getByTestId("session-bar-settle")).toBeVisible();
		await expect(canvas.getByTestId("session-bar-overflow")).toBeVisible();
		const count = canvasElement.querySelector("#client-count-badge");
		expect(count?.textContent).toBe("2");
		expect(count?.tagName).toBe("SPAN");
	},
};

// The chip fetches on mount; seeding the answer for the open session first means
// the failed story-time fetch keeps it, as a failed refetch does in the app.
function seedSkills(): void {
	// The chip measures age against sessionState.now, which other stories pin.
	const at = sessionState.now - 5 * 60_000;
	sessionSkillsState.sessionId = mockSession.id;
	sessionSkillsState.loads = [
		{
			name: "release-notes",
			invokedBy: "user",
			turnOrdinal: 1,
			at,
			anchor: { messageId: "m1" },
			running: false,
		},
		{
			name: "changelog-style",
			invokedBy: "agent",
			turnOrdinal: 1,
			at,
			anchor: { messageId: "m2", partId: "p1" },
			running: false,
		},
		{
			name: "changelog-style",
			invokedBy: "agent",
			turnOrdinal: 2,
			at,
			anchor: { messageId: "m3", partId: "p2" },
			running: false,
		},
	];
}

export const WithSkills: Story = {
	tags: ["viewport-capture"],
	beforeEach: seedSkills,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const chip = canvas.getByRole("button", { name: "2 skills used" });
		await expect(chip).toHaveTextContent("2");
		await userEvent.click(chip);
		const rows = await within(document.body).findAllByTestId(
			"session-skills-row",
		);
		expect(rows.map((row) => row.dataset["skill"])).toEqual([
			"release-notes",
			"changelog-style",
		]);
		await expect(rows[1]).toHaveTextContent(/agent · turns 1, 2 · 5m ago.*×2/);
	},
};

export const DesktopWithSkills: Story = {
	tags: ["viewport-capture"],
	args: { width: 900 },
	beforeEach: () => {
		sessionViewState.compact = false;
		seedSkills();
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", { name: "2 skills used" }),
		);
		await expect(
			within(document.body).getByRole("menu", { name: "Skills used" }),
		).toBeVisible();
	},
};

function seedHeaderGit(): void {
	projectState.projects = [
		{
			slug: "conduit",
			title: "conduit",
			folders: ["/src/conduit"],
			git: { branch: "main", dirty: true },
		},
	];
}

export const PhoneGitIdentity: Story = {
	beforeEach: seedHeaderGit,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const back = canvas.getByTestId("session-bar-back").getBoundingClientRect();
		const pill = canvas.getByTestId("session-bar-identity");
		const git = pill.getBoundingClientRect();
		const more = canvas
			.getByTestId("session-bar-island-overflow")
			.getBoundingClientRect();
		await expect(pill).toHaveAttribute("title", "conduit / main");
		expect(back.right).toBeLessThanOrEqual(git.left);
		expect(git.right).toBeLessThanOrEqual(more.left);
		expect(
			Math.abs(git.y + git.height / 2 - more.y - more.height / 2),
		).toBeLessThan(1);
		expect(canvas.queryByTestId("session-skills-chip")).toBeNull();
		expect(canvas.queryByTestId("session-bar-views-button")).toBeNull();
	},
};

export const PhoneGitIdentityWithSkills: Story = {
	beforeEach: () => {
		seedHeaderGit();
		seedSkills();
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const chip = canvas.getByTestId("session-skills-chip");
		const pill = canvas.getByTestId("session-bar-identity");
		await expect(chip).toBeVisible();
		await expect(pill).toBeVisible();
		// The pill sits in a grid wrapper that carries its width floor.
		const segment = pill.parentElement;
		expect(chip.parentElement).toBe(segment?.parentElement);
		expect(chip.getBoundingClientRect().right).toBe(
			segment?.getBoundingClientRect().left,
		);
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
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-bar-unread-chip")).toBeVisible();
		await expect(canvas.getByTestId("session-bar-state-chip")).toBeVisible();
	},
};

const islandBanners: BannerConfig[] = [
	{
		id: "build-mismatch",
		variant: "warning",
		icon: "refresh-cw",
		text: "This page and the server have different builds. Restart the server, then reload this tab. Your draft is still here.",
		summary: "Restart the server",
		dismissible: false,
	},
	{
		id: "skip-perms-1",
		variant: "skip-permissions",
		icon: "shield-off",
		text: "Permissions are disabled. Tools will run without approval.",
		dismissible: false,
	},
];

function showIslandBanners(): () => void {
	uiState.banners = islandBanners;
	return () => {
		uiState.banners = [];
	};
}

/**
 * Phone chrome floats over the transcript, so banner tints (all translucent)
 * need an opaque backing or the messages show through them.
 */
export const IslandWithBanners: Story = {
	args: { island: true },
	beforeEach: showIslandBanners,
	play: async ({ canvasElement }) => {
		const ctx = document.createElement("canvas").getContext("2d");
		const alphaOf = (color: string): number => {
			if (!ctx) return 0;
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = color;
			ctx.fillRect(0, 0, 1, 1);
			return ctx.getImageData(0, 0, 1, 1).data[3] ?? 0;
		};
		const chrome = canvasElement.querySelector("#session-chrome");
		const banners = canvasElement.querySelectorAll("[data-banner-id]");
		expect(banners).toHaveLength(2);
		for (const banner of banners) {
			let backed = false;
			for (
				let el: Element | null = banner;
				el && !backed && el !== chrome?.parentElement;
				el = el.parentElement
			) {
				backed = alphaOf(getComputedStyle(el).backgroundColor) === 255;
			}
			expect(backed, banner.getAttribute("data-banner-id") ?? "").toBe(true);
		}
		expect(
			canvasElement.querySelector("[data-testid=session-bar-banners-row]"),
		).toBeNull();
	},
};

/**
 * Collapsed, banners become one line in the island like the goal and task
 * rows; tapping it opens the full header and its full banners.
 */
export const CollapsedWithBanners: Story = {
	args: { island: true },
	beforeEach: () => {
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.forcedOpen = false;
		return showIslandBanners();
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const row = canvas.getByTestId("session-bar-banners-row");
		await expect(row).toHaveTextContent("Restart the server");
		await expect(row).toHaveClass(/text-warning/);
		await expect(
			canvas.getByTestId("session-bar-banners-more"),
		).toHaveTextContent("+1");
		// The row sits inside the island rather than under it.
		const bar = canvas.getByTestId("session-bar").getBoundingClientRect();
		expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(bar.bottom);
		for (const banner of canvasElement.querySelectorAll("[data-banner-id]"))
			await expect(banner).not.toBeVisible();
	},
};

export const BannersRowExpands: Story = {
	...CollapsedWithBanners,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-banners-row"));
		await expect(canvas.getByTestId("session-bar")).toHaveAttribute(
			"data-collapsed",
			"false",
		);
		for (const banner of canvasElement.querySelectorAll("[data-banner-id]"))
			await expect(banner).toBeVisible();
		expect(canvas.queryByTestId("session-bar-banners-row")).toBeNull();
	},
};

// The desktop chips once spilled out of the title column: the ▾ painted over
// them, and at this width they ran on over the skills chip and the identity.
export const DesktopBackgroundTasks: Story = {
	args: { width: 700 },
	// The chip ages fail contrast (conduit-test-srt8); every other rule stays on.
	parameters: {
		a11y: {
			test: "error",
			config: { rules: [{ id: "color-contrast", enabled: false }] },
		},
	},
	beforeEach: () => {
		sessionViewState.compact = false;
		seedSkills();
		const firstSeenAt = Date.now() - 6 * 60_000;
		seedSessions([
			{
				...mockSession,
				backgroundTasks: [
					{
						id: "t1",
						type: "local_bash",
						description: "Run full gate with baseline orphan check",
						firstSeenAt,
					},
					{
						id: "t2",
						type: "local_bash",
						description: "Codex review of fix commit",
						firstSeenAt,
					},
					{
						id: "t3",
						type: "local_bash",
						description: "Wait for review or gate",
						firstSeenAt,
					},
				],
			},
		]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const tasks = canvas.getByTestId("background-tasks-row");
		const box = (el: Element) => el.getBoundingClientRect();
		const overlaps = (a: DOMRect, b: DOMRect) =>
			a.left < b.right &&
			b.left < a.right &&
			a.top < b.bottom &&
			b.top < a.bottom;
		const chips = box(tasks.firstElementChild ?? tasks);
		// The ▾'s hit target overhangs by design; its icon is what must clear.
		const menuIcon = canvas
			.getByTestId("session-bar-title-menu")
			.querySelector("svg");
		for (const el of [
			menuIcon,
			...[
				"session-bar-title",
				"session-skills-chip",
				"session-bar-identity",
			].map((id) => canvas.getByTestId(id)),
		])
			expect(
				overlaps(chips, box(el ?? tasks)),
				el?.outerHTML.slice(0, 60),
			).toBe(false);
		// Where the overhang meets the chips, the chips take the click.
		const menuBox = box(canvas.getByTestId("session-bar-title-menu"));
		expect(
			tasks.contains(
				document.elementFromPoint(
					menuBox.left + menuBox.width / 2,
					menuBox.bottom - 1,
				),
			),
		).toBe(true);
		expect(canvas.getAllByTestId("background-task-chip")).toHaveLength(3);
		expect(
			chips.top - box(canvas.getByTestId("session-bar-title")).bottom,
		).toBeGreaterThanOrEqual(6);
	},
};

export const BackgroundTasks: Story = {
	beforeEach: () => {
		seedSessions([
			{
				...mockSession,
				backgroundTasks: [
					{
						id: "t1",
						type: "local_bash",
						description: "Run full gate with baseline orphan check",
						firstSeenAt: Date.now() - 6 * 60_000,
					},
				],
			},
		]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const box = (id: string) => canvas.getByTestId(id).getBoundingClientRect();
		expect(
			box("background-task-chip").top - box("session-bar-title").bottom,
		).toBeGreaterThanOrEqual(6);
	},
};

// Side Threads: the segment control and the list it opens (conduit-test-8sq4.7).
const sideThreadsNow = Date.parse("2026-02-24T12:00:00Z");
const sideThreadRows: Row[] = [
	{
		id: "sess_side_reply",
		title: "Why does the gate skip the Linux baselines on this branch?",
		parentID: mockSession.id,
		sideThread: true,
		attention: "needs-reply",
		pendingQuestionCount: 1,
		updatedAt: sideThreadsNow - 2 * 60_000,
	},
	{
		id: "sess_side_unread",
		title: "Which story owns the composer focus ring?",
		parentID: mockSession.id,
		sideThread: true,
		attention: "done-unread",
		unread: true,
		updatedAt: sideThreadsNow - 14 * 60_000,
	},
	{
		id: "sess_side_idle",
		title: "Is the island chevron still 44px?",
		parentID: mockSession.id,
		sideThread: true,
		updatedAt: sideThreadsNow - 3 * 60 * 60_000,
	},
];

function setupSideThreads(rows: readonly Row[]) {
	seedSessions([mockSession, ...rows]);
	sessionState.now = sideThreadsNow;
	sideThreadsPanel.open = true;
	return () => {
		sideThreadsPanel.open = false;
	};
}

/** The list must hang under the bar, wholly on screen. */
async function assertSideThreadsPanel(canvasElement: HTMLElement) {
	const canvas = within(canvasElement);
	const panel = await canvas.findByTestId("side-threads-panel");
	await expect(panel).toBeVisible();
	const box = panel.getBoundingClientRect();
	const bar = canvas.getByTestId("session-bar").getBoundingClientRect();
	expect(box.top).toBeGreaterThanOrEqual(bar.bottom - 1);
	expect(box.left).toBeGreaterThanOrEqual(bar.left);
	expect(box.right).toBeLessThanOrEqual(bar.right);
	return within(panel);
}

async function assertSideThreadRows(canvasElement: HTMLElement) {
	const canvas = within(canvasElement);
	const control = canvas.getByTestId("side-threads-control");
	await expect(control).toHaveAccessibleName("3 Side Threads");
	await expect(control).toHaveAttribute("aria-expanded", "true");
	expect(within(control).getByTestId("side-threads-waiting")).toBeVisible();
	expect(within(control).getByTestId("side-threads-unread-dot")).toBeVisible();
	const panel = await assertSideThreadsPanel(canvasElement);
	await expect(panel.getAllByTestId("side-thread-title")).toHaveLength(3);
	expect(
		panel.getAllByTestId("side-thread-title").map((row) => row.textContent),
	).toEqual(sideThreadRows.map((row) => row.title));
	expect(
		panel.getAllByTestId("side-thread-time").map((row) => row.textContent),
	).toEqual(["2m ago", "14m ago", "3h ago"]);
	const [reply, unread, idle] = panel.getAllByTestId("side-thread");
	expect(
		reply && within(reply).queryByTestId("side-thread-waiting"),
	).not.toBeNull();
	expect(
		unread && within(unread).queryByTestId("side-thread-unread-dot"),
	).not.toBeNull();
	expect(idle && within(idle).queryByTestId("side-thread-waiting")).toBeNull();
	expect(
		idle && within(idle).queryByTestId("side-thread-unread-dot"),
	).toBeNull();
}

export const SideThreadsOpen: Story = {
	tags: ["viewport-capture"],
	parameters: { docs: { story: { inline: false } } },
	beforeEach: () => setupSideThreads(sideThreadRows),
	play: async ({ canvasElement }) => {
		await assertSideThreadRows(canvasElement);
		const panel = within(canvasElement).getByTestId("side-threads-panel");
		const bar = within(canvasElement).getByTestId("session-bar");
		// The phone sheet spans the bar.
		expect(panel.getBoundingClientRect().width).toBe(
			bar.getBoundingClientRect().width,
		);
	},
};

export const DesktopSideThreadsOpen: Story = {
	tags: ["viewport-capture"],
	args: { width: 900 },
	parameters: { docs: { story: { inline: false } } },
	beforeEach: () => {
		sessionViewState.compact = false;
		return setupSideThreads(sideThreadRows);
	},
	play: async ({ canvasElement }) => {
		await assertSideThreadRows(canvasElement);
		// The popover hangs from the control's side of the bar.
		const panel = within(canvasElement)
			.getByTestId("side-threads-panel")
			.getBoundingClientRect();
		const bar = within(canvasElement)
			.getByTestId("session-bar")
			.getBoundingClientRect();
		expect(panel.width).toBeLessThanOrEqual(440);
		expect(bar.right - panel.right).toBeLessThan(panel.left - bar.left);
	},
};

export const SideThreadsEmpty: Story = {
	tags: ["viewport-capture"],
	parameters: { docs: { story: { inline: false } } },
	beforeEach: () => setupSideThreads([]),
	play: async ({ canvasElement }) => {
		const panel = await assertSideThreadsPanel(canvasElement);
		await expect(panel.getByTestId("side-threads-empty")).toHaveTextContent(
			"No Side Threads yet. Type $btw and a question to ask one.",
		);
		expect(
			within(canvasElement).queryByTestId("side-threads-control"),
		).toBeNull();
	},
};

export const SideThreadsClosed: Story = {
	beforeEach: () => {
		const cleanup = setupSideThreads(sideThreadRows);
		sideThreadsPanel.open = false;
		return cleanup;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const control = canvas.getByTestId("side-threads-control");
		await expect(control).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(control);
		await assertSideThreadsPanel(canvasElement);
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(canvas.queryByTestId("side-threads-panel")).toBeNull(),
		);
		expect(document.activeElement).toBe(control);
	},
};
