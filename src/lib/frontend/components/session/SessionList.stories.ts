import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { tick } from "svelte";
import { draftList } from "../../stores/draft-list.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
	setSearchQuery,
} from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { mockSessionsAllGroups } from "../../stories/mocks.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type { SessionInfo } from "../../types.js";
import SessionList from "./SessionList.svelte";

let sequence = 0;

function seedSessions(
	rows: readonly (Omit<SessionInfo, "status"> & {
		status?: SessionInfo["status"];
	})[],
) {
	const sessions = rows.map((row) => ({ status: "idle" as const, ...row }));
	applySessionChange({
		_tag: "snapshot",
		rows: sessions,
		sequence: ++sequence,
	});
	applySessionChange({ _tag: "synchronized" });
}

function seedDaemonSessions(
	rows: readonly (Omit<SessionInfo, "status"> & {
		status?: SessionInfo["status"];
	})[],
) {
	for (const row of rows)
		applySessionChange({
			_tag: "upsert",
			item: { status: "idle", ...row },
			sequence: ++sequence,
		});
}

function resetSessionState() {
	uiState.selectMode = false;
	uiState.settledShelfOpen = false;
	uiState.snoozedShelfOpen = false;
	uiState.sessionGroupsOpen = { pinned: true, running: true, idle: true };
	uiState.draftsTrayOpen = true;
	draftList.rows = [];
	clearSessionState();
	// Storybook shares module state across stories, and the scope lives in the
	// router, so a scoped story would otherwise scope every story after it.
	routerState.path = "/";
	routerState.search = "";
	attachedProjectState.slug = "conduit";
	projectState.projects = [
		{ slug: "conduit", title: "conduit", folders: ["/src/conduit"] },
		{ slug: "acme", title: "Acme", folders: ["/src/acme"] },
	];
}

const meta = {
	title: "Session/SessionList",
	component: SessionList,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	beforeEach: () => {
		const groupsOpen = { ...uiState.sessionGroupsOpen };
		const storedGroups = (["pinned", "running", "idle"] as const).map(
			(group) =>
				[group, localStorage.getItem(`session-group-${group}-open`)] as const,
		);
		resetSessionState();
		return () => {
			uiState.sessionGroupsOpen = groupsOpen;
			for (const [group, open] of storedGroups) {
				const key = `session-group-${group}-open`;
				if (open === null) localStorage.removeItem(key);
				else localStorage.setItem(key, open);
			}
			uiState.selectMode = false;
			attachedProjectState.slug = null;
			routerState.search = "";
		};
	},
} satisfies Meta<typeof SessionList>;

export default meta;
type Story = StoryObj<typeof meta>;

// An unsettled list draws the loading skeleton; the empty state needs the
// server to have sent an empty snapshot.
export const Empty: Story = {
	beforeEach: () => seedSessions([]),
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByText("No sessions yet"),
		).toBeVisible();
	},
};

export const SelectMode: Story = {
	name: "Select mode, two selected",
	beforeEach: () => {
		const sessions: SessionInfo[] = [
			{
				projectSlug: "conduit",
				accountId: null,
				id: "select-one",
				title: "Review build logs",
				attention: "idle",
				status: "idle",
			},
			{
				projectSlug: "conduit",
				accountId: null,
				id: "select-two",
				title: "Prepare release",
				attention: "idle",
				status: "idle",
			},
		];
		seedSessions(sessions);
		uiState.selectMode = true;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("checkbox", { name: "Select Review build logs" }),
		);
		await userEvent.click(
			canvas.getByRole("checkbox", { name: "Select Prepare release" }),
		);
		await expect(canvas.getByText("2 selected")).toBeVisible();
		await expect(canvas.getByTestId("select-bar")).toBeVisible();
		// A pointer tap leaves no ring on a phone; do not bake one into the baseline.
		(document.activeElement as HTMLElement | null)?.blur();
	},
};

const SNOOZE_STORY_NOW = new Date(2030, 9, 7, 9).getTime();

export const AllGroups: Story = {
	name: "All groups, shared collapsible headers",
	beforeEach: () => {
		sessionState.now = SNOOZE_STORY_NOW;
		uiState.settledShelfOpen = true;
		uiState.snoozedShelfOpen = true;
		seedSessions(
			(["pinned", "running", "idle", "settled", "snoozed"] as const).flatMap(
				(group) =>
					Array.from({ length: 3 }, (_, i) => ({
						id: `${group}-${i}`,
						accountId: null,
						projectSlug: "conduit",
						title: `${group} task ${i + 1}`,
						attention:
							group === "running" ? ("working" as const) : ("idle" as const),
						...(group === "pinned" ? { pinnedAt: SNOOZE_STORY_NOW } : {}),
						...(group === "settled"
							? { settledAt: SNOOZE_STORY_NOW - 3_600_000 }
							: {}),
						...(group === "snoozed"
							? {
									snoozedAt: SNOOZE_STORY_NOW,
									snoozedUntil: SNOOZE_STORY_NOW + 3_600_000,
								}
							: {}),
					})),
			),
		);
		openSessionForSetup("pinned-0");
	},
	play: async ({ canvasElement, mount }) => {
		await mount();
		const canvas = within(canvasElement);
		const groups = ["pinned", "running", "idle", "settled", "snoozed"] as const;
		const positions: {
			chevron: number;
			icon: number;
			label: number;
			height: number;
		}[] = [];
		for (const group of groups) {
			const header = canvas.getByTestId(`${group}-shelf-toggle`);
			await expect(header).toHaveRole("button");
			await expect(header).toHaveAttribute("aria-expanded", "true");
			await expect(header).toHaveAttribute(
				"aria-controls",
				`${group}-shelf-rows`,
			);
			await expect(header).toHaveTextContent(/3$/);
			const chevron = header.querySelector("svg");
			const icon = header.querySelector(".session-status-glyph");
			const label = header.querySelector("[data-group-label]");
			if (!chevron || !icon || !label)
				throw new Error(`Missing ${group} header parts`);
			const bounds = header.getBoundingClientRect();
			const centre = (part: Element) => {
				const rect = part.getBoundingClientRect();
				return rect.y + rect.height / 2 - bounds.y;
			};
			const centres = {
				chevron: centre(chevron),
				icon: centre(icon),
				label: centre(label),
			};
			await expect(
				Math.max(...Object.values(centres)) -
					Math.min(...Object.values(centres)),
			).toBeLessThanOrEqual(1);
			for (const centre of Object.values(centres)) {
				await expect(Math.abs(centre - bounds.height / 2)).toBeLessThanOrEqual(
					1,
				);
			}
			positions.push({
				...centres,
				height: bounds.height,
			});
			if (matchMedia("(pointer: coarse)").matches)
				await expect(bounds.height).toBeGreaterThanOrEqual(44);
			await expect(icon).toHaveAttribute(
				"data-state",
				group === "running" ? "working" : group,
			);
		}
		for (const part of ["chevron", "icon", "label", "height"] as const) {
			const values = positions.map((position) => position[part]);
			await expect(
				Math.max(...values) - Math.min(...values),
			).toBeLessThanOrEqual(1);
		}
		await expect(
			canvas
				.getByTestId("pinned-shelf-toggle")
				.querySelector("svg.lucide-pin.text-status-pinned"),
		).not.toBeNull();
		await expect(
			canvas
				.getByTestId("settled-shelf-toggle")
				.querySelector("svg.lucide-check"),
		).not.toBeNull();
		await expect(
			canvas
				.getByTestId("snoozed-shelf-toggle")
				.querySelector("svg.lucide-moon"),
		).not.toBeNull();
		const running = canvas
			.getByTestId("running-shelf-toggle")
			.querySelector("[data-flow-packet]");
		const idle = canvas
			.getByTestId("idle-shelf-toggle")
			.querySelector('[data-flow-glyph="idle"]');
		if (!running || !idle) throw new Error("Missing Flow status glyphs");
		await expect(getComputedStyle(running).animationName).toBe("none");
		await expect(idle.querySelector("[data-flow-packet]")).toBeNull();

		for (const group of ["pinned", "running", "idle"] as const) {
			const header = canvas.getByTestId(`${group}-shelf-toggle`);
			await expect(
				canvasElement.querySelectorAll(`#${group}-shelf-rows .session-item`),
			).toHaveLength(3);
			await userEvent.click(header);
			await expect(header).toHaveAttribute("aria-expanded", "false");
			await expect(
				canvasElement.querySelectorAll(`#${group}-shelf-rows .session-item`),
			).toHaveLength(0);
			await expect(localStorage.getItem(`session-group-${group}-open`)).toBe(
				"false",
			);
		}
		// Closing the active session's group leaves it closed, just like the shelves.
		await expect(sessionState.currentId).toBe("pinned-0");
		const previousHeader = canvas.getByTestId("pinned-shelf-toggle");
		await mount();
		await expect(canvas.getByTestId("pinned-shelf-toggle")).not.toBe(
			previousHeader,
		);
		for (const group of ["pinned", "running", "idle"] as const) {
			const header = canvas.getByTestId(`${group}-shelf-toggle`);
			await expect(header).toHaveAttribute("aria-expanded", "false");
			await expect(
				canvasElement.querySelectorAll(`#${group}-shelf-rows .session-item`),
			).toHaveLength(0);
		}
		// Search exposes matches without overwriting any of the saved closed states.
		setSearchQuery("task");
		await tick();
		for (const group of ["pinned", "running", "idle"] as const) {
			const header = canvas.getByTestId(`${group}-shelf-toggle`);
			await expect(header).toHaveAttribute("aria-expanded", "true");
			await userEvent.click(header);
			await expect(localStorage.getItem(`session-group-${group}-open`)).toBe(
				"false",
			);
		}
		setSearchQuery("");
		await tick();
		await expect(canvas.getByTestId("pinned-shelf-toggle")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		canvas.getByTestId("pinned-shelf-toggle").focus();
		await userEvent.keyboard("j");
		await expect(
			canvasElement.querySelector("#settled-shelf-rows .session-item"),
		).toHaveFocus();
		for (const group of ["pinned", "running", "idle"] as const) {
			const header = canvas.getByTestId(`${group}-shelf-toggle`);
			await userEvent.click(header);
			await expect(header).toHaveAttribute("aria-expanded", "true");
			await expect(
				canvasElement.querySelectorAll(`#${group}-shelf-rows .session-item`),
			).toHaveLength(3);
			await expect(localStorage.getItem(`session-group-${group}-open`)).toBe(
				"true",
			);
		}
		await expect(canvas.getByTestId("settled-shelf-more")).toHaveTextContent(
			"1 more",
		);
		await expect(canvas.getByTestId("snoozed-shelf-more")).toHaveTextContent(
			"1 more",
		);
		// Keep all five headers in the phone capture after exercising every row.
		for (const group of ["pinned", "running", "idle"] as const) {
			await userEvent.click(canvas.getByTestId(`${group}-shelf-toggle`));
		}
		(document.activeElement as HTMLElement | null)?.blur();
	},
};

export const SnoozedShelfCollapsed: Story = {
	name: "Snoozed shelf collapsed",
	beforeEach: () => {
		sessionState.now = SNOOZE_STORY_NOW;
		seedSessions([
			{
				projectSlug: "conduit",
				accountId: null,
				id: "sleeping",
				title: "Review build logs",
				attention: "idle",
				snoozedAt: SNOOZE_STORY_NOW,
				snoozedUntil: new Date(2030, 9, 8, 9).getTime(),
			},
			{
				accountId: null,
				id: "working",
				title: "Prepare release",
				attention: "working",
				projectSlug: "conduit",
			},
		]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("snoozed-shelf-toggle")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(
			canvas.queryByText("Review build logs"),
		).not.toBeInTheDocument();
	},
};

export const SnoozedShelfOpen: Story = {
	name: "Snoozed shelf open",
	beforeEach: () => {
		uiState.snoozedShelfOpen = true;
		sessionState.now = SNOOZE_STORY_NOW;
		seedSessions([
			{
				projectSlug: "conduit",
				accountId: null,
				id: "sleeping",
				title: "Review build logs",
				attention: "idle",
				snoozedAt: SNOOZE_STORY_NOW,
				snoozedUntil: new Date(2030, 9, 8, 9).getTime(),
			},
			{
				projectSlug: "conduit",
				accountId: null,
				id: "untimed",
				title: "Wait for update",
				attention: "idle",
				snoozedAt: SNOOZE_STORY_NOW,
			},
		]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("snoozed-shelf-toggle")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(canvas.getByText("Tue", { exact: true })).toBeVisible();
		await expect(canvas.getByText("No timer")).toBeVisible();
	},
};

export const SnoozedDeadlineFormats: Story = {
	beforeEach: () => {
		uiState.snoozedShelfOpen = true;
		sessionState.now = SNOOZE_STORY_NOW;
		seedSessions(
			[7, 8, 13, 14].map((day) => ({
				projectSlug: "conduit",
				accountId: null,
				id: `deadline-${day}`,
				title: `Review on October ${day}`,
				attention: "idle" as const,
				snoozedAt: SNOOZE_STORY_NOW,
				snoozedUntil: new Date(2030, 9, day, 18).getTime(),
			})),
		);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("snoozed-shelf-more"));
		await expect(
			canvas.getByText(
				new Intl.DateTimeFormat(undefined, {
					hour: "numeric",
					minute: "2-digit",
				})
					.format(new Date(2030, 9, 7, 18))
					.toLowerCase(),
				{ exact: true },
			),
		).toBeVisible();
		await expect(canvas.getByText("Tue", { exact: true })).toBeVisible();
		await expect(canvas.getByText("Sun", { exact: true })).toBeVisible();
		await expect(canvas.getByText("14 Oct", { exact: true })).toBeVisible();
	},
};

export const PinnedAndSettledShelfCollapsed: Story = {
	name: "Pinned and settled, shelf collapsed",
	beforeEach: () => {
		seedSessions([
			...mockSessionsAllGroups,
			{
				projectSlug: "conduit",
				accountId: null,
				id: "pinned",
				title: "Review authentication",
				attention: "needs-approval",
				pinnedAt: Date.now() - 300_000,
			},
			{
				projectSlug: "conduit",
				accountId: null,
				id: "settled",
				title: "Fix navigation",
				attention: "done-unread",
				settledAt: Date.now() - 120_000,
			},
		]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("settled-shelf-toggle")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(canvas.queryByText("Fix navigation")).not.toBeInTheDocument();
	},
};

export const PinnedAndSettledShelfOpen: Story = {
	name: "Pinned and settled, shelf open",
	beforeEach: () => {
		uiState.settledShelfOpen = true;
		seedSessions([
			...mockSessionsAllGroups,
			{
				projectSlug: "conduit",
				accountId: null,
				id: "pinned",
				title: "Review authentication",
				attention: "needs-approval",
				pinnedAt: Date.now() - 300_000,
			},
			{
				projectSlug: "conduit",
				accountId: null,
				id: "settled",
				title: "Fix navigation",
				attention: "done-unread",
				settledAt: Date.now() - 120_000,
			},
		]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("settled-shelf-toggle")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(canvas.getByText("Fix navigation")).toBeVisible();
	},
};

const pinnedSession = {
	projectSlug: "conduit",
	accountId: null,
	id: "pinned",
	title: "Review authentication",
	attention: "needs-approval",
	pinnedAt: Date.now() - 300_000,
} as const;

function seedDrafts() {
	const root = document.getElementById("storybook-root");
	const previousStyle = root?.getAttribute("style") ?? null;
	root?.setAttribute(
		"style",
		"width:340px;max-width:100%;padding:0;box-sizing:border-box;border:1px solid var(--color-border);border-radius:12px;background:var(--color-sidebar-bg)",
	);
	const now = Date.now();
	sessionState.now = now;
	projectState.projects = [
		...projectState.projects,
		{ slug: "api", title: "api", folders: ["/src/api"] },
	];
	draftList.rows = [
		{
			draftId: "d1",
			imageCount: 0,
			fileCount: 0,
			projectSlug: "conduit",
			firstLine: "Plan the next release, starting with the drafts work",
			updatedAt: now - 120_000,
		},
		{
			draftId: "d2",
			imageCount: 0,
			fileCount: 0,
			projectSlug: "api",
			firstLine:
				"Refactor the relay stack so each provider adapter owns its own poller",
			updatedAt: now - 3_600_000,
		},
		{
			draftId: "d3",
			imageCount: 0,
			fileCount: 0,
			projectSlug: "conduit",
			firstLine: "Why does the replay suite flake on the second run?",
			updatedAt: now - 86_400_000,
		},
	];
	const ages = [0, 2 * 3_600_000, 19 * 3_600_000, 86_400_000];
	seedSessions([
		...mockSessionsAllGroups.slice(0, 4).map((session, index) => ({
			...session,
			createdAt: now - (ages[index] ?? 0),
			updatedAt: now - (ages[index] ?? 0),
			unread: false,
		})),
		pinnedSession,
		{
			projectSlug: "conduit",
			accountId: null,
			id: "drafts-settled",
			title: "Completed release prep",
			settledAt: now - 86_400_000,
			updatedAt: now - 86_400_000,
		},
	]);
	return () => {
		if (previousStyle === null) root?.removeAttribute("style");
		else root?.setAttribute("style", previousStyle);
	};
}

export const DraftsTrayOpen: Story = {
	name: "Drafts tray open",
	beforeEach: seedDrafts,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("drafts-tray-toggle")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(canvas.getAllByTestId("draft-row")).toHaveLength(3);
		await expect(canvas.getByTestId("drafts-tray-clear")).toHaveTextContent(
			"Clear all",
		);
	},
};

export const DraftsTrayCollapsed: Story = {
	name: "Drafts tray collapsed",
	beforeEach: () => {
		uiState.draftsTrayOpen = false;
		return seedDrafts();
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.queryByTestId("draft-row")).not.toBeInTheDocument();
		await expect(
			canvas.queryByTestId("drafts-tray-clear"),
		).not.toBeInTheDocument();
		await expect(canvas.getByTestId("drafts-tray-toggle")).toHaveTextContent(
			"Plan the next release",
		);
	},
};

export const WithItems: Story = {
	beforeEach: () => {
		seedSessions([...mockSessionsAllGroups]);
		const firstSession = mockSessionsAllGroups[0];
		if (firstSession !== undefined) {
			openSessionForSetup(firstSession.id, "conduit");
		}
	},
};

export const IdleGrouping: Story = {
	name: "Idle combines attention states",
	beforeEach: () => {
		seedSessions([
			...(
				[
					"needs-approval",
					"needs-reply",
					"error",
					"done-unread",
					"idle",
					"working",
					"monitoring",
				] as const
			).map((attention) => ({
				id: attention,
				title: attention,
				projectSlug: "conduit",
				accountId: null,
				attention,
			})),
		]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const labels = [...canvasElement.querySelectorAll(".session-group-label")];
		await expect(labels.map((label) => label.textContent?.trim())).toEqual([
			"Running 2",
			"Idle 5",
		]);
		await expect(canvas.getByLabelText(/^Needs approval,/)).toBeVisible();
		await expect(canvas.getByLabelText(/^Needs reply,/)).toBeVisible();
		await expect(canvas.getByLabelText(/^Failed,/)).toBeVisible();
		await expect(canvas.getByLabelText(/^Done, unread,/)).toBeVisible();
		await userEvent.click(canvas.getByTestId("session-filter-chip-needs-you"));
		await expect(canvasElement.querySelectorAll(".session-item")).toHaveLength(
			3,
		);
		await expect(canvas.getByText("Idle", { exact: true })).toBeVisible();
		await userEvent.click(canvas.getByTestId("session-filter-chip-needs-you"));
	},
};

export const FilteredToNeedsYou: Story = {
	name: "Filtered to needs you",
	beforeEach: () => {
		seedSessions([
			...mockSessionsAllGroups,
			{
				projectSlug: "conduit",
				accountId: null,
				id: "approval",
				title: "Approve deployment",
				attention: "needs-approval",
			},
		]);
		routerState.search = "?status=needs-you";
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("session-filter-chip-needs-you"),
		).toHaveAttribute("aria-pressed", "true");
		await expect(canvas.getByText("Approve deployment")).toBeVisible();
	},
};

export const FilterMatchesNothing: Story = {
	name: "Filter matches nothing",
	beforeEach: () => {
		seedSessions([
			{
				accountId: null,
				id: "idle",
				title: "Plan release",
				attention: "idle",
				projectSlug: "conduit",
			},
		]);
		routerState.search = "?status=unread";
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-filter-empty")).toHaveTextContent(
			"Nothing unread",
		);
		await expect(canvas.getByTestId("session-filter-clear")).toBeVisible();
	},
};

export const NeedsYouEmpty: Story = {
	name: "Needs you, everything handled",
	beforeEach: () => {
		seedSessions([
			{
				id: "quiet",
				accountId: null,
				title: "Docs sweep",
				attention: "idle",
				projectSlug: "conduit",
			},
		]);
		routerState.search = "?status=needs-you";
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-filter-empty")).toHaveTextContent(
			"That's everything waiting on you.",
		);
		await expect(
			canvas.queryByTestId("session-filter-clear"),
		).not.toBeInTheDocument();
		await userEvent.click(canvas.getByTestId("session-filter-chip-needs-you"));
		await expect(canvas.getByText("Docs sweep")).toBeVisible();
		await userEvent.click(canvas.getByTestId("session-filter-chip-needs-you"));
	},
};

export const ShelvesWithMore: Story = {
	name: "Shelves with more",
	beforeEach: () => {
		sessionState.now = SNOOZE_STORY_NOW;
		uiState.settledShelfOpen = true;
		uiState.snoozedShelfOpen = true;
		seedSessions([
			...Array.from({ length: 14 }, (_, i) => ({
				id: `settled-${i}`,
				accountId: null,
				projectSlug: "conduit",
				title: `Settled task ${i + 1}`,
				attention: "idle" as const,
				settledAt: SNOOZE_STORY_NOW - (i + 1) * 3_600_000,
				git: { branch: `fix/task-${i + 1}` },
			})),
			...Array.from({ length: 4 }, (_, i) => ({
				id: `snoozed-${i}`,
				accountId: null,
				projectSlug: "conduit",
				title: `Snoozed task ${i + 1}`,
				attention: "idle" as const,
				snoozedAt: SNOOZE_STORY_NOW,
				snoozedUntil: SNOOZE_STORY_NOW + 3_600_000,
			})),
		]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const settled = canvas.getByTestId("settled-shelf-toggle");
		const snoozed = canvas.getByTestId("snoozed-shelf-toggle");
		await expect(
			settled.compareDocumentPosition(snoozed) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		await expect(canvas.getByTestId("settled-shelf-more")).toHaveTextContent(
			/^12 more$/,
		);
		await expect(canvas.getByTestId("snoozed-shelf-more")).toHaveTextContent(
			/^2 more$/,
		);
		await userEvent.click(canvas.getByTestId("settled-shelf-more"));
		await expect(
			within(
				canvasElement.querySelector("#settled-shelf-rows") as HTMLElement,
			).getAllByText(/^Settled task/),
		).toHaveLength(14);
		await userEvent.click(settled);
		await userEvent.click(settled);
		await expect(canvas.getByTestId("settled-shelf-more")).toBeVisible();
		// The capture shows the shelves at rest, not the toggle's focus ring.
		settled.blur();
	},
};

export const SettledCountBeforeRows: Story = {
	name: "Settled count before its shelf opens",
	beforeEach: () => {
		seedSessions(
			Array.from({ length: 14 }, (_, i) => ({
				id: `count-before-rows-${i}`,
				accountId: null,
				projectSlug: "acme",
				title: `Settled task ${i + 1}`,
				settledAt: SNOOZE_STORY_NOW - (i + 1) * 3_600_000,
			})),
		);
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("settled-shelf-toggle"),
		).toHaveTextContent("Settled 14");
	},
};

export const GroupedByProject: Story = {
	name: "Grouped by project",
	beforeEach: () => {
		seedSessions([
			{
				accountId: null,
				id: "local",
				title: "Build sidebar",
				attention: "working",
				projectSlug: "conduit",
			},
		]);
		seedDaemonSessions([
			{
				accountId: null,
				id: "foreign",
				title: "Review release",
				attention: "idle",
				projectSlug: "acme",
			},
		]);
		routerState.search = "?group=project";
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-group-chip")).toHaveTextContent(
			"By project",
		);
		await expect(
			canvas.getByText("Acme", { selector: ".session-group-label span" }),
		).toBeVisible();
	},
};

export const Searching: Story = {
	beforeEach: () => {
		seedSessions([...mockSessionsAllGroups]);
		setSearchQuery("dark");
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByRole("textbox", { name: "Search sessions" }),
		).toHaveValue("dark");
	},
};

export const Hover: Story = {
	...Empty,
	parameters: { pseudo: { hover: true } },
};

// `/` is the way into the always-visible field from anywhere outside a text
// box. This is the assertion: the field has no other focus path to regress.
export const SearchFocused: Story = {
	beforeEach: () => {
		seedSessions([...mockSessionsAllGroups]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.keyboard("/");
		await expect(canvas.getByPlaceholderText("Search")).toHaveFocus();
	},
};

// The mock sessions are all this project's, so scoping to another project
// shows the scoped empty state and the chip with its clear button.
export const Scoped: Story = {
	beforeEach: () => {
		seedSessions([...mockSessionsAllGroups]);
		routerState.search = "?p=acme";
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-scope-chip")).toHaveTextContent(
			"Acme",
		);
		await expect(canvas.getByText("No sessions in Acme")).toBeVisible();
		const trigger = canvas.getByTestId("session-scope-chip");
		const pill = trigger.parentElement;
		if (!pill) throw new TypeError("Scope pill is missing");
		const clear = canvas.getByRole("button", { name: "Clear project scope" });
		await expect(pill.getBoundingClientRect().height).toBe(30);
		await expect(getComputedStyle(pill).borderRadius).toBe("9px");
		await expect(getComputedStyle(pill).backgroundColor).not.toBe(
			"rgba(0, 0, 0, 0)",
		);
		await expect(getComputedStyle(trigger).backgroundColor).toBe(
			"rgba(0, 0, 0, 0)",
		);
		await expect(
			pill.getBoundingClientRect().right - clear.getBoundingClientRect().right,
		).toBe(6);
		if (matchMedia("(max-width: 767px)").matches) {
			await expect(getComputedStyle(clear, "::before").minHeight).toBe("44px");
		}
	},
};

export const ScopePickerOpen: Story = {
	beforeEach: () => {
		seedSessions([...mockSessionsAllGroups]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-scope-chip"));
		// The menu is portalled to the body, outside the story's canvas.
		const menu = within(canvasElement.ownerDocument.body);
		await expect(
			await menu.findByRole("menuitemradio", { name: /All projects/ }),
		).toHaveAttribute("aria-checked", "true");
		await expect(menu.getByText("project:acme")).toBeVisible();
	},
};

function seedCheckoutScope(projectOnly: boolean) {
	projectState.projects = [
		{
			slug: "conduit",
			title: "Main checkout",
			folders: ["/src/conduit"],
			repositoryIdentities: {
				"/src/conduit": {
					key: "github.com/acme/conduit",
					name: "Conduit",
					root: "/src/conduit",
				},
			},
		},
		{
			slug: "conduit-review",
			title: "Review checkout",
			folders: ["/src/conduit-review"],
			repositoryIdentities: {
				"/src/conduit-review": {
					key: "github.com/acme/conduit",
					name: "Conduit",
					root: "/src/conduit-review",
				},
			},
		},
	];
	seedSessions([
		{
			projectSlug: "conduit",
			accountId: null,
			id: "scope-main",
			title: "Implement project scope",
			attention: "working",
		},
	]);
	seedDaemonSessions([
		{
			accountId: null,
			id: "scope-review",
			title: "Review the scope menu",
			attention: "idle",
			projectSlug: "conduit-review",
		},
	]);
	routerState.search = projectOnly ? "?p=conduit" : "";
}

export const SharedRepositoryProjects: Story = {
	name: "All projects, shared repository",
	beforeEach: () => seedCheckoutScope(false),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-scope-chip")).toHaveTextContent(
			"All projects",
		);
		await expect(canvas.getByText("Implement project scope")).toBeVisible();
		await expect(canvas.getByText("Review the scope menu")).toBeVisible();
	},
};

export const CheckoutScope: Story = {
	name: "One checkout scope",
	beforeEach: () => seedCheckoutScope(true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("session-scope-chip")).toHaveTextContent(
			"Main checkout",
		);
		await expect(canvas.getByText("Implement project scope")).toBeVisible();
		await expect(
			canvas.queryByText("Review the scope menu"),
		).not.toBeInTheDocument();
	},
};

export const SharedRepositoryPickerOpen: Story = {
	name: "Shared repository project choices",
	tags: ["viewport-capture"],
	beforeEach: () => seedCheckoutScope(false),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-scope-chip"));
		const menu = within(canvasElement.ownerDocument.body);
		await expect(
			await menu.findByRole("menuitemradio", { name: /All projects/ }),
		).toHaveAttribute("aria-checked", "true");
		await expect(menu.getByText("project:conduit-review")).toBeVisible();
	},
};

export const CheckoutScopePickerOpen: Story = {
	name: "Selected checkout scope menu",
	tags: ["viewport-capture"],
	beforeEach: () => seedCheckoutScope(true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-scope-chip"));
		const menu = within(canvasElement.ownerDocument.body);
		await expect(
			await menu.findByRole("menuitemradio", {
				name: /Main checkout/,
			}),
		).toHaveAttribute("aria-checked", "true");
		await expect(
			menu.getByRole("menuitemradio", { name: /All projects/ }),
		).toHaveAttribute("aria-checked", "false");
	},
};

export const ScopePickerSelecting: Story = {
	beforeEach: () => {
		seedSessions([...mockSessionsAllGroups]);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("session-scope-chip"));
		const menu = within(canvasElement.ownerDocument.body);
		await userEvent.click(await menu.findByTestId("session-scope-select"));
		const row = await menu.findByRole("menuitemcheckbox", { name: /conduit/ });
		await userEvent.click(row);
		// The menu stays open in select mode, so a pick only toggles the row.
		await expect(row).toHaveAttribute("aria-checked", "true");
		await expect(
			menu.getByTestId("session-scope-remove-selected"),
		).toHaveTextContent("Remove 1 project");
	},
};
