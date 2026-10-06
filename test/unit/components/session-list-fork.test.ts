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
import {
	forkSessionRpc,
	viewSessionRpc,
} from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import {
	clearSessionSearch,
	seedDaemonSessions,
	seedFamilySessions,
	seedRootSessions,
} from "../stores/session-fixtures.js";

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		forkSessionRpc: vi.fn(),
		viewSessionRpc: vi.fn().mockResolvedValue(undefined),
		getAgentsRpc: vi.fn().mockReturnValue(new Promise(() => undefined)),
		getCommandsRpc: vi.fn().mockReturnValue(new Promise(() => undefined)),
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
		seedDaemonSessions([]);
		sessionState.searchQuery = "";
		clearSessionSearch();
		sessionState.currentId = "open";
		routerState.path = "/s/open";
		routerState.search = "";
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	// The relay's own switch to the fork is uncorrelated and names a parent
	// that is not the open session, so ws-dispatch ignores it. The list must
	// open the fork itself once ForkSession answers.
	it("opens the fork of a session that is not the open one", async () => {
		vi.mocked(forkSessionRpc).mockResolvedValue({
			projectSlug: "current-project",
			sessionId: "fork",
		});
		render(SessionList);
		const row = screen.getByText("Other work").closest("a");
		if (!row) throw new Error("Missing row");

		await fireEvent.contextMenu(row);
		await fireEvent.click(await screen.findByTestId("session-ctx-fork"));

		expect(forkSessionRpc).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "other" }),
		);
		await vi.waitFor(() => expect(sessionState.currentId).toBe("fork"));
		expect(routerState.path).toContain("/s/fork");
		expect(viewSessionRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				projectSlug: "current-project",
				sessionId: "fork",
			}),
		);
	});
});
