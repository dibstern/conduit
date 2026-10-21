import { cleanup, fireEvent, render, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SessionList from "../../../src/lib/frontend/components/session/SessionList.svelte";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import {
	applySessionSnapshot,
	clearSessionSearch,
	seedFamilySessions,
	seedRootSessions,
} from "../stores/session-fixtures.js";

describe("SessionList daemon sessions", () => {
	beforeEach(() => {
		clearSessionState();
		routerState.path = "/";
		attachedProjectState.slug = "current-project";
		routerState.search = "";
		seedRootSessions([
			{
				id: "local-session",
				projectSlug: "current-project",
				title: "Local session",
				updatedAt: Date.now(),
			},
		]);
		seedFamilySessions([...sessionState.rootSessions]);

		clearSessionSearch();
		sessionState.searchQuery = "";
		openSessionForSetup("local-session", "current-project");
		projectState.projects = [
			{
				slug: "current-project",
				title: "Current project",
				folders: ["/projects/current"],
			},
			{
				slug: "another-project",
				title: "Another project",
				folders: ["/projects/another"],
			},
		];
	});

	afterEach(() => {
		cleanup();
		uiState.selectMode = false;
		uiState.settledShelfOpen = false;
		uiState.snoozedShelfOpen = false;
	});

	// Local projects can themselves be linked checkouts; only a session move
	// away from the project's primary folder earns a row branch label.
	it("labels both worktree origins while keeping Local rows branch-free", () => {
		seedRootSessions([]);
		seedFamilySessions([]);
		applySessionSnapshot(
			[
				...(["existing", "conduit"] as const).map((origin) => ({
					id: origin,
					title: `${origin} worktree`,
					projectSlug: "another-project",
					workspace: {
						cause: "launch" as const,
						origin,
						worktrees: { "/projects/another": `/worktrees/${origin}` },
					},
					git: { branch: `feature/${origin}`, worktree: origin },
				})),
				{
					id: "local",
					title: "Local checkout",
					projectSlug: "another-project",
					git: { branch: "main", worktree: "project-is-a-worktree" },
				},
				{
					id: "local-fallback",
					title: "Returned to Local",
					projectSlug: "another-project",
					workspace: { cause: "missing", origin: "existing", worktrees: {} },
					git: { branch: "main" },
				},
			],
			"partial",
		);
		const { container } = render(SessionList);
		for (const origin of ["existing", "conduit"]) {
			const row = container.querySelector(`[data-session-id="${origin}"]`);
			expect(
				row?.querySelector(".session-item-context")?.textContent,
			).toContain(`Another project feature/${origin}`);
		}
		for (const id of ["local", "local-fallback"]) {
			const row = container.querySelector(`[data-session-id="${id}"]`);
			expect(
				row
					?.querySelector(".session-item-context > span:last-child")
					?.textContent?.trim(),
			).toBe("Another project");
			expect(row?.getAttribute("aria-label")).not.toContain("main");
		}
	});

	it.each([
		"settled",
		"snoozed",
	] as const)("keeps a worktree branch visible in the %s shelf", (shelf) => {
		seedRootSessions([]);
		seedFamilySessions([]);
		uiState.settledShelfOpen = true;
		uiState.snoozedShelfOpen = true;
		applySessionSnapshot(
			[
				{
					id: "shelf-worktree",
					title: "Parked work",
					projectSlug: "another-project",
					workspace: {
						cause: "launch",
						origin: "existing",
						worktrees: { "/projects/another": "/worktrees/parked" },
					},
					git: { branch: "feature/parked" },
					...(shelf === "settled"
						? { settledAt: Date.now() - 1_000 }
						: {
								snoozedAt: Date.now() - 1_000,
								snoozedUntil: Date.now() + 60_000,
							}),
				},
			],
			"partial",
		);
		const { container } = render(SessionList);
		const row = container.querySelector('[data-session-id="shelf-worktree"]');
		expect(row?.textContent).toContain("feature/parked");
		expect(row?.getAttribute("aria-label")).toContain("feature/parked");
	});

	it("renders a foreign row as a session link with a project label", async () => {
		applySessionSnapshot(
			[
				{
					id: "foreign-session",
					title: "Foreign session",
					projectSlug: "unlisted-project",
					updatedAt: Date.now() - 1,
				},
			],
			"partial",
		);

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

		expect(foreignRow.getAttribute("href")).toBe("/s/foreign-session");
		expect(within(foreignRow).getByText("unlisted-project")).toBeDefined();
		// A foreign row is as actionable as a local one; the triage suite covers its menu.
		expect(
			within(foreignRow).getByRole("button", { name: /More options/ }),
		).toBeDefined();
		expect(
			within(localRow).getByRole("button", { name: /More options/ }),
		).toBeDefined();

		await fireEvent.dblClick(within(foreignRow).getByText("Foreign session"));
		expect(within(foreignRow).getByRole("textbox")).toBeDefined();

		// The sidebar header's Select button and the phone ⋯ Select both just
		// switch the list into select mode.
		uiState.selectMode = true;
		await tick();
		for (const row of [foreignRow, localRow])
			expect(
				within(row).getByRole("checkbox").getAttribute("aria-checked"),
			).toBe("false");

		await fireEvent.click(view.getByRole("button", { name: "All" }));
		for (const row of [foreignRow, localRow])
			expect(
				within(row).getByRole("checkbox").getAttribute("aria-checked"),
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

	it("names the project even when only one project is registered", () => {
		projectState.projects = [
			{
				slug: "current-project",
				title: "Current project",
				folders: ["/projects/current"],
			},
		];

		const view = render(SessionList);
		const localRow = view.container.querySelector<HTMLAnchorElement>(
			'[data-session-id="local-session"]',
		);
		expect(localRow).not.toBeNull();
		if (!localRow) return;
		expect(within(localRow).getByText("Current project")).toBeDefined();
	});
});
