// The sidebar must say how many sessions matched without ever claiming to know
// the size of the whole match set: a trailing "+" is what keeps the number
// honest while pages remain.

import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SessionList from "../../../src/lib/frontend/components/session/SessionList.svelte";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

describe("SessionList search summary", () => {
	beforeEach(() => {
		routerState.path = "/p/current-project/";
		sessionState.rootSessions = [];
		sessionState.familySessions = [];
		sessionState.daemonSessions = [];
		sessionState.daemonUnavailableProjects = [];
		sessionState.currentId = null;
		sessionState.sessions.clear();
		sessionState.searchQuery = "report";
		sessionState.searchCursor = null;
		sessionState.searchHasMore = false;
		sessionState.searchLoading = false;
		sessionState.searchResults = [
			{ id: "a", title: "Report one", projectSlug: "other-project" },
			{ id: "b", title: "Report two", projectSlug: "other-project" },
		];
		projectState.projects = [
			{
				slug: "current-project",
				title: "Current project",
				directory: "/projects/current",
			},
			{
				slug: "other-project",
				title: "Other project",
				directory: "/projects/other",
			},
		];
	});

	afterEach(() => {
		cleanup();
	});

	it("counts the matches it has and offers a one-action clear", () => {
		render(SessionList);

		expect(screen.getByTestId("session-search-summary").textContent).toContain(
			"2 matches",
		);
		expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
	});

	it("says at-least rather than a total while more pages remain", () => {
		sessionState.searchHasMore = true;
		render(SessionList);

		expect(screen.getByTestId("session-search-summary").textContent).toContain(
			"2+ matches",
		);
	});

	it("reads as no match rather than an empty list when nothing matched", () => {
		sessionState.searchResults = [];
		render(SessionList);

		expect(screen.getByTestId("session-search-summary").textContent).toContain(
			"0 matches",
		);
		expect(screen.getByText("No matching sessions")).toBeTruthy();
	});
});
