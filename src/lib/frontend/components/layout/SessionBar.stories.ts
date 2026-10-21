import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { tick } from "svelte";
import type { SessionGoalChangedPayload } from "../../../contracts/stored-event.js";
import type { GoalDetails } from "../../../contracts/ws-rpc.js";
import {
	getOrCreateSessionActivity,
	phaseToIdle,
} from "../../stores/chat.svelte.js";
import {
	applyGetAgentsResponse,
	applyGetModelsResponse,
	clearDiscoveryState,
} from "../../stores/discovery.svelte.js";
import { featureFlags } from "../../stores/feature-flags.svelte.js";
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
import { openSessionForSetup } from "../../stories/session-setup.js";
import {
	connectedSocket,
	connectingSocket,
	replyRpc,
} from "../../stories/sockets.js";
import { inspectTouchTarget } from "../../stories/touch-target.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type { rpc } from "../../transport/ws-rpc-client.js";
import type {
	BannerConfig,
	OpenCodeInstance,
	SessionInfo,
} from "../../types.js";
import { sideThreadsPanel } from "../session/side-threads.svelte.js";
import SessionBarPhoneFrame from "./__fixtures__/SessionBarPhoneFrame.svelte";

let sequence = 0;

// Only stories that open a session sheet answer its auto-settle read: a
// connected socket also turns the bar's connection dot green.
const answerAutoSettle = () => {
	const restoreSocket = connectedSocket();
	const restoreOutlook = replyRpc("GetSessionAutoSettleOutlook", () => ({
		kind: "paused",
		reason: "awaiting-activity",
	}));
	return () => {
		restoreOutlook();
		restoreSocket();
	};
};

let desktopNow = Date.now();
const setDesktopAutoSettle = fn((payload: unknown) => {
	expect(payload).toMatchObject({ sessionId: mockSession.id, disabled: true });
	return { kind: "off" };
});
function answerDesktopAutoSettle() {
	sessionState.now = desktopNow;
	setDesktopAutoSettle.mockClear();
	const restoreSocket = connectedSocket();
	const restoreRead = replyRpc("GetSessionAutoSettleOutlook", () => {
		const row = sessionState.sessions.get(mockSession.id);
		if (row?.pinnedAt != null) return { kind: "paused", reason: "pinned" };
		if (row?.snoozedAt != null) return { kind: "paused", reason: "snoozed" };
		if (row?.settledAt != null) return { kind: "settled" };
		return { kind: "scheduled", at: desktopNow + 2 * 86_400_000 };
	});
	const restoreWrite = replyRpc("SetSessionAutoSettle", setDesktopAutoSettle);
	return () => {
		restoreWrite();
		restoreRead();
		restoreSocket();
	};
}

async function desktopMenu() {
	const menu = await within(document.body).findByTestId(
		"session-bar-overflow-menu",
	);
	await waitFor(() =>
		expect(
			menu.querySelector("[data-switch-status]"),
		).not.toBeEmptyDOMElement(),
	);
	return menu;
}

async function sessionSheet(testId: string) {
	const sheet = await within(document.body).findByTestId(testId);
	await waitFor(() =>
		expect(sheet.querySelector("[data-switch-status]")).toHaveTextContent(
			"On · waits for new activity",
		),
	);
	return sheet;
}

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

const goalCheckFixtures = [
	{ minutes: 8, reason: "29/38 pass. Three baselines are stale." },
	{ minutes: 19, reason: "33/38. Focus ring regressed." },
	{ minutes: 31, reason: "35/38. jump-to-live fails." },
	{ minutes: 36, reason: "38/38 once. Needs a second run." },
];

const fixtureClock = (at: number) =>
	new Date(at).toLocaleTimeString("en-US", {
		timeZone: "UTC",
		hour: "numeric",
		minute: "2-digit",
	});

const getGoalDetails = fn<
	(input: Parameters<typeof rpc<"GetGoalDetails">>[1]) => Promise<GoalDetails>
>(async ({ sessionId }): Promise<GoalDetails> => {
	const facts = sessionGoals.get(sessionId);
	const goal = facts?.goal ?? facts?.endedGoal;
	if (!goal) return { checks: [], tokensSinceStart: null };
	const count = facts?.ended === "met" ? 4 : Math.min(goal.iterations, 3);
	return {
		judgeModel: "Sonnet 5",
		turnCount: goal.iterations + 1,
		checks: goalCheckFixtures.slice(0, count).map((check, index) => ({
			iteration: index + 1,
			turnIndex: index + 1,
			at: goal.setAt + check.minutes * 60_000,
			reason: check.reason,
		})),
		tokensSinceStart: goal.iterations === 0 ? 0 : 1_240_000,
	};
});

// The frame pins phone widths and fills the canvas for desktop stories.
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
		featureFlags.debug = false;
		uiState.toasts = [];
		const detailsOpen = goalDetails.open;
		const now = sessionState.now;
		goalDetails.open = false;
		getGoalDetails.mockClear();
		clearDiscoveryState();
		clearSessionState();
		desktopNow = Date.now();
		sessionState.now = desktopNow;
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
		openSessionForSetup(mockSession.id, "conduit");
		// The bar reads its collapse rule from this store, and Storybook shares
		// module-level state across story files. Pin the expanded state so only
		// the story that wants the collapse gets it.
		sessionViewState.compact = true;
		sessionViewState.composerWidth = 760;
		sessionViewState.atBottom = true;
		sessionViewState.barOpen = true;
		sessionViewState.filesOpen = false;
		sessionViewState.filesEverOpened = false;
		sessionSkillsState.sessionId = null;
		sessionSkillsState.loads = [];
		uiState.clientCount = 1;
		destroyAll();
		// The skills chip's read dials the control socket on mount. Keep it
		// connecting, so the sheet stories' connectedSocket() can open the
		// socket the RPC client then keeps for the rest of the file.
		const restoreSocket = connectingSocket();
		// Every dial, retries included, probes the attached project's relay
		// status. Answer that probe; anything else still reaches the network guard.
		const guardedFetch = globalThis.fetch;
		globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
			String(input instanceof Request ? input.url : input).endsWith(
				"/api/status",
			)
				? Promise.resolve(Response.json({ status: "ready" }))
				: guardedFetch(input, init);
		return () => {
			clearDiscoveryState();
			globalThis.fetch = guardedFetch;
			restoreSocket();
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

		expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
			"Test Session",
		);
		expect(canvas.queryByRole("button", { name: /^Checkout:/ })).toBeNull();
		expect(canvas.queryByTestId("session-bar-attention")).toBeNull();
		expect(canvas.getByTestId("session-bar-title-menu")).toBeVisible();
		expect(canvas.getByTestId("session-bar-island-overflow")).toBeVisible();
		expect(canvas.queryByTestId("session-bar-overflow")).toBeNull();
		expect(canvas.queryByTestId("session-bar-views")).toBeNull();

		// The back control is the only way off this screen on a phone, so its
		// accessible name and its wiring are both worth pinning. It leaves the
		// session's route, so it runs last, and the session is reopened so the
		// capture still shows the default bar.
		const back = canvas.getByRole("button", { name: /Sessions/ });
		await userEvent.click(back);
		expect(routerState.path).toBe("/");
		routerState.path = `/s/${mockSession.id}`;
		await waitFor(() =>
			expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
				"Test Session",
			),
		);
	},
};

// 30s of slack: each story bumps setAt by 1ms to stay unique, and under the
// pinned visual clock that drift would otherwise floor the age to 40m.
let goalStorySetAt = Date.now() - 41 * 60_000 - 30_000;

function setupGoal(
	state: "checking" | "not_yet" | "paused" | "met" | "cleared",
	unread = false,
	condition = "All 38 scenarios pass",
) {
	const previous = sessionGoals.get(mockSession.id);
	applyGetModelsResponse(
		{
			projectSlug: "conduit",
			instanceId: "claude",
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [
						{ id: "story-model", name: "Story model", provider: "claude" },
					],
				},
			],
			active: { model: "story-model", provider: "claude" },
			variant: { variant: "", variants: [] },
			contextWindow: { contextWindow: "", options: [] },
			permissionMode: "ask",
		},
		mockSession.id,
	);
	phaseToIdle(getOrCreateSessionActivity(mockSession.id));
	goalStorySetAt = Math.max(
		goalStorySetAt + 1,
		Date.now() - 41 * 60_000 - 30_000,
	);
	const activeGoal = {
		condition,
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
	seedSessions([{ ...mockSession, status: "idle", unread }]);
	handleGoalChanged(facts);
	return () => {
		if (previous) handleGoalChanged(previous);
		else sessionGoals.delete(mockSession.id);
	};
}

async function assertGoalSubtitle(
	canvasElement: HTMLElement,
	text: string,
	token: string,
) {
	const subtitle = within(canvasElement).getByTestId("session-goal-subtitle");
	await expect(subtitle.textContent?.trim()).toBe(text);
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
			"Checking · All 38 scenarios pass",
			"--color-status-goal",
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
			"Pursuing · All 38 scenarios pass",
			"--color-status-amber",
		);
	},
};

export const GoalPaused: Story = {
	beforeEach: () => setupGoal("paused"),
	play: async ({ canvasElement }) => {
		const subtitle = await assertGoalSubtitle(
			canvasElement,
			"Paused · All 38 scenarios pass",
			"--color-status-goal",
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
			"Goal met · All 38 scenarios pass",
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
	const historyCount = Math.min(checkCount, phase === "Met" ? 4 : 3);
	const completed =
		phase === "Checking" || phase === "Met" ? checks.slice(1) : checks;
	for (const [index, fixture] of goalCheckFixtures
		.slice(0, historyCount)
		.reverse()
		.entries()) {
		await expect(completed[index]).toHaveTextContent(fixture.reason);
		const facts = sessionGoals.get(mockSession.id);
		const goal = facts?.goal ?? facts?.endedGoal;
		expect(goal).toBeDefined();
		if (goal)
			await expect(completed[index]?.querySelector("time")).toHaveTextContent(
				fixtureClock(goal.setAt + fixture.minutes * 60_000),
			);
	}
	return { panel, checks };
}

// Timestamps, counts and the card's section labels sit in the quiet tier (text-dimmer),
// below AA by design and held to 3:1 by theme-contrast.test.ts. color-contrast skips
// only those; it and every other rule stay on for the rest of the popover.
const quietTierA11y = {
	a11y: {
		test: "error",
		config: {
			rules: [
				{
					id: "color-contrast",
					selector:
						'*:not([data-testid="goal-details-meta"], [data-testid="goal-details-tokens"], [data-compact="false"] [data-goal-checks-heading], [data-testid="goal-details-check"] time, [data-testid="goal-details-check"] small, [aria-label="Snooze until"] .hold-menu-detail, [data-testid="session-bar-state-menu"] [data-menu-item-detail])',
				},
			],
		},
	},
};

export const GoalDetailsOpen: Story = {
	args: { island: true, height: 852 },
	tags: ["viewport-capture"],
	parameters: {
		...quietTierA11y,
		docs: { story: { inline: false } },
	},
	beforeEach: () => setupGoalDetails("not_yet"),
	play: async ({ canvasElement }) => {
		const { panel } = await assertGoalDetails(canvasElement, "Pursuing", 3);
		const setAt = sessionGoals.get(mockSession.id)?.goal?.setAt;
		expect(setAt).toBeDefined();
		if (setAt != null)
			await expect(panel.getByTestId("goal-details-meta")).toHaveTextContent(
				`Set ${fixtureClock(setAt)} · 3 checks · Sonnet 5 judges`,
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
		await expect(checks[0]).toHaveTextContent("now");
		await expect(checks[0]).toHaveTextContent("Checking");
		const spinner = checks[0]?.querySelector("svg");
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
		await expect(checks[1]).toHaveTextContent(
			"38/38 once. Needs a second run.",
		);
		await expect(checks[0]).toHaveTextContent("38/38 on two runs in a row.");
		const endedAt = sessionGoals.get(mockSession.id)?.endedAt;
		expect(endedAt).toBeDefined();
		if (endedAt != null)
			await expect(checks[0]?.querySelector("time")).toHaveTextContent(
				fixtureClock(endedAt),
			);
		const icon = checks[0]?.querySelector("svg");
		await expect(icon).toBeVisible();
		if (!icon) return;
		const expected = new Option().style;
		expected.color = getComputedStyle(icon).getPropertyValue("--color-success");
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
		const { panel } = await assertGoalDetails(canvasElement, "Pursuing", 0);
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
	beforeEach: answerAutoSettle,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const trigger = canvas.getByTestId("session-bar-island-overflow");
		// Bits restores the body's pointer events after the previous sheet unmounts.
		await waitFor(() =>
			expect(getComputedStyle(trigger).pointerEvents).toBe("auto"),
		);
		await userEvent.click(trigger);
		const sheet = await sessionSheet("session-bar-island-menu");
		await expect(sheet).toBeVisible();
		// Accessible names, in order: the shortcut hints are aria-hidden.
		const items = ["Chat", "Terminal", "Diff", "Files"].map((name) =>
			within(sheet).getByRole("menuitemradio", { name }),
		);
		expect(within(sheet).getAllByRole("menuitemradio")).toEqual(items);
		await expect(items[0]).toHaveAttribute("aria-checked", "true");
		await expect(items[2]).toHaveAttribute("aria-disabled", "true");
		expect(
			new Set(items.map((item) => item.getBoundingClientRect().top)).size,
		).toBe(1);
		await expect(
			within(sheet).getByTestId("session-sheet-header"),
		).toBeVisible();
		await expect(sheet.querySelector(".shortcut-hint")).toBeNull();
	},
};

export const ViewsSheetOpenLight: Story = {
	...ViewsSheetOpen,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const CloseSheetReturnsFocus: Story = {
	play: async ({ canvasElement }) => {
		const trigger = within(canvasElement).getByTestId(
			"session-bar-island-overflow",
		);
		const body = within(canvasElement.ownerDocument.body);
		await waitFor(() =>
			expect(getComputedStyle(trigger).pointerEvents).toBe("auto"),
		);
		await userEvent.click(trigger);
		await userEvent.click(await body.findByTestId("session-sheet-close"));
		await waitFor(() =>
			expect(
				body.queryByTestId("session-bar-island-menu"),
			).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(trigger).toHaveFocus());
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
	beforeEach: [answerAutoSettle, emitOutputFromTwoTerminals],
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId(
			"session-bar-island-overflow",
		);
		await expect(button).toHaveTextContent("2");
		openPanel();
		await tick();
		await expect(button).not.toHaveTextContent("2");
		await userEvent.click(button);
		const sheet = await sessionSheet("session-bar-island-menu");
		await expect(
			within(sheet).getByTestId("overflow-view-terminal"),
		).toHaveAttribute("aria-checked", "true");
		expect(terminalState.unreadPtyIds.size).toBe(0);
	},
};

function showState(overrides: Partial<typeof mockSession>) {
	const session = { ...mockSession, ...overrides };
	seedSessions([session]);
	openSessionForSetup(session.id, "conduit");
}

export const Settled: Story = {
	beforeEach: () => showState({ settledAt: Date.now() - 3_600_000 }),
	play: ({ canvasElement }) => {
		expectTouchTarget(
			within(canvasElement).getByTestId("session-bar-state-chip"),
		);
	},
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
	play: ({ canvasElement }) => {
		expectTouchTarget(
			within(canvasElement).getByTestId("session-bar-state-chip"),
		);
	},
};

export const Woke: Story = {
	beforeEach: () => showState({ wokenAt: Date.now(), wokeBecause: "error" }),
};

export const AutoSettledCollapsed: Story = {
	args: { island: true },
	beforeEach: () => {
		showState({
			settledAt: Date.now() - 3_600_000,
			settledAutomatically: true,
		});
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.barOpen = false;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("session-bar");
		await expect(bar).toHaveAttribute("data-collapsed", "true");
		expect(canvas.queryByTestId("session-bar-state-chip")).toBeNull();
		await userEvent.click(canvas.getByTestId("session-bar-expand"));
		await expect(canvas.getByTestId("session-bar-state-chip")).toHaveAttribute(
			"data-state",
			"auto-settled",
		);
		sessionViewState.barOpen = false;
		await waitFor(() => expect(bar).toHaveAttribute("data-collapsed", "true"));
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
		openSessionForSetup(mockSessionLongTitle.id, "conduit");
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
		openSessionForSetup(mockSessionLongTitle.id, "conduit");
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

const mockInstances: OpenCodeInstance[] = [
	{
		id: "inst-personal",
		driver: "opencode",
		isDefault: true,
		name: "Personal",
		port: 4096,
		managed: true,
		status: "healthy",
		restartCount: 0,
		createdAt: 0,
	},
	{
		id: "inst-work",
		driver: "opencode",
		isDefault: false,
		name: "Work",
		port: 4097,
		managed: true,
		status: "unhealthy",
		restartCount: 1,
		createdAt: 0,
	},
];

/**
 * The collapsed bar keeps its overflow while the expanded bar uses the title
 * and Views sheets.
 */
export const OverflowMenuOpen: Story = {
	args: { island: true },
	// The menu portals to <body>, so the capture has to frame the page.
	tags: ["viewport-capture"],
	beforeEach: [
		answerAutoSettle,
		() => {
			sessionViewState.compact = true;
			sessionViewState.atBottom = true;
			sessionViewState.barOpen = false;
		},
	],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-island-overflow"));

		const menu = await sessionSheet("session-bar-island-menu");
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
	beforeEach: [
		answerAutoSettle,
		() => {
			sessionViewState.compact = true;
		},
	],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-title-menu"));
		const menu = await sessionSheet("session-action-sheet");
		await expect(menu).toHaveClass(/bottom-0/);
		await expect(within(menu).getByTestId("session-ctx-settle")).toBeVisible();
		await expect(within(menu).getByTestId("session-title-share")).toBeVisible();
	},
};

export const OverflowMenuDebug: Story = {
	...OverflowMenuOpen,
	// The indexer reads tags statically, so a spread does not carry them.
	tags: ["viewport-capture"],
	beforeEach: [
		answerAutoSettle,
		() => {
			sessionViewState.compact = true;
			sessionViewState.atBottom = true;
			sessionViewState.barOpen = false;
			featureFlags.debug = true;
		},
	],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-island-overflow"),
		);
		const menu = await sessionSheet("session-bar-island-menu");
		await expect(
			within(menu).getByTestId("overflow-debug"),
		).toHaveAccessibleName("Debug panel");
		await expect(within(menu).getByTestId("overflow-debug")).toHaveTextContent(
			/Debug\s*dev/,
		);
	},
};
export const OverflowMenuDebugLight: Story = {
	...OverflowMenuDebug,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
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
		sessionViewState.barOpen = false;
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

		expect(canvas.queryByRole("button", { name: /^Checkout:/ })).toBeNull();

		// The word goes but the accessible name does not — this is the only way
		// off the screen.
		const back = canvas.getByRole("button", { name: /Sessions/ });
		expect(back.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
	},
};

function setupPhoneHeader() {
	seedSkills();
	instanceState.instances = mockInstances.slice(0, 1).map((instance) => ({
		...instance,
		id: "claude",
		driver: "claude",
		capabilities: {
			supportsMultiFolder: false,
			supportsWorktree: false,
			supportsTaskStop: true,
		},
	}));
	const cleanup = setupGoal("checking", true);
	const facts = sessionGoals.get(mockSession.id);
	seedSessions([
		{
			...mockSession,
			title: "Typed session list",
			accountId: "claude",
			unread: true,
			backgroundTasks: [
				{
					id: "phone-task-1",
					type: "local_bash",
					description: "pnpm test:e2e",
					firstSeenAt: Date.now(),
				},
				{
					id: "phone-task-2",
					type: "local_bash",
					description: "pnpm check",
					firstSeenAt: Date.now(),
				},
			],
		},
		{ ...mockSession, id: "phone-needs-reply", pendingQuestionCount: 1 },
		{
			...mockSession,
			id: "phone-side-1",
			parentID: mockSession.id,
			sideThread: true,
		},
		{
			...mockSession,
			id: "phone-side-2",
			parentID: mockSession.id,
			sideThread: true,
		},
		{ ...mockSession, id: "phone-needs-approval", pendingPermissionCount: 1 },
	]);
	if (facts) handleGoalChanged(facts);
	return cleanup;
}

// Verify actual ownership, including edges, rather than nominal CSS dimensions.
function expectTouchTarget(control: HTMLElement, minimum = 44) {
	const target = inspectTouchTarget(control, minimum);
	expect(target.width, control.dataset["testid"]).toBeGreaterThanOrEqual(
		minimum,
	);
	expect(target.height, control.dataset["testid"]).toBeGreaterThanOrEqual(
		minimum,
	);
	expect(target.missing, JSON.stringify(target.failures)).toBe(0);
}

export const PhoneTop: Story = {
	beforeEach: setupPhoneHeader,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("session-bar");
		const back = canvas.getByTestId("session-bar-back").getBoundingClientRect();
		const title = canvas.getByTestId("session-bar-title");
		const goal = canvas.getByTestId("session-goal-subtitle");
		const tasks = canvas.getByTestId("background-tasks-row");
		const pill = canvas.getByTestId("session-controls-pill");
		expect(pill.getBoundingClientRect().left).toBeGreaterThanOrEqual(
			back.right,
		);
		expect(pill.getBoundingClientRect().right).toBeLessThanOrEqual(
			canvas.getByTestId("session-bar-island-overflow").getBoundingClientRect()
				.left,
		);
		await expect(bar).toHaveAttribute("data-collapsed", "false");
		expect(getComputedStyle(title).fontSize).toBe("17px");
		expect(title.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			back.bottom,
		);
		expect(goal.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			title.getBoundingClientRect().bottom,
		);
		expect(tasks.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			goal.getBoundingClientRect().bottom,
		);
		await expect(tasks).toHaveTextContent("2 background tasks");
		expect(goal.getBoundingClientRect().width).toBe(
			bar.getBoundingClientRect().width - 20,
		);
		for (const id of [
			"session-bar-back",
			"session-skills-chip",
			"side-threads-control",
			"session-bar-settle",
			"session-bar-title-menu",
			"session-bar-unread-chip",
			"session-bar-island-overflow",
			"session-goal-subtitle",
			"background-tasks-toggle",
			"background-tasks-row-stop-all",
		]) {
			expectTouchTarget(
				canvas.getByTestId(id),
				[
					"session-skills-chip",
					"side-threads-control",
					"session-bar-settle",
					"session-bar-title-menu",
					"session-bar-unread-chip",
					"session-goal-subtitle",
				].includes(id)
					? 24
					: 44,
			);
		}
	},
};

export const PhoneTopLight: Story = {
	...PhoneTop,
	globals: { theme: "light" },
};

export const PhoneTopNarrowest: Story = { ...PhoneTop, args: { width: 320 } };
export const PhoneTopNarrowestLight: Story = {
	...PhoneTopNarrowest,
	globals: { theme: "light" },
};

export const PhoneIslandBadge: Story = {
	args: { island: true },
	beforeEach: () => {
		const cleanup = setupPhoneHeader();
		sessionViewState.barOpen = false;
		return cleanup;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("session-bar");
		await expect(bar).toHaveAttribute("data-collapsed", "true");
		expect(bar.getBoundingClientRect().height).toBe(46);
		expect(bar.getBoundingClientRect().width).toBe(369);
		expect(getComputedStyle(bar).borderRadius).toBe("23px");
		const badge = canvas.getByTestId("session-bar-attention");
		await expect(badge).toHaveTextContent("2");
		const chevron = canvas.getByTestId("session-bar-back").querySelector("svg");
		expect(chevron).not.toBeNull();
		if (!chevron) return;
		expect(
			badge.getBoundingClientRect().left -
				chevron.getBoundingClientRect().right,
		).toBeGreaterThanOrEqual(4);
		await expect(canvas.queryByTestId("session-goal-subtitle")).toBeNull();
		await expect(canvas.queryByTestId("background-tasks-row")).toBeNull();
		const heading = canvas.getByRole("heading", { level: 1 });
		expect(getComputedStyle(heading).fontSize).toBe("15px");
		await userEvent.click(canvas.getByTestId("session-bar-expand"));
		expect(canvas.getByRole("heading", { level: 1 })).toBe(heading);
		await expect(canvas.getByTestId("session-goal-subtitle")).toBeVisible();
		await expect(bar).toHaveFocus();
		sessionViewState.barOpen = false;
	},
};

export const PhoneIslandBadgeLight: Story = {
	...PhoneIslandBadge,
	globals: { theme: "light" },
};

export const PhoneGoalSheet: Story = {
	args: { island: true, height: 852 },
	parameters: quietTierA11y,
	tags: ["viewport-capture"],
	beforeEach: () => setupGoal("checking"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const goal = canvas.getByTestId("session-goal-subtitle");
		await waitFor(() =>
			expect(getComputedStyle(goal).pointerEvents).toBe("auto"),
		);
		await userEvent.click(goal);
		const sheet = await canvas.findByTestId("goal-details");
		await waitFor(() => expect(sheet).toHaveTextContent("Sonnet 5 judges"));
		const box = sheet.getBoundingClientRect();
		expect(box.x).toBe(0);
		expect(box.width).toBe(393);
		expect(box.bottom).toBe(852);
		expect(
			getComputedStyle(sheet.querySelector("[data-sheet-chrome]") ?? sheet)
				.borderTopLeftRadius,
		).toBe("22px");
		for (const id of [
			"goal-details-pause",
			"goal-details-edit",
			"goal-details-clear",
		]) {
			expectTouchTarget(canvas.getByTestId(id));
		}
		await userEvent.keyboard("{Escape}");
		await waitFor(() => {
			expect(canvas.queryByTestId("goal-details")).toBeNull();
			expect(goal).toHaveFocus();
			expect(getComputedStyle(goal).pointerEvents).toBe("auto");
		});
		await userEvent.click(goal);
		await userEvent.click(canvas.getByTestId("goal-details-scrim"));
		await waitFor(() => {
			expect(canvas.queryByTestId("goal-details")).toBeNull();
			expect(goal).toHaveFocus();
			expect(getComputedStyle(goal).pointerEvents).toBe("auto");
		});
		await userEvent.click(goal);
	},
};

export const PhoneGoalSheetLight: Story = {
	...PhoneGoalSheet,
	globals: { theme: "light" },
};

export const PhoneLongTitleLight: Story = {
	...LongTitle,
	globals: { theme: "light" },
};

export const PhoneIslandLongTitle: Story = {
	...LongTitle,
	args: { island: true },
	beforeEach: () => {
		openSessionForSetup(mockSessionLongTitle.id, "conduit");
		sessionViewState.barOpen = false;
	},
};
export const PhoneIslandLongTitleLight: Story = {
	...PhoneIslandLongTitle,
	globals: { theme: "light" },
};

/**
 * Pressing the chevron expands the bar. It also unmounts the chevron, so this
 * pins where focus lands: on the named region, which announces as a state
 * change rather than as the control the user just pressed disappearing.
 */
export const ExpandedByChevron: Story = {
	args: { island: true },
	beforeEach: () => {
		sessionViewState.compact = true;
		sessionViewState.atBottom = true;
		sessionViewState.barOpen = false;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-bar-expand"));

		expect(canvas.queryByTestId("session-bar-expand")).toBeNull();
		expect(canvasElement.querySelector("#session-bar-meta")).toBeVisible();
		expect(canvas.queryByRole("button", { name: /^Checkout:/ })).toBeNull();
		expect(canvas.getByTestId("session-bar")).toHaveFocus();
		// Still at the bottom: the chevron overrides the rule, it does not move
		// the transcript.
		expect(sessionViewState.atBottom).toBe(true);
	},
};

export const DesktopNoCheckout: Story = {
	args: { width: "full" },
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
		expect(bar.getBoundingClientRect().height).toBe(52);
		expect(
			canvas.getByTestId("session-bar-overflow").getBoundingClientRect().height,
		).toBeGreaterThanOrEqual(44);
		expect(canvas.queryByRole("button", { name: /^Checkout:/ })).toBeNull();
		expect(canvas.queryByTitle("Uncommitted changes")).toBeNull();
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
	args: { width: "full" },
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

export const PhoneNoCheckout: Story = {
	beforeEach: seedHeaderGit,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const back = canvas.getByTestId("session-bar-back").getBoundingClientRect();
		const more = canvas
			.getByTestId("session-bar-island-overflow")
			.getBoundingClientRect();
		expect(canvas.queryByRole("button", { name: /^Checkout:/ })).toBeNull();
		expect(back.right).toBeLessThanOrEqual(more.left);
		expect(canvas.queryByTestId("session-skills-chip")).toBeNull();
		expect(canvas.queryByTestId("session-bar-views-button")).toBeNull();
	},
};

export const PhoneControlsWithSkills: Story = {
	beforeEach: () => {
		seedHeaderGit();
		seedSkills();
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const chip = canvas.getByTestId("session-skills-chip");
		await expect(chip).toBeVisible();
		expect(chip.parentElement).toHaveClass("session-bar-segments");
		expect(canvas.queryByRole("button", { name: /^Checkout:/ })).toBeNull();
		expect(
			canvas.getByTestId("session-bar-back").getBoundingClientRect().right,
		).toBeLessThanOrEqual(chip.getBoundingClientRect().left);
		expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(
			canvas.getByTestId("session-bar-island-overflow").getBoundingClientRect()
				.left,
		);
	},
};

// Long checkout and account names leave the header controls unchanged.
function seedClaudeHeader(): void {
	projectState.projects = [
		{
			slug: "conduit",
			title: "conduit",
			folders: ["/src/conduit"],
			git: { branch: "feature/session-header-overlap-fix", dirty: true },
		},
	];
	const accounts = [
		{ id: "claude-work", name: "Work Claude Max" },
		{ id: "claude-personal", name: "Personal" },
	];
	instanceState.instances = mockInstances.map((instance, index) => ({
		...instance,
		...accounts[index],
		driver: "claude",
		isDefault: index === 0,
	}));
	seedSessions([
		{ ...mockSession, accountId: "claude-work" },
		mockSessionLongTitle,
	]);
	applyGetAgentsResponse(
		{
			projectSlug: "conduit",
			providerScope: { id: "claude", name: "Claude" },
			agents: [],
			instanceId: "claude-work",
		},
		mockSession.id,
	);
}

export const PhoneBusySession: Story = {
	beforeEach: setupPhoneHeader,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		expect(canvas.queryByRole("button", { name: /^Checkout:/ })).toBeNull();
		expect(
			canvas.queryByRole("button", { name: /^Session account:/ }),
		).toBeNull();
		expect(canvas.queryByTestId("account-dot")).toBeNull();
		const bar = canvas.getByTestId("session-bar");
		expect(bar.scrollWidth).toBe(bar.clientWidth);
	},
};

export const PhoneBusySessionNarrowest: Story = {
	...PhoneBusySession,
	args: { width: 320 },
};

export const DesktopBusySession: Story = {
	...PhoneBusySession,
	args: { width: "full" },
	beforeEach: () => {
		const cleanup = setupPhoneHeader();
		sessionViewState.compact = false;
		return cleanup;
	},
};

export const DesktopLongTitleNarrow: Story = {
	args: { width: 480 },
	beforeEach: () => {
		sessionViewState.compact = false;
		openSessionForSetup(mockSessionLongTitle.id, "conduit");
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
	args: { width: "full" },
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
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		openSessionForSetup(null);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		expect(canvas.queryByRole("button", { name: /^Checkout:/ })).toBeNull();
		await expect(canvas.getByTestId("session-bar-overflow")).toBeVisible();
		expect(canvas.queryByTestId("session-bar-title")).toBeNull();
		expect(canvas.queryByTestId("session-bar-settle")).toBeNull();
	},
};

export const DesktopUnread: Story = {
	args: { width: "full" },
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
	args: { width: "full" },
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
		sessionViewState.barOpen = false;
		return showIslandBanners();
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const row = canvas.getByTestId("session-bar-banners-row");
		expectTouchTarget(row);
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
				"session-bar-overflow",
			].map((id) => canvas.getByTestId(id)),
		])
			expect(
				overlaps(chips, box(el ?? tasks)),
				el?.outerHTML.slice(0, 60),
			).toBe(false);
		expect(canvas.getAllByTestId("background-task-chip")).toHaveLength(2);
		await expect(canvas.getByTestId("background-tasks-more")).toHaveTextContent(
			"+1",
		);
		expect(canvas.queryByTestId("background-tasks-elbow")).toBeNull();
		expect(tasks.querySelector("svg.lucide-chevron-down")).toBeNull();
		expect(
			chips.top - box(canvas.getByTestId("session-bar-title")).bottom,
		).toBeGreaterThanOrEqual(6);
		await userEvent.click(canvas.getByTestId("background-tasks-more"));
		await expect(canvas.getByTestId("background-tasks-panel")).toBeVisible();
		await userEvent.keyboard("{Escape}");
	},
};

export const BackgroundTasks: Story = {
	args: { island: true, height: 852 },
	tags: ["viewport-capture"],
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
		const tasks = canvas.getByTestId("background-tasks-row");
		await expect(tasks).toHaveTextContent("1 background task");
		expect(tasks.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			canvas.getByTestId("session-bar-title").getBoundingClientRect().bottom,
		);
		await userEvent.click(canvas.getByTestId("background-tasks-toggle"));
		await expect(canvas.getByTestId("background-tasks-panel")).toBeVisible();
		sessionViewState.atBottom = true;
		sessionViewState.barOpen = false;
		await tick();
		await expect(canvas.getByTestId("session-bar")).toHaveAttribute(
			"data-collapsed",
			"false",
		);
		await userEvent.keyboard("{Escape}");
		await expect(canvas.getByTestId("background-tasks-toggle")).toHaveFocus();
		await userEvent.click(canvas.getByTestId("background-tasks-toggle"));
		await expect(canvas.getByTestId("background-tasks-panel")).toBeVisible();
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
	args: { width: "full" },
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

export const DesktopAutoSettled: Story = {
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		showState({
			settledAt: Date.now() - 3_600_000,
			settledAutomatically: true,
		});
	},
	play: async ({ canvasElement }) => {
		const chip = within(canvasElement).getByTestId("session-bar-state-chip");
		await expect(chip).toHaveTextContent("Settled");
		await expect(chip.querySelector("svg")).toHaveClass(/lucide-zap/);
	},
};

export const DesktopSnoozed: Story = {
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		const now = sessionState.now;
		showState({ snoozedAt: now, snoozedUntil: now + 3_600_000 });
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("session-bar-state-chip"),
		).toHaveTextContent("Snoozed");
		await expect(canvas.getByTestId("session-bar-settle")).toHaveTextContent(
			/^Until /,
		);
	},
};

export const DesktopWoke: Story = {
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		showState({ unread: true, wokenAt: sessionState.now, wokeBecause: "turn" });
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("session-bar-unread-chip"),
		).toHaveTextContent("Unread");
		await expect(canvas.getByTestId("session-bar-woke")).toHaveTextContent(
			"Woke · done",
		);
		expect(canvas.queryByTestId("session-bar-state-chip")).toBeNull();
	},
};

export const DesktopWokeRead: Story = {
	...DesktopWoke,
	beforeEach: () => {
		sessionViewState.compact = false;
		showState({
			unread: false,
			wokenAt: sessionState.now,
			wokeBecause: "turn",
		});
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-bar-woke")).toHaveTextContent(
			"Woke · done",
		);
		expect(canvas.queryByTestId("session-bar-unread-chip")).toBeNull();
		expect(canvas.queryByTestId("session-bar-unread-mark-read")).toBeNull();
	},
};

export const DesktopPinned: Story = {
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		showState({ pinnedAt: sessionState.now });
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("session-bar-state-chip"),
		).toHaveTextContent("Pinned");
		await expect(canvas.getByTestId("session-bar-settle")).toHaveTextContent(
			"Unpin",
		);
	},
};

export const DesktopGoalPursuing: Story = {
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		return setupGoal("not_yet");
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("session-goal-subtitle").textContent?.trim(),
		).toBe("Pursuing · All 38 scenarios pass");
		await expect(canvas.getByTestId("session-bar-settle")).toHaveTextContent(
			"Pin to top",
		);
	},
};

export const DesktopGoalLongCondition: Story = {
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		return setupGoal(
			"not_yet",
			false,
			"Implement every open child of the redesign epics, in ready order, in parallel worktrees where tickets don't share files, integrating on a local branch.\n\nRules, so you never need to ask me:\n1. The design doc is the spec.",
		);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const goal = canvas
			.getByTestId("session-goal-subtitle")
			.getBoundingClientRect();
		const row = canvasElement
			.querySelector("#session-bar-title-row")
			?.getBoundingClientRect();
		const meta = canvasElement
			.querySelector("#session-bar-meta")
			?.getBoundingClientRect();
		// The goal line truncates inside the title track, clear of the controls.
		await expect(goal.right).toBeLessThanOrEqual(row?.right ?? 0);
		await expect(goal.right).toBeLessThanOrEqual(meta?.left ?? 0);
	},
};

export const DesktopGoalChecking: Story = {
	...DesktopGoalPursuing,
	beforeEach: () => {
		sessionViewState.compact = false;
		return setupGoal("checking");
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("session-goal-subtitle").textContent?.trim(),
		).toBe("Checking · All 38 scenarios pass");
		expect(canvas.queryByTestId("session-bar-settle")).toBeNull();
	},
};

export const DesktopGoalMet: Story = {
	...DesktopGoalPursuing,
	beforeEach: () => {
		sessionViewState.compact = false;
		return setupGoal("met", true);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("session-goal-subtitle").textContent?.trim(),
		).toBe("Goal met · All 38 scenarios pass");
		await expect(canvas.getByTestId("session-bar-unread-chip")).toBeVisible();
		await expect(canvas.getByTestId("session-bar-settle")).toHaveTextContent(
			"Settle",
		);
	},
};

export const DesktopGoalMetRead: Story = {
	...DesktopGoalMet,
	beforeEach: () => {
		sessionViewState.compact = false;
		return setupGoal("met");
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("session-goal-subtitle").textContent?.trim(),
		).toBe("Goal met · All 38 scenarios pass");
		expect(canvas.queryByTestId("session-bar-unread-chip")).toBeNull();
		expect(canvas.queryByTestId("session-bar-unread-mark-read")).toBeNull();
		await expect(canvas.getByTestId("session-bar-settle")).toHaveTextContent(
			"Settle",
		);
	},
};

export const DesktopSidebarCollapsed: Story = {
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		const previous = uiState.sidebarCollapsed;
		uiState.sidebarCollapsed = true;
		seedSessions([
			mockSession,
			{
				...mockSessionLongTitle,
				attention: "needs-reply",
				pendingQuestionCount: 1,
			},
		]);
		return () => {
			uiState.sidebarCollapsed = previous;
		};
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-bar-back")).toHaveTextContent(
			"Sessions",
		);
		await expect(canvas.getByTestId("session-bar-attention")).toHaveTextContent(
			"1",
		);
		const badgeStyle = getComputedStyle(
			canvas.getByTestId("session-bar-attention"),
		);
		const expected = new Option().style;
		expected.backgroundColor = badgeStyle.getPropertyValue("--color-fill-ask");
		expect(badgeStyle.backgroundColor).toBe(expected.backgroundColor);
	},
};

export const DesktopBanners: Story = {
	args: {
		width: "full",
		banners: islandBanners.map((banner, index) => ({
			...banner,
			action: { label: index === 0 ? "Reload" : "Change", run: fn() },
		})),
	},
	beforeEach: () => {
		sessionViewState.compact = false;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const banners = canvas.getAllByTestId("banner-action");
		await expect(banners).toHaveLength(2);
		expect(banners[1]?.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			canvas.getByTestId("session-bar").getBoundingClientRect().top,
		);
	},
};

export const DesktopGoalMetLight: Story = {
	...DesktopGoalMet,
	globals: { theme: "light" },
};
export const DesktopGoalMetReadLight: Story = {
	...DesktopGoalMetRead,
	globals: { theme: "light" },
};
export const DesktopWokeReadLight: Story = {
	...DesktopWokeRead,
	globals: { theme: "light" },
};
export const DesktopSidebarCollapsedLight: Story = {
	...DesktopSidebarCollapsed,
	globals: { theme: "light" },
};
export const DesktopBannersLight: Story = {
	...DesktopBanners,
	globals: { theme: "light" },
};

export const DesktopGoalDetails: Story = {
	parameters: quietTierA11y,
	args: { width: "full" },
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = false;
		const cleanup = setupGoalDetails("checking");
		const facts = sessionGoals.get(mockSession.id);
		if (facts?.goal)
			handleGoalChanged({
				...facts,
				goal: { ...facts.goal, setAt: desktopNow - 27 * 60_000 },
			});
		return cleanup;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const card = await canvas.findByTestId("goal-details");
		await waitFor(() =>
			expect(within(card).getByTestId("goal-details-meta")).toHaveTextContent(
				"Sonnet 5 judges",
			),
		);
		await expect(card).toHaveTextContent("Checking · after turn 4");
		expect(card.getBoundingClientRect().width).toBeLessThan(450);
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(canvas.queryByTestId("goal-details")).toBeNull(),
		);
		await expect(canvas.getByTestId("session-goal-subtitle")).toHaveFocus();
		await userEvent.click(canvas.getByTestId("session-goal-subtitle"));
	},
};

export const DesktopMenu: Story = {
	args: { width: "full" },
	tags: ["viewport-capture"],
	beforeEach: [
		answerDesktopAutoSettle,
		() => {
			sessionViewState.compact = false;
		},
	],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-overflow"),
		);
		const menu = await desktopMenu();
		const items = within(menu);
		await expect(items.getByTestId("session-ctx-settle")).toHaveTextContent(
			"⌘⇧S",
		);
		expect(items.queryByTestId("session-sheet-header")).toBeNull();
		expect(items.queryByRole("menuitemradio")).toBeNull();
		await expect(items.getByTestId("session-ctx-delete")).toBeVisible();
		await expect(items.getByTestId("session-ctx-snooze")).not.toHaveTextContent(
			"hold",
		);
	},
};

export const DesktopSnoozeList: Story = {
	...DesktopMenu,
	parameters: quietTierA11y,
	tags: ["viewport-capture"],
	play: async (context) => {
		await DesktopMenu.play?.(context);
		const menu = await within(document.body).findByTestId(
			"session-bar-overflow-menu",
		);
		await userEvent.click(within(menu).getByTestId("session-ctx-snooze"));
		const list = await within(document.body).findByRole("menu", {
			name: /^Snooze until$/,
		});
		await expect(
			within(list).getByRole("menuitem", { name: /Pick a date & time/ }),
		).toBeVisible();
		await expect(
			within(list).getByRole("menuitem", { name: "Until something happens" }),
		).toBeVisible();
		expect(list).not.toHaveTextContent("slide to a time");
	},
};

export const DesktopSnoozedMenu: Story = {
	...DesktopSnoozed,
	parameters: quietTierA11y,
	tags: ["viewport-capture"],
	beforeEach: [
		answerDesktopAutoSettle,
		() => {
			sessionViewState.compact = false;
			const now = sessionState.now;
			showState({ snoozedAt: now, snoozedUntil: now + 3_600_000 });
		},
	],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-state-chip"),
		);
		const menu = await within(document.body).findByTestId(
			"session-bar-state-menu",
		);
		await expect(
			within(menu).getByTestId("session-bar-wake"),
		).toHaveTextContent("Unsnooze");
		await expect(menu).toHaveTextContent("Change time");
		await waitFor(() =>
			expect(menu.querySelector("[data-switch-status]")).toHaveTextContent(
				"On · paused while snoozed",
			),
		);
		await expect(
			within(menu).getByTestId("session-state-snooze-1h"),
		).toHaveAttribute("aria-current", "true");
		await expect(
			within(menu).getByRole("menuitem", { name: "Until something happens" }),
		).toBeVisible();
	},
};

// Storybook reads `tags` statically, so a spread copy loses viewport-capture:
// each popover story names it itself.
export const DesktopMenuPinned: Story = {
	...DesktopMenu,
	tags: ["viewport-capture"],
	beforeEach: [
		answerDesktopAutoSettle,
		() => {
			sessionViewState.compact = false;
			showState({ pinnedAt: desktopNow });
		},
	],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-overflow"),
		);
		const menu = await desktopMenu();
		await expect(menu).toHaveTextContent("On · paused while pinned");
		await expect(
			within(menu).getByTestId("session-ctx-settle"),
		).toHaveAttribute("aria-disabled", "true");
		await expect(
			within(menu).getByTestId("session-ctx-snooze"),
		).toHaveTextContent("Unpin to snooze");
		await expect(within(menu).getByTestId("session-ctx-unpin")).toBeVisible();
	},
};

export const DesktopMenuSnoozed: Story = {
	...DesktopMenu,
	parameters: quietTierA11y,
	tags: ["viewport-capture"],
	beforeEach: [
		answerDesktopAutoSettle,
		() => {
			sessionViewState.compact = false;
			showState({
				snoozedAt: desktopNow,
				snoozedUntil: desktopNow + 3_600_000,
			});
		},
	],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-overflow"),
		);
		const menu = await desktopMenu();
		await expect(menu).toHaveTextContent("On · paused while snoozed");
		await expect(
			within(menu).getByTestId("session-ctx-unsnooze"),
		).toBeVisible();
	},
};

export const DesktopMenuSettled: Story = {
	...DesktopMenu,
	tags: ["viewport-capture"],
	beforeEach: [
		answerDesktopAutoSettle,
		() => {
			sessionViewState.compact = false;
			showState({ settledAt: desktopNow });
		},
	],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-overflow"),
		);
		const menu = await desktopMenu();
		await expect(
			within(menu).getByTestId("session-ctx-unsettle"),
		).toBeVisible();
		expect(within(menu).queryByTestId("session-ctx-snooze")).toBeNull();
	},
};

export const DesktopAutoSettleSave: Story = {
	...DesktopMenu,
	tags: ["viewport-capture"],
	play: async (context) => {
		await DesktopMenu.play?.(context);
		const menu = await desktopMenu();
		await userEvent.click(within(menu).getByTestId("session-ctx-auto-settle"));
		await waitFor(() =>
			expect(menu.querySelector("[data-switch-status]")).toHaveTextContent(
				"Off · stays until you settle it",
			),
		);
		await expect(setDesktopAutoSettle).toHaveBeenCalledTimes(1);
		await expect(menu).toBeVisible();
	},
};

const stopDesktopTask = fn((_payload: unknown) => ({ ok: true }));
export const DesktopTaskControls: Story = {
	args: { width: "full" },
	beforeEach: () => {
		sessionViewState.compact = false;
		seedClaudeHeader();
		instanceState.instances = instanceState.instances.map((instance) => ({
			...instance,
			capabilities: {
				supportsMultiFolder: false,
				supportsWorktree: false,
				supportsTaskStop: true,
			},
		}));
		seedSessions([
			{
				...mockSession,
				accountId: "claude-work",
				backgroundTasks: [
					{
						id: "t1",
						type: "local_bash",
						description: "Run tests",
						detail: "pnpm test:e2e",
						firstSeenAt: desktopNow,
					},
					{
						id: "t2",
						type: "local_bash",
						description: "Watch build",
						detail: "vite build --watch",
						firstSeenAt: desktopNow,
					},
				],
			},
		]);
		stopDesktopTask.mockClear();
		const restoreSocket = connectedSocket();
		const restoreStop = replyRpc("StopBackgroundTask", stopDesktopTask);
		return () => {
			restoreStop();
			restoreSocket();
		};
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", { name: "Stop Run tests" }),
		);
		await waitFor(() =>
			expect(stopDesktopTask).toHaveBeenCalledWith({
				_tag: "StopBackgroundTask",
				sessionId: mockSession.id,
				taskId: "t1",
			}),
		);
		// Requests leave both chips in place until the SDK confirms a stop.
		await expect(canvas.getAllByTestId("background-task-chip")).toHaveLength(2);
		stopDesktopTask.mockClear();
		await userEvent.click(canvas.getByTestId("background-tasks-row-stop-all"));
		await waitFor(() => expect(stopDesktopTask).toHaveBeenCalledTimes(2));
		await expect(stopDesktopTask).toHaveBeenNthCalledWith(1, {
			_tag: "StopBackgroundTask",
			sessionId: mockSession.id,
			taskId: "t2",
		});
		await expect(stopDesktopTask).toHaveBeenNthCalledWith(2, {
			_tag: "StopBackgroundTask",
			sessionId: mockSession.id,
			taskId: "t1",
		});
	},
};
export const DesktopTaskControlsLight: Story = {
	...DesktopTaskControls,
	globals: { theme: "light" },
};

export const DesktopMenuPinnedLight: Story = {
	...DesktopMenuPinned,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const DesktopMenuSnoozedLight: Story = {
	...DesktopMenuSnoozed,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const DesktopMenuSettledLight: Story = {
	...DesktopMenuSettled,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const DesktopAutoSettleSaveLight: Story = {
	...DesktopAutoSettleSave,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const DesktopAutoSettledLight: Story = {
	...DesktopAutoSettled,
	globals: { theme: "light" },
};
export const DesktopSnoozedLight: Story = {
	...DesktopSnoozed,
	globals: { theme: "light" },
};
export const DesktopWokeLight: Story = {
	...DesktopWoke,
	globals: { theme: "light" },
};
export const DesktopPinnedLight: Story = {
	...DesktopPinned,
	globals: { theme: "light" },
};
export const DesktopGoalPursuingLight: Story = {
	...DesktopGoalPursuing,
	globals: { theme: "light" },
};
export const DesktopGoalCheckingLight: Story = {
	...DesktopGoalChecking,
	globals: { theme: "light" },
};
export const DesktopGoalDetailsLight: Story = {
	...DesktopGoalDetails,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const DesktopMenuLight: Story = {
	...DesktopMenu,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const DesktopSnoozeListLight: Story = {
	...DesktopSnoozeList,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const DesktopSnoozedMenuLight: Story = {
	...DesktopSnoozedMenu,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
