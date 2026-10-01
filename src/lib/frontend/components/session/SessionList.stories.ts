import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { projectState } from "../../stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../stores/router.svelte.js";
import {
	applyListDaemonSessionsResponse,
	clearSessionState,
	requestNewSession,
	resetSessionCreation,
	sessionState,
	setSearchQuery,
} from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { mockSessionsAllGroups } from "../../stories/mocks.js";
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
	applyListDaemonSessionsResponse({
		sessions: rows.map((row) => ({ status: "idle", ...row })),
		availability: [],
		hasMore: false,
		nextCursor: null,
	});
}

function resetSessionState() {
	uiState.selectMode = false;
	uiState.settledShelfOpen = false;
	uiState.snoozedShelfOpen = false;
	clearSessionState();
	// Storybook shares module state across stories, and the scope lives in the
	// router, so a scoped story would otherwise scope every story after it.
	routerState.path = "/";
	routerState.search = "";
	attachedProjectState.slug = "conduit";
	projectState.projects = [
		{ slug: "conduit", title: "conduit", directory: "/src/conduit" },
		{ slug: "acme", title: "Acme", directory: "/src/acme" },
	];
}

const meta = {
	title: "Session/SessionList",
	component: SessionList,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	beforeEach: () => {
		resetSessionState();
		return () => {
			uiState.selectMode = false;
			attachedProjectState.slug = null;
			routerState.search = "";
		};
	},
} satisfies Meta<typeof SessionList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const SelectMode: Story = {
	name: "Select mode, two selected",
	beforeEach: () => {
		const sessions: SessionInfo[] = [
			{
				id: "select-one",
				title: "Review build logs",
				attention: "idle",
				status: "idle",
			},
			{
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

export const SnoozedShelfCollapsed: Story = {
	name: "Snoozed shelf collapsed",
	beforeEach: () => {
		sessionState.now = SNOOZE_STORY_NOW;
		seedSessions([
			{
				id: "sleeping",
				title: "Review build logs",
				attention: "idle",
				snoozedAt: SNOOZE_STORY_NOW,
				snoozedUntil: new Date(2030, 9, 8, 9).getTime(),
			},
			{ id: "working", title: "Prepare release", attention: "working" },
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
				id: "sleeping",
				title: "Review build logs",
				attention: "idle",
				snoozedAt: SNOOZE_STORY_NOW,
				snoozedUntil: new Date(2030, 9, 8, 9).getTime(),
			},
			{
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
		await expect(canvas.getByText("Tue 9:00")).toBeVisible();
		await expect(canvas.getByText("No timer")).toBeVisible();
	},
};

export const PinnedAndSettledShelfCollapsed: Story = {
	name: "Pinned and settled, shelf collapsed",
	beforeEach: () => {
		seedSessions([
			...mockSessionsAllGroups,
			{
				id: "pinned",
				title: "Review authentication",
				attention: "needs-approval",
				pinnedAt: Date.now() - 300_000,
			},
			{
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
				id: "pinned",
				title: "Review authentication",
				attention: "needs-approval",
				pinnedAt: Date.now() - 300_000,
			},
			{
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

export const WithItems: Story = {
	beforeEach: () => {
		seedSessions([...mockSessionsAllGroups]);
		const firstSession = mockSessionsAllGroups[0];
		if (firstSession !== undefined) {
			sessionState.currentId = firstSession.id;
			routerState.path = `/s/${sessionState.currentId}`;
		}
	},
};

export const FilteredToNeedsYou: Story = {
	name: "Filtered to needs you",
	beforeEach: () => {
		seedSessions([
			...mockSessionsAllGroups,
			{
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
		seedSessions([{ id: "idle", title: "Plan release", attention: "idle" }]);
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

export const GroupedByProject: Story = {
	name: "Grouped by project",
	beforeEach: () => {
		seedSessions([
			{ id: "local", title: "Build sidebar", attention: "working" },
		]);
		seedDaemonSessions([
			{
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
};

export const Hover: Story = {
	...Empty,
	parameters: { pseudo: { hover: true } },
};

export const Loading: Story = {
	...Empty,
	beforeEach: () => {
		resetSessionCreation();
		requestNewSession();
		return resetSessionCreation;
	},
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
		await expect(
			canvas.getByPlaceholderText("Search sessions..."),
		).toHaveFocus();
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
