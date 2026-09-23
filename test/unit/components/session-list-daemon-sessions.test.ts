import { cleanup, fireEvent, render, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SessionList from "../../../src/lib/frontend/components/session/SessionList.svelte";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	routerState,
	syncSlugState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	applyListDaemonSessionsResponse,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";

describe("SessionList daemon sessions", () => {
	beforeEach(() => {
		routerState.path = "/p/current-project/";
		syncSlugState(routerState.path);
		uiState.hideSubagentSessions = true;
		sessionState.rootSessions = [
			{
				id: "local-session",
				title: "Local session",
				updatedAt: Date.now(),
			},
		];
		sessionState.allSessions = [...sessionState.rootSessions];
		sessionState.daemonSessions = [];
		sessionState.searchResults = null;
		sessionState.searchQuery = "";
		sessionState.currentId = "local-session";
		sessionState.sessions.clear();
		projectState.projects = [
			{
				slug: "current-project",
				title: "Current project",
				directory: "/projects/current",
			},
			{
				slug: "another-project",
				title: "Another project",
				directory: "/projects/another",
			},
		];
	});

	afterEach(() => {
		cleanup();
	});

	it("renders a foreign row as a navigate-only link with a project label", async () => {
		applyListDaemonSessionsResponse({
			projectSlug: "current-project",
			sessions: [
				{
					id: "foreign-session",
					title: "Foreign session",
					projectSlug: "unlisted-project",
					updatedAt: Date.now() - 1,
				},
			],
			availability: [{ projectSlug: "unlisted-project", available: true }],
			hasMore: false,
			nextCursor: null,
		});

		const view = render(SessionList);
		const foreignRow = view.container.querySelector<HTMLAnchorElement>(
			'[data-session-id="foreign-session"]',
		);
		const localRow = view.container.querySelector<HTMLAnchorElement>(
			'[data-session-id="local-session"]',
		);
		expect(foreignRow).not.toBeNull();
		expect(localRow).not.toBeNull();
		if (!foreignRow || !localRow) return;

		expect(foreignRow.getAttribute("href")).toBe(
			"/p/unlisted-project/s/foreign-session",
		);
		expect(within(foreignRow).getByText("unlisted-project")).toBeDefined();
		expect(
			within(foreignRow).queryByRole("button", { name: /More options/ }),
		).toBeNull();
		expect(
			within(localRow).getByRole("button", { name: /More options/ }),
		).toBeDefined();

		await fireEvent.dblClick(within(foreignRow).getByText("Foreign session"));
		expect(within(foreignRow).queryByRole("textbox")).toBeNull();

		await fireEvent.click(
			view.getByRole("button", { name: "Cleanup sessions" }),
		);
		expect(within(foreignRow).queryByRole("checkbox")).toBeNull();
		expect(
			within(localRow).getByRole("checkbox").getAttribute("aria-checked"),
		).toBe("false");

		await fireEvent.click(view.getByRole("button", { name: "Select all" }));
		expect(
			within(localRow).getByRole("checkbox").getAttribute("aria-checked"),
		).toBe("true");
	});

	// The merged list is ambiguous if only foreign rows are named: an unlabelled
	// row would be asking the reader to know which project they are in.
	it("names the project on the current project's rows too, once a second project exists", () => {
		const view = render(SessionList);
		const localRow = view.container.querySelector<HTMLAnchorElement>(
			'[data-session-id="local-session"]',
		);
		expect(localRow).not.toBeNull();
		if (!localRow) return;
		expect(within(localRow).getByText("Current project")).toBeDefined();
	});

	it("names no project on any row when only one project is registered", () => {
		projectState.projects = [
			{
				slug: "current-project",
				title: "Current project",
				directory: "/projects/current",
			},
		];

		const view = render(SessionList);
		const localRow = view.container.querySelector<HTMLAnchorElement>(
			'[data-session-id="local-session"]',
		);
		expect(localRow).not.toBeNull();
		if (!localRow) return;
		expect(within(localRow).queryByText("Current project")).toBeNull();
	});

	it("says which projects are missing from the list, naming them by title", () => {
		applyListDaemonSessionsResponse({
			projectSlug: "current-project",
			sessions: [],
			availability: [
				{ projectSlug: "current-project", available: true },
				{
					projectSlug: "another-project",
					available: false,
					error: "ENOENT: no such directory",
				},
			],
			hasMore: false,
			nextCursor: null,
		});

		const view = render(SessionList);
		const notice = view.getByTestId("session-list-unavailable");
		expect(notice.textContent).toContain("Another project");
	});

	// The case the notice exists for: an unreadable project leaves nothing to
	// show, and the empty message would otherwise claim there is nothing to see.
	it("still says a project is missing when that leaves the list empty", () => {
		sessionState.rootSessions = [];
		sessionState.allSessions = [];
		applyListDaemonSessionsResponse({
			projectSlug: "current-project",
			sessions: [],
			availability: [
				{
					projectSlug: "another-project",
					available: false,
					error: "ENOENT: no such directory",
				},
			],
			hasMore: false,
			nextCursor: null,
		});

		const view = render(SessionList);
		expect(view.getByTestId("session-list-unavailable")).toBeDefined();
	});

	it("clears the missing-project notice once every project reads cleanly", () => {
		applyListDaemonSessionsResponse({
			projectSlug: "current-project",
			sessions: [],
			availability: [
				{ projectSlug: "another-project", available: false, error: "gone" },
			],
			hasMore: false,
			nextCursor: null,
		});
		applyListDaemonSessionsResponse({
			projectSlug: "current-project",
			sessions: [],
			availability: [{ projectSlug: "another-project", available: true }],
			hasMore: false,
			nextCursor: null,
		});

		const view = render(SessionList);
		expect(view.queryByTestId("session-list-unavailable")).toBeNull();
	});
});
