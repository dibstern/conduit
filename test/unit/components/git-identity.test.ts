import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import GitIdentity from "../../../src/lib/frontend/components/session/GitIdentity.svelte";

afterEach(cleanup);

describe("GitIdentity", () => {
	it("renders project, branch, worktree and dirty state in order", () => {
		render(GitIdentity, {
			props: {
				project: "conduit",
				git: { branch: "feature/17xt", worktree: "linked-15", dirty: true },
			},
		});
		const identity = screen.getByTestId("session-bar-identity");
		expect(
			identity.querySelector('[data-part="project"]')?.textContent,
		).toContain("conduit");
		expect(
			identity.querySelector('[data-part="branch"]')?.textContent,
		).toContain("feature/17xt");
		expect(
			identity.querySelector('[data-part="worktree"]')?.textContent,
		).toContain("linked-15");
		expect(
			Array.from(identity.children, (part) => part.getAttribute("data-part")),
		).toEqual(["project", "branch", "worktree", null]);
		expect(screen.getByTitle("Uncommitted changes").textContent).toContain("●");
	});

	it("renders only the project when git metadata is absent", () => {
		render(GitIdentity, { props: { project: "conduit", git: undefined } });
		expect(screen.getByTestId("session-bar-identity").textContent).toBe(
			"conduit",
		);
		expect(screen.queryByTitle("Uncommitted changes")).toBeNull();
	});
});
