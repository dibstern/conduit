import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { projectState } from "../../stores/project.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import {
	requestNewSession,
	resetSessionCreation,
	sessionState,
	setSearchQuery,
} from "../../stores/session.svelte.js";
import { mockSessionsAllGroups } from "../../stories/mocks.js";
import SessionList from "./SessionList.svelte";

function resetSessionState() {
	sessionState.rootSessions = [];
	sessionState.familySessions = [];
	sessionState.daemonSessions = [];
	sessionState.daemonUnavailableProjects = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.daemonCursor = null;
	sessionState.daemonHasMore = false;
	sessionState.searchCursor = null;
	sessionState.searchHasMore = false;
	// Storybook shares module state across stories, and the scope lives in the
	// router, so a scoped story would otherwise scope every story after it.
	routerState.path = "/p/conduit/";
	routerState.search = "";
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
	},
} satisfies Meta<typeof SessionList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithItems: Story = {
	beforeEach: () => {
		sessionState.rootSessions = [...mockSessionsAllGroups];
		sessionState.familySessions = [...mockSessionsAllGroups];
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		sessionState.currentId = mockSessionsAllGroups[0]!.id;
	},
};

export const Searching: Story = {
	beforeEach: () => {
		sessionState.rootSessions = [...mockSessionsAllGroups];
		sessionState.familySessions = [...mockSessionsAllGroups];
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
		sessionState.rootSessions = [...mockSessionsAllGroups];
		sessionState.familySessions = [...mockSessionsAllGroups];
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
		sessionState.rootSessions = [...mockSessionsAllGroups];
		sessionState.familySessions = [...mockSessionsAllGroups];
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
		sessionState.rootSessions = [...mockSessionsAllGroups];
		sessionState.familySessions = [...mockSessionsAllGroups];
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
