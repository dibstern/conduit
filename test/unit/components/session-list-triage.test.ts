import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Toast from "../../../src/lib/frontend/components/overlays/Toast.svelte";
import SessionList from "../../../src/lib/frontend/components/session/SessionList.svelte";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import {
	setSessionPinnedRpc,
	setSessionSettledRpc,
} from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import { formatTimeAgo } from "../../../src/lib/frontend/utils/format.js";

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		setSessionSettledRpc: vi.fn().mockResolvedValue(undefined),
		setSessionPinnedRpc: vi.fn().mockResolvedValue(undefined),
	}),
);

beforeEach(() => {
	vi.clearAllMocks();
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
	uiState.settledShelfOpen = false;
	uiState.toasts = [];
	routerState.path = "/";
	routerState.search = "";
	routerState.sessionNotFound = false;
	attachedProjectState.slug = "current-project";
	projectState.projects = [
		{ slug: "current-project", title: "Current", directory: "/current" },
	];
	sessionState.rootSessions = [
		{ id: "idle", title: "Idle work", attention: "idle" },
		{ id: "approval", title: "Approval", attention: "needs-approval" },
		{
			id: "pin",
			title: "Pinned work",
			attention: "needs-approval",
			pinnedAt: 1,
		},
		{
			id: "settled",
			title: "Finished work",
			attention: "done-unread",
			settledAt: Date.now() - 120_000,
			updatedAt: Date.now(),
		},
	];
	sessionState.familySessions = [...sessionState.rootSessions];
	sessionState.daemonSessions = [];
	sessionState.daemonUnavailableProjects = [];
	sessionState.searchQuery = "";
	sessionState.searchResults = null;
	sessionState.searchHasMore = false;
	sessionState.daemonHasMore = false;
	sessionState.currentId = null;
	sessionState.sessions.clear();
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("session triage list", () => {
	it("places Pinned first and hides settled rows behind a count-free disclosure", () => {
		const { container } = render(SessionList);
		expect(
			container.querySelector(".session-group-label")?.textContent?.trim(),
		).toBe("Pinned");
		expect(
			container
				.querySelector("[data-session-id]")
				?.getAttribute("data-session-id"),
		).toBe("pin");
		expect(screen.queryByText("Finished work")).toBeNull();
		const toggle = screen.getByTestId("settled-shelf-toggle");
		expect(toggle.textContent?.trim()).toBe("Settled");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(
			document.getElementById(toggle.getAttribute("aria-controls") ?? ""),
		).not.toBeNull();
	});

	it("persists disclosure toggles and shows the settled time", async () => {
		render(SessionList);
		const toggle = screen.getByTestId("settled-shelf-toggle");
		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(localStorage.getItem("settled-shelf-open")).toBe("true");
		const row = screen.getByText("Finished work").closest("a");
		expect(row?.querySelector(".session-item-meta")?.textContent).toBe(
			formatTimeAgo(Date.now() - 120_000),
		);
		await fireEvent.click(toggle);
		expect(localStorage.getItem("settled-shelf-open")).toBe("false");
		expect(screen.queryByText("Finished work")).toBeNull();
	});

	it("forces the shelf open during search without changing the preference", async () => {
		render(SessionList);
		sessionState.searchQuery = "Finished";
		await tick();
		expect(screen.getByText("Finished work")).toBeTruthy();
		expect(
			screen.getByTestId("settled-shelf-toggle").getAttribute("aria-expanded"),
		).toBe("true");
		await fireEvent.click(screen.getByTestId("settled-shelf-toggle"));
		expect(localStorage.getItem("settled-shelf-open")).toBeNull();
		expect(uiState.settledShelfOpen).toBe(false);
		sessionState.searchQuery = "";
		await tick();
		expect(screen.queryByText("Finished work")).toBeNull();
	});

	it("omits empty shelves", () => {
		sessionState.rootSessions = [{ id: "idle", title: "Idle work" }];
		render(SessionList);
		expect(screen.queryByText("Pinned")).toBeNull();
		expect(screen.queryByTestId("settled-shelf-toggle")).toBeNull();
	});

	it.each([
		"settle",
		"pin",
	] as const)("calls %s with the row project and offers Undo", async (verb) => {
		render(SessionList);
		render(Toast);
		const row = screen.getByText("Idle work").closest("a");
		if (!row) throw new Error("Missing row");
		await fireEvent.contextMenu(row);
		await fireEvent.click(await screen.findByTestId(`session-ctx-${verb}`));
		const rpc = verb === "settle" ? setSessionSettledRpc : setSessionPinnedRpc;
		const key = verb === "settle" ? "settled" : "pinned";
		await waitFor(() =>
			expect(rpc).toHaveBeenCalledWith(
				expect.objectContaining({
					projectSlug: "current-project",
					sessionId: "idle",
					[key]: true,
				}),
			),
		);
		expect(screen.getAllByRole("status")).toHaveLength(1);
		expect(screen.getByRole("status").textContent).toContain(
			verb === "settle"
				? "Moved “Idle work” to Settled"
				: "Pinned “Idle work” to the top",
		);
		expect(uiState.toasts[0]?.duration).toBe(5000);
		await fireEvent.click(screen.getByTestId("toast-action"));
		await waitFor(() =>
			expect(rpc).toHaveBeenLastCalledWith(
				expect.objectContaining({ sessionId: "idle", [key]: false }),
			),
		);
		expect(uiState.toasts).toEqual([]);
	});

	it.each([
		"settle",
		"pin",
	] as const)("reports a failed %s without a success toast", async (verb) => {
		const rpc = verb === "settle" ? setSessionSettledRpc : setSessionPinnedRpc;
		vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
		render(SessionList);
		render(Toast);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Idle work" }),
		);
		await fireEvent.click(await screen.findByTestId(`session-ctx-${verb}`));
		expect((await screen.findByRole("alert")).textContent).toContain(
			`Couldn't ${verb} session`,
		);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("does not reannounce the search summary when a result settles", async () => {
		sessionState.searchQuery = "Idle";
		sessionState.searchResults = [{ id: "idle", title: "Idle work" }];
		render(SessionList);
		const live = screen
			.getByTestId("session-search-summary")
			.querySelector('[aria-live="polite"]');
		if (!live) throw new Error("Missing search summary");
		const mutations = vi.fn();
		const observer = new MutationObserver(mutations);
		observer.observe(live, {
			childList: true,
			characterData: true,
			subtree: true,
		});
		sessionState.rootSessions = [
			{ id: "idle", title: "Idle work", settledAt: Date.now() },
		];
		await tick();
		expect(live.textContent).toBe("1 match");
		expect(mutations).not.toHaveBeenCalled();
		observer.disconnect();
	});

	it.each([
		"unsettle",
		"unpin",
	] as const)("%s sends false without a toast", async (verb) => {
		uiState.settledShelfOpen = true;
		render(SessionList);
		const title = verb === "unsettle" ? "Finished work" : "Pinned work";
		await fireEvent.click(
			screen.getByRole("button", { name: `More options for ${title}` }),
		);
		await fireEvent.click(await screen.findByTestId(`session-ctx-${verb}`));
		const rpc =
			verb === "unsettle" ? setSessionSettledRpc : setSessionPinnedRpc;
		await waitFor(() =>
			expect(rpc).toHaveBeenCalledWith(
				expect.objectContaining(
					verb === "unsettle" ? { settled: false } : { pinned: false },
				),
			),
		);
		expect(uiState.toasts).toEqual([]);
	});

	it("keeps Undo addressed to the original project after navigation", async () => {
		sessionState.rootSessions = [
			{ id: "empty-title", title: "", projectSlug: "current-project" },
		];
		render(SessionList);
		render(Toast);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for New Session" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-settle"));
		expect((await screen.findByRole("status")).textContent).toContain(
			"Moved “New Session” to Settled",
		);
		attachedProjectState.slug = "another-project";
		vi.mocked(setSessionSettledRpc).mockRejectedValueOnce(new Error("offline"));
		await fireEvent.click(screen.getByTestId("toast-action"));
		expect(setSessionSettledRpc).toHaveBeenLastCalledWith(
			expect.objectContaining({
				projectSlug: "current-project",
				sessionId: "empty-title",
				settled: false,
			}),
		);
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Couldn't undo",
		);
	});

	it("keeps foreign rows inert even on right-click", async () => {
		sessionState.daemonSessions = [
			{
				id: "foreign",
				title: "Foreign work",
				projectSlug: "other-project",
				pinnedAt: 1,
			},
		];
		render(SessionList);
		const row = screen.getByText("Foreign work").closest("a");
		if (!row) throw new Error("Missing foreign row");
		await fireEvent.contextMenu(row);
		expect(screen.queryByRole("menu")).toBeNull();
		expect(setSessionPinnedRpc).not.toHaveBeenCalled();
		expect(setSessionSettledRpc).not.toHaveBeenCalled();
	});
});
