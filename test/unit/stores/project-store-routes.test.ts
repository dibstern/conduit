import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyShellProjects,
	getDraftProject,
	projectState,
} from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import { setSessionScope } from "../../../src/lib/frontend/stores/session-scope.js";

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
	attachedProjectState.slug = "project-a";
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
	it("replaces a removed attached project's session with an unscoped list", async () => {
		applyShellProjects({ _tag: "projects", projects: [projectB] });
		await vi.waitFor(() => expect(attachedProjectState.slug).toBeNull());
		expect(routerState.path).toBe("/");
		expect(routerState.search).toBe("");
		expect(replaceState.mock.lastCall?.[2]).toBe("/");
		expect(pushState).not.toHaveBeenCalled();
	});

	it("keeps the current session when another project is removed", async () => {
		applyShellProjects({ _tag: "projects", projects: [projectA] });
		// The handler checks the attachment after loading the router module.
		await import("../../../src/lib/frontend/stores/router.svelte.js");
		expect(attachedProjectState.slug).toBe("project-a");
		expect(routerState.path).toBe("/s/session-a");
		expect(routerState.search).toBe("?p=project-a");
		expect(replaceState).not.toHaveBeenCalled();
	});
});
