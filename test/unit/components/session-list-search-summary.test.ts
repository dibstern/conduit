import { clearSessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	seedDaemonSessions,
	seedFamilySessions,
	seedRootSessions,
	seedSearchResults,
} from "../stores/session-fixtures.js";
// The sidebar must say how many sessions matched without ever claiming to know
// the size of the whole match set: a trailing "+" is what keeps the number
// honest while pages remain.

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SessionList from "../../../src/lib/frontend/components/session/SessionList.svelte";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

describe("SessionList search summary", () => {
	beforeEach(() => {
		clearSessionState();
		routerState.path = "/";
		attachedProjectState.slug = "current-project";
		routerState.search = "";
		routerState.sessionNotFound = false;
		seedRootSessions([]);
		seedFamilySessions("root-a", []);
		seedDaemonSessions([]);
		sessionState.currentId = null;
		sessionState.searchQuery = "report";
		seedSearchResults([
			{ id: "a", title: "Report one", projectSlug: "other-project" },
			{ id: "b", title: "Report two", projectSlug: "other-project" },
		]);
		projectState.projects = [
			{
				slug: "current-project",
				title: "Current project",
				folders: ["/projects/current"],
			},
			{
				slug: "other-project",
				title: "Other project",
				folders: ["/projects/other"],
			},
		];
	});

	afterEach(() => {
		cleanup();
	});

	it("shows and dismisses the missing-session notice above the list", async () => {
		routerState.sessionNotFound = true;
		render(SessionList);
		expect(
			screen.getByText("Session not found. That session no longer exists."),
		).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(routerState.sessionNotFound).toBe(false);
		expect(
			screen.queryByText("Session not found. That session no longer exists."),
		).toBeNull();
	});

	it("counts the matches it has and offers a one-action clear", () => {
		render(SessionList);

		expect(screen.getByTestId("session-search-summary").textContent).toContain(
			"2 matches",
		);
		expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
	});

	it("says at-least rather than a total while more pages remain", () => {
		seedSearchResults(sessionState.searchResults ?? [], true);
		render(SessionList);

		expect(screen.getByTestId("session-search-summary").textContent).toContain(
			"2+ matches",
		);
	});

	it("reads as no match rather than an empty list when nothing matched", () => {
		seedSearchResults([]);
		render(SessionList);

		expect(screen.getByTestId("session-search-summary").textContent).toContain(
			"0 matches",
		);
		expect(screen.getByText("No matching sessions")).toBeTruthy();
	});
});
