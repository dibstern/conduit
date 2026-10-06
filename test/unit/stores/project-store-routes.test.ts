import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyProjectList,
	projectState,
} from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";

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
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("project navigation", () => {
	it("replaces a removed attached project's session with an unscoped list", async () => {
		applyProjectList({ projects: [projectB] });
		await vi.waitFor(() => expect(attachedProjectState.slug).toBeNull());
		expect(routerState.path).toBe("/");
		expect(routerState.search).toBe("");
		expect(replaceState.mock.lastCall?.[2]).toBe("/");
		expect(pushState).not.toHaveBeenCalled();
	});

	it("keeps the current session when another project is removed", async () => {
		applyProjectList({ projects: [projectA] });
		// The handler checks the attachment after loading the router module.
		await import("../../../src/lib/frontend/stores/router.svelte.js");
		expect(attachedProjectState.slug).toBe("project-a");
		expect(routerState.path).toBe("/s/session-a");
		expect(routerState.search).toBe("?p=project-a");
		expect(replaceState).not.toHaveBeenCalled();
	});
});
