import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { featureFlags } from "../../stores/feature-flags.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../stores/router.svelte.js";
import { clearSessionState } from "../../stores/session.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { applyUsageReadings } from "../../stores/usage.svelte.js";
import { mockClaudeAccount } from "../../stories/mocks.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import Sidebar from "./Sidebar.svelte";

const meta = {
	title: "Layout/Sidebar",
	component: Sidebar,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		const groupsOpen = { ...uiState.sessionGroupsOpen };
		const storedGroups = (["pinned", "running", "idle"] as const).map(
			(group) =>
				[group, localStorage.getItem(`session-group-${group}-open`)] as const,
		);
		uiState.sidebarCollapsed = false;
		uiState.sidebarWidth = 300;
		uiState.selectMode = false;
		uiState.settledShelfOpen = false;
		uiState.snoozedShelfOpen = false;
		uiState.sessionGroupsOpen = { pinned: true, running: true, idle: true };
		sessionViewState.compact = false;
		featureFlags.debug = false;
		instanceState.instances = [];
		applyUsageReadings([]);
		clearSessionState();
		routerState.path = "/";
		routerState.search = "";
		attachedProjectState.slug = "conduit";
		projectState.projects = [
			{ slug: "conduit", title: "conduit", folders: ["/src/conduit"] },
		];
		// An unsettled list draws the loading skeleton; these stories show the
		// empty sidebar the server confirmed.
		applySessionChange({ _tag: "snapshot", rows: [], sequence: Date.now() });
		applySessionChange({ _tag: "synchronized" });
		return () => {
			uiState.sessionGroupsOpen = groupsOpen;
			for (const [group, open] of storedGroups) {
				const key = `session-group-${group}-open`;
				if (open === null) localStorage.removeItem(key);
				else localStorage.setItem(key, open);
			}
			uiState.selectMode = false;
			sessionViewState.compact = false;
			featureFlags.debug = false;
		};
	},
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

async function expectSessionTitle(canvasElement: HTMLElement) {
	const canvas = within(canvasElement);
	const heading = canvas.getByTestId("list-bar-title");
	const mark = canvas.getByTestId("list-bar-mark");
	const label = canvas.getByText("Sessions", { exact: true });
	const count = canvas.getByTestId("list-bar-count");
	const compact = sessionViewState.compact;
	await expect(heading).toHaveAccessibleName(`Sessions ${count.textContent}`);
	await expect(mark).toBeVisible();
	await expect(mark).toHaveAttribute("aria-hidden", "true");
	await expect(mark).not.toHaveAttribute("tabindex");
	await expect(mark.closest("a, button")).toBeNull();
	await expect(mark).toHaveStyle({
		width: compact ? "26px" : "20px",
		height: compact ? "26px" : "20px",
		borderRadius: compact ? "7.02px" : "5.4px",
		color: "rgb(255, 255, 255)",
	});
	const glyph = mark.querySelector("svg");
	await expect(glyph?.getBoundingClientRect().width).toBeCloseTo(
		compact ? 15.6 : 12,
		1,
	);
	await expect(glyph?.getBoundingClientRect().height).toBeCloseTo(
		compact ? 15.6 : 12,
		1,
	);
	const accent = new Option().style;
	accent.color = getComputedStyle(mark).getPropertyValue("--color-accent");
	await expect(getComputedStyle(mark).backgroundColor).toBe(accent.color);
	const markBox = mark.getBoundingClientRect();
	const textRange = document.createRange();
	textRange.selectNodeContents(label);
	const textBox = textRange.getBoundingClientRect();
	await expect(
		Math.abs(
			markBox.top + markBox.height / 2 - textBox.top - textBox.height / 2,
		),
	).toBeLessThanOrEqual(1);
	await expect(textBox.left - markBox.right).toBe(compact ? 10 : 8);
	await expect(label.parentElement).toBe(count.parentElement);
	const textGroup = count.parentElement;
	if (!textGroup) throw new TypeError("Session title text group is missing");
	await expect(getComputedStyle(textGroup).alignItems).toBe("baseline");
}

function seedFinalSidebar(phone = false, singleAccount = false) {
	sessionViewState.compact = phone;
	uiState.sidebarWidth = phone ? 390 : 260;
	const now = Date.now();
	applySessionChange({
		_tag: "snapshot",
		rows: [
			{
				id: "pinned",
				title: "Fix token refresh race",
				attention: "needs-approval" as const,
				pinnedAt: now,
			},
			{
				id: "typed",
				title: "Typed session list",
				attention: "working" as const,
			},
			{
				id: "webkit",
				title: "Webkit e2e flake",
				attention: "working" as const,
			},
			{
				id: "release",
				title: "Release notes for 0.42",
				attention: "needs-reply" as const,
			},
			{
				id: "composer",
				title: "Composer polish",
				attention: "done-unread" as const,
				updatedAt: now - 7_200_000,
			},
			{
				id: "docs",
				title: "Docs sweep",
				attention: "idle" as const,
				updatedAt: now - 259_200_000,
			},
			{
				id: "settled",
				title: "Fix flaky login test",
				attention: "idle" as const,
				settledAt: now - 3_600_000,
			},
			{
				id: "snoozed",
				title: "Review Codex adapter",
				attention: "idle" as const,
				snoozedAt: now,
				snoozedUntil: now + 3_600_000,
			},
		].map((session) => ({
			accountId: "personal",
			projectSlug: "conduit",
			status: "idle" as const,
			...session,
		})),
		sequence: now + 1,
	});
	applySessionChange({ _tag: "synchronized" });
	openSessionForSetup("typed", "conduit");
	const accounts = [
		{ id: "personal", colorSlot: 0 },
		{ id: "work", colorSlot: 1 },
		{ id: "lab", colorSlot: 2 },
		{ id: "codex", colorSlot: 4 },
	].filter(({ id }) => !singleAccount || id === "personal");
	instanceState.instances = accounts.map(({ id, colorSlot }) => ({
		...mockClaudeAccount,
		id,
		colorSlot,
		name: id,
		usageEligible: true,
	}));
	applyUsageReadings(
		accounts.map(({ id: accountId }, i) => ({
			accountId,
			harness: accountId === "codex" ? ("codex" as const) : ("claude" as const),
			status:
				accountId === "lab" ? ("limited" as const) : ("available" as const),
			windows: [
				{
					kind: "five_hour" as const,
					utilization: [42, 91, 100, 12][i] ?? 0,
					resetsAt: new Date(now + 3_600_000).toISOString(),
				},
				{ kind: "seven_day" as const, utilization: [18, 64, 71, 30][i] ?? 0 },
			],
			readAt: now,
			stale: false,
		})),
	);
}

function fitSidebarToViewport() {
	const root = document.getElementById("storybook-root");
	root?.setAttribute("style", "height:100vh");
	return () => root?.removeAttribute("style");
}

export const Final: Story = {
	beforeEach: () => {
		seedFinalSidebar();
		return fitSidebarToViewport();
	},
	play: async ({ canvasElement }) => {
		await expectSessionTitle(canvasElement);
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Fix token refresh race")).toBeVisible();
		await expect(canvas.getByTestId("usage-footer-row-work")).toBeVisible();
		await expect(canvas.getByTestId("settled-shelf-toggle")).toBeVisible();
		if (!sessionViewState.compact) {
			await expect(
				canvas.getByTestId("usage-footer-settings").getBoundingClientRect()
					.bottom,
			).toBeLessThanOrEqual(innerHeight);
		}
		await expect(canvas.queryByTitle("Pinned session")).not.toBeInTheDocument();
		if (!sessionViewState.compact) {
			const toggle = canvas.getByRole("button", { name: "Close sidebar" });
			await expect(
				toggle.querySelector("svg.lucide-panel-left"),
			).not.toBeNull();
			await expect(toggle.querySelector("polyline")).toBeNull();
		}
		const title = canvas
			.getByText("Fix token refresh race")
			.closest<HTMLElement>(".session-title-inner");
		if (!title) throw new TypeError("Pinned title is missing");
		const phone = matchMedia("(max-width: 767px)").matches;
		if (!sessionViewState.compact) {
			// The 260px sidebar reserves 16px for status before truncating this title.
			await expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
			await expect(getComputedStyle(title).overflowX).toBe("hidden");
			await expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
		} else {
			// DOM scroll widths round fractional text advances to whole CSS pixels.
			await expect(title.scrollWidth).toBeLessThanOrEqual(
				title.clientWidth + 1,
			);
		}
		await expect(getComputedStyle(title).lineHeight).toBe(
			phone ? "22.5px" : "19.5px",
		);
		const rows = canvasElement.querySelectorAll(".session-item");
		const running = rows[1];
		const next = rows[2];
		if (!running || !next) throw new TypeError("Running rows are missing");
		await expect(
			next.getBoundingClientRect().top - running.getBoundingClientRect().top,
		).toBeCloseTo(phone ? 58.25 : 49.75, 1);
		const chips = canvas.getByTestId("session-filter-chips");
		if (chips.scrollWidth > chips.clientWidth) {
			await waitFor(() =>
				expect(getComputedStyle(chips).maskImage).not.toBe("none"),
			);
			chips.scrollLeft = chips.scrollWidth;
			await waitFor(() =>
				expect(getComputedStyle(chips).maskImage).toBe("none"),
			);
			chips.scrollLeft = 0;
		} else {
			await expect(getComputedStyle(chips).maskImage).toBe("none");
		}
		if (sessionViewState.compact && phone) {
			await expect(
				canvasElement.querySelector("#sidebar")?.getBoundingClientRect().width,
			).toBe(390);
			const pill = canvas
				.getByTestId("session-scope-chip")
				.getBoundingClientRect();
			const chip = canvas.getByTestId("session-filter-chip-needs-you");
			await expect(pill.top).toBe(46);
			await expect(chip.getBoundingClientRect().top - pill.bottom).toBe(8);
			await expect(getComputedStyle(chip, "::before").minHeight).toBe("44px");
			const scroller = canvas.getByRole("region", { name: "Sessions" });
			scroller.scrollTop = scroller.scrollHeight;
			await expect(
				canvas.getByTestId("snoozed-shelf-toggle").getBoundingClientRect()
					.bottom,
			).toBeLessThanOrEqual(
				canvas.getByTestId("usage-footer-phone").getBoundingClientRect().top,
			);
			scroller.scrollTop = 0;
		}
	},
};

export const FinalLight: Story = { ...Final, globals: { theme: "light" } };

export const FinalPhone: Story = {
	...Final,
	args: { listScreen: true },
	beforeEach: () => {
		seedFinalSidebar(true);
		// Phone-tall, so the list scrolls under a pinned usage dock as in the app.
		return fitSidebarToViewport();
	},
};
export const FinalPhoneLight: Story = {
	...FinalPhone,
	globals: { theme: "light" },
};

export const NeedsYouSingleAccount: Story = {
	beforeEach: () => {
		seedFinalSidebar(false, true);
		routerState.search = "?status=needs-you";
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Approve")).toBeVisible();
		await expect(canvas.getByText("Reply")).toBeVisible();
		await expect(canvas.getByTestId("usage-footer-single")).toBeVisible();
		await expect(canvas.getByTestId("session-needs-you-end")).toHaveTextContent(
			"That's everything waiting on you.",
		);
		await expect(
			canvas.queryByTestId("session-filter-clear"),
		).not.toBeInTheDocument();
	},
};

export const NeedsYouSingleAccountLight: Story = {
	...NeedsYouSingleAccount,
	globals: { theme: "light" },
};

export const Default: Story = {
	play: async ({ canvasElement }) => {
		await expectSessionTitle(canvasElement);
		const canvas = within(canvasElement);
		const compose = canvas.getByRole("button", { name: "New session" });
		await expect(compose).toBeVisible();
		await expect(compose.querySelector(".lucide-square-pen")).not.toBeNull();
		await expect(canvas.getByTestId("list-bar-count")).toHaveTextContent("0");
		await expect(
			canvas.getByRole("button", { name: "Select sessions" }),
		).toBeVisible();
		await expect(
			canvas.getByRole("button", { name: "Close sidebar" }),
		).toBeVisible();
		await expect(
			canvas.queryByRole("button", { name: "File browser" }),
		).toBeNull();
		const originalWidth = uiState.sidebarWidth;
		try {
			for (const width of [180, 200]) {
				uiState.sidebarWidth = width;
				await waitFor(() =>
					expect(
						canvasElement.querySelector("#sidebar")?.getBoundingClientRect()
							.width,
					).toBe(width),
				);
				const label = canvas.getByText("Sessions", { exact: true });
				const count = canvas.getByTestId("list-bar-count");
				await expect(count.getBoundingClientRect().right).toBeLessThanOrEqual(
					canvas.getByTestId("list-bar-select").getBoundingClientRect().left,
				);
				await expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
				await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
				await expectSessionTitle(canvasElement);
			}
		} finally {
			uiState.sidebarWidth = originalWidth;
			await waitFor(() =>
				expect(
					canvasElement.querySelector("#sidebar")?.getBoundingClientRect()
						.width,
				).toBe(originalWidth),
			);
		}
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

export const HoverLight: Story = { ...Hover, globals: { theme: "light" } };

export const Phone: Story = {
	args: { listScreen: true },
	beforeEach: () => {
		sessionViewState.compact = true;
		uiState.sidebarWidth = 393;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const title = canvas.getByTestId("list-bar-title");
		await expectSessionTitle(canvasElement);
		await expect(title).toHaveStyle({ fontSize: "22px", fontWeight: "700" });
		await expect(canvas.getByTestId("list-bar-select")).toBeVisible();
		const settings = canvas.getByTestId("list-bar-settings");
		await expect(settings).toBeVisible();
		await expect(settings).toHaveAccessibleName("Settings");
		await expect(settings).toHaveAttribute("title", "Settings");
		await expect(settings.querySelector(".lucide-settings")).not.toBeNull();
		await expect(settings.getBoundingClientRect().width).toBe(44);
		await expect(settings.getBoundingClientRect().height).toBe(44);
		const opened = fn();
		const originalDebug = featureFlags.debug;
		window.addEventListener("settings:open", opened);
		try {
			for (const debug of [false, true]) {
				featureFlags.debug = debug;
				opened.mockClear();
				await userEvent.click(settings);
				await expect(opened).toHaveBeenCalledOnce();
				await expect(opened.mock.calls[0]?.[0].detail).toBeNull();
			}
		} finally {
			featureFlags.debug = originalDebug;
			window.removeEventListener("settings:open", opened);
		}
		await expect(
			canvas.queryByRole("button", { name: "Close sidebar" }),
		).toBeNull();
		const compose = canvas.getByRole("button", { name: "New session" });
		await expect(compose.closest("#sidebar-header")).not.toBeNull();
		await expect(
			canvasElement.querySelector("#sidebar-nav #new-session-btn"),
		).toBeNull();
		const originalUrl = window.location.href;
		const originalState: unknown = window.history.state;
		try {
			await userEvent.click(compose);
			await expect(routerState.path).toMatch(/^\/draft\/[^/]+$/);
			await expect(new URLSearchParams(routerState.search).get("project")).toBe(
				"conduit",
			);
		} finally {
			window.history.replaceState(originalState, "", originalUrl);
			routerState.path = "/";
			routerState.search = "";
		}
	},
};

export const PhoneLight: Story = { ...Phone, globals: { theme: "light" } };

export const PhoneSelect: Story = {
	...Phone,
	beforeEach: () => {
		seedFinalSidebar(true, true);
		return fitSidebarToViewport();
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Typed session list")).toBeVisible();
		await userEvent.click(canvas.getByTestId("list-bar-select"));
		await expect(canvas.getByText("0 selected")).toBeVisible();
		await expect(canvas.getByTestId("select-bar-delete")).toBeDisabled();
		for (const action of ["settle", "snooze", "pin", "delete"]) {
			await expect(
				canvas.getByTestId(`select-bar-${action}`).getBoundingClientRect()
					.bottom,
			).toBeLessThanOrEqual(innerHeight);
		}
		await expect(
			canvas.getByRole("button", { name: "New session" }),
		).toBeVisible();
	},
};

export const PhoneSelectLight: Story = {
	...PhoneSelect,
	globals: { theme: "light" },
};
