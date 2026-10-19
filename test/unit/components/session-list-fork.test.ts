import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import {
	clearSessionSearch,
	seedFamilySessions,
	seedRootSessions,
} from "../stores/session-fixtures.js";

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		// Keep catalog reads pending while the fork reply settles.
		rpc: vi.fn((tag: string) =>
			tag === "GetAgents" || tag === "GetCommands"
				? new Promise(() => undefined)
				: Promise.resolve({
						projectSlug: "current-project",
						sessionId: "fork",
						forkedFrom: "other",
					}),
		),
	}),
);

describe("SessionList fork", () => {
	beforeEach(() => {
		clearSessionState();
		vi.clearAllMocks();
		vi.stubGlobal("history", {
			pushState: vi.fn(),
			replaceState: vi.fn(),
			state: null,
		});
		attachedProjectState.slug = "current-project";
		projectState.projects = [
			{ slug: "current-project", title: "Current", folders: ["/current"] },
		];
		seedRootSessions([
			{ id: "open", title: "Open work" },
			{ id: "other", title: "Other work" },
		]);
		seedFamilySessions([...sessionState.rootSessions]);

		sessionState.searchQuery = "";
		clearSessionSearch();
		openSessionForSetup("open", "current-project");
		routerState.path = "/s/open";
		routerState.search = "";
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	// Nothing else announces the fork, so the list must open it itself once
	// ForkSession answers.
	it("opens the fork of a session that is not the open one", async () => {
		render(SessionList);
		const row = screen.getByText("Other work").closest("a");
		if (!row) throw new Error("Missing row");

		await fireEvent.contextMenu(row);
		await fireEvent.click(await screen.findByTestId("session-ctx-fork"));

		expect(rpc).toHaveBeenCalledWith(
			"ForkSession",
			expect.objectContaining({ sessionId: "other" }),
		);
		await vi.waitFor(() => expect(sessionState.currentId).toBe("fork"));
		expect(routerState.path).toContain("/s/fork");
	});
});
