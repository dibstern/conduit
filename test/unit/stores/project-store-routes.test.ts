import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyShellProjects,
	getDraftProject,
	projectState,
} from "../../../src/lib/frontend/stores/project.svelte.js";
import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";
import { setSessionScope } from "../../../src/lib/frontend/stores/session-scope.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";

const pushState = vi.fn();
const replaceState = vi.fn();
const projectA = {
	slug: "project-a",
	title: "A",
	folders: ["/projects/a"] as const,
};
const projectB = {
	slug: "project-b",
	title: "B",
	folders: ["/projects/b"] as const,
};

beforeEach(() => {
	vi.stubGlobal("window", { history: { pushState, replaceState } });
	pushState.mockClear();
	replaceState.mockClear();
	routerState.path = "/s/session-a";
	routerState.search = "?p=project-a";
	projectState.projects = [projectA, projectB];
	projectState.newSessionProject = null;
});

describe("draft project selection", () => {
	beforeEach(() => {
		routerState.search = "";
		projectState.projects = [
			{ ...projectA, slug: "conduit" },
			{ ...projectB, slug: "dotfiles" },
		];
		projectState.newSessionProject = "conduit";
	});

	it("prefers the sidebar project scope over the remembered project", () => {
		setSessionScope("dotfiles");
		expect(getDraftProject()).toBe("dotfiles");
	});

	it("prefers an explicit draft project over the sidebar scope", () => {
		routerState.search = "?project=conduit";
		setSessionScope("dotfiles");
		expect(getDraftProject()).toBe("conduit");
	});

	it("does not choose a scoped project whose folder is missing", () => {
		projectState.projects = [
			{ ...projectA, slug: "conduit" },
			{ ...projectB, slug: "dotfiles", missing: true },
		];
		setSessionScope("dotfiles");
		expect(getDraftProject()).toBe("conduit");
	});

	it("uses the remembered project when the scope is unregistered", () => {
		setSessionScope("unknown");
		expect(getDraftProject()).toBe("conduit");
	});

	it("uses the first available project when the remembered project is missing", () => {
		projectState.projects = [
			{ ...projectA, slug: "conduit", missing: true },
			{ ...projectB, slug: "dotfiles" },
		];
		expect(getDraftProject()).toBe("dotfiles");
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("project navigation", () => {
	beforeEach(() => openSessionForSetup("session-a", "project-a"));

	it("replaces a removed project's shown session with an unscoped list", async () => {
		applyShellProjects({ _tag: "projects", projects: [projectB] });
		await vi.waitFor(() => expect(routerState.path).toBe("/"));
		expect(routerState.search).toBe("");
		expect(replaceState.mock.lastCall?.[2]).toBe("/");
		expect(pushState).not.toHaveBeenCalled();
	});

	it("keeps the current session when another project is removed", async () => {
		applyShellProjects({ _tag: "projects", projects: [projectA] });
		expect(routerState.path).toBe("/s/session-a");
		expect(routerState.search).toBe("?p=project-a");
		expect(replaceState).not.toHaveBeenCalled();
	});
});
