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
import { WsRpcError } from "../../../src/lib/frontend/transport/ws-rpc.js";
import {
	setSessionPinnedRpc,
	setSessionSettledRpc,
	snoozeSessionRpc,
	unsnoozeSessionRpc,
} from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import {
	formatSnoozeTime,
	formatTimeAgo,
} from "../../../src/lib/frontend/utils/format.js";

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		setSessionSettledRpc: vi.fn().mockResolvedValue(undefined),
		setSessionPinnedRpc: vi.fn().mockResolvedValue(undefined),
		snoozeSessionRpc: vi.fn().mockResolvedValue(undefined),
		unsnoozeSessionRpc: vi.fn().mockResolvedValue(undefined),
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
	uiState.snoozedShelfOpen = false;
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
	sessionState.now = Date.now();
	sessionState.sessions.clear();
});
afterEach(() => {
	cleanup();
	if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore();
	vi.unstubAllGlobals();
});

function addSnoozedRow(until: number | null = Date.now() + 3_600_000) {
	const row = {
		id: "sleeping",
		title: "Sleeping work",
		attention: "idle" as const,
		snoozedAt: Date.now() - 1_000,
		...(until === null ? {} : { snoozedUntil: until }),
	};
	sessionState.rootSessions = [...sessionState.rootSessions, row];
	return row;
}

describe("session triage list", () => {
	it("keeps snoozed rows in a count-free shelf above Settled", async () => {
		const until = new Date(2099, 9, 12, 9).getTime();
		addSnoozedRow(until);
		render(SessionList);
		const toggle = screen.getByTestId("snoozed-shelf-toggle");
		expect(toggle.textContent?.trim()).toBe("Snoozed");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-controls")).toBe("snoozed-shelf-rows");
		expect(screen.queryByText("Sleeping work")).toBeNull();
		expect(
			toggle.compareDocumentPosition(
				screen.getByTestId("settled-shelf-toggle"),
			) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		await fireEvent.click(toggle);
		expect(localStorage.getItem("snoozed-shelf-open")).toBe("true");
		const row = screen.getByText("Sleeping work").closest("a");
		expect(row?.querySelector(".session-item-meta")?.textContent).toBe(
			formatSnoozeTime(until, sessionState.now),
		);
		expect(row?.querySelector(".session-item-status")).toBeNull();
	});

	it("forces snoozed search results open without saving the preference", async () => {
		addSnoozedRow();
		render(SessionList);
		sessionState.searchQuery = "Sleeping";
		await tick();
		expect(screen.getByText("Sleeping work")).toBeTruthy();
		await fireEvent.click(screen.getByTestId("snoozed-shelf-toggle"));
		expect(uiState.snoozedShelfOpen).toBe(false);
		expect(localStorage.getItem("snoozed-shelf-open")).toBeNull();
		sessionState.searchQuery = "";
		await tick();
		expect(screen.queryByText("Sleeping work")).toBeNull();
	});

	it("wakes a timed row on the client clock without another list read", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(2026, 9, 5, 9));
			const now = Date.now();
			sessionState.now = now;
			sessionState.rootSessions = [
				{
					id: "wake",
					title: "Wake soon",
					attention: "idle",
					snoozedAt: now,
					snoozedUntil: now + 5_000,
				},
			];
			uiState.snoozedShelfOpen = true;
			render(SessionList);
			await tick();
			expect(
				screen.getByText("Wake soon").closest("#snoozed-shelf-rows"),
			).not.toBeNull();
			expect(vi.getTimerCount()).toBe(1);
			sessionState.rootSessions = [
				{
					id: "wake",
					title: "Wake soon",
					attention: "idle",
					snoozedAt: now,
					snoozedUntil: now + 1_000,
				},
			];
			await tick();
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(1_000);
			await tick();
			expect(screen.queryByTestId("snoozed-shelf-toggle")).toBeNull();
			expect(
				screen.getByText("Wake soon").closest("#snoozed-shelf-rows"),
			).toBeNull();
			expect(screen.getByTestId("session-woke-pill").textContent).toBe("Woke");
		} finally {
			vi.useRealTimers();
		}
	});
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

	it("snoozes through the sheet and Undo unsnoozes the same project", async () => {
		const now = new Date(2026, 9, 5, 9).getTime();
		vi.spyOn(Date, "now").mockReturnValue(now);
		render(SessionList);
		render(Toast);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Idle work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-snooze"));
		expect(screen.getByText("Snooze until…")).toBeTruthy();
		await fireEvent.click(screen.getByTestId("snooze-option-1h"));
		await waitFor(() =>
			expect(snoozeSessionRpc).toHaveBeenCalledWith(
				expect.objectContaining({
					projectSlug: "current-project",
					sessionId: "idle",
					until: now + 3_600_000,
				}),
			),
		);
		expect(screen.getByRole("status").textContent).toContain(
			"Snoozed “Idle work” until 10:00",
		);
		expect(uiState.toasts[0]?.duration).toBe(5000);
		await fireEvent.click(screen.getByTestId("toast-action"));
		await waitFor(() =>
			expect(unsnoozeSessionRpc).toHaveBeenCalledWith(
				expect.objectContaining({
					projectSlug: "current-project",
					sessionId: "idle",
				}),
			),
		);
	});

	it("Undo restores the previous snooze deadline", async () => {
		const now = new Date(2026, 9, 5, 9).getTime();
		vi.spyOn(Date, "now").mockReturnValue(now);
		sessionState.now = now;
		const previousUntil = now + 86_400_000;
		addSnoozedRow(previousUntil);
		uiState.snoozedShelfOpen = true;
		render(SessionList);
		render(Toast);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Sleeping work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-snooze"));
		await fireEvent.click(screen.getByTestId("snooze-option-3h"));
		await waitFor(() =>
			expect(snoozeSessionRpc).toHaveBeenCalledWith(
				expect.objectContaining({ until: now + 10_800_000 }),
			),
		);
		await fireEvent.click(screen.getByTestId("toast-action"));
		await waitFor(() =>
			expect(snoozeSessionRpc).toHaveBeenLastCalledWith(
				expect.objectContaining({
					sessionId: "sleeping",
					until: previousUntil,
				}),
			),
		);
		expect(unsnoozeSessionRpc).not.toHaveBeenCalled();
	});

	it("reports RPC refusal text, transport failure, and failed Undo", async () => {
		const now = new Date(2026, 9, 5, 9).getTime();
		vi.spyOn(Date, "now").mockReturnValue(now);
		vi.mocked(snoozeSessionRpc).mockRejectedValueOnce(
			new WsRpcError({ message: "Waiting on you" }),
		);
		render(SessionList);
		render(Toast);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Idle work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-snooze"));
		await fireEvent.click(screen.getByTestId("snooze-option-1h"));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Waiting on you",
		);
		uiState.toasts = [];
		vi.mocked(snoozeSessionRpc).mockRejectedValueOnce(new Error("offline"));
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Idle work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-snooze"));
		await fireEvent.click(screen.getByTestId("snooze-option-1h"));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Couldn't snooze session",
		);
		uiState.toasts = [];
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Idle work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-snooze"));
		await fireEvent.click(screen.getByTestId("snooze-option-1h"));
		await screen.findByRole("status");
		vi.mocked(unsnoozeSessionRpc).mockRejectedValueOnce(new Error("offline"));
		await fireEvent.click(screen.getByTestId("toast-action"));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Couldn't undo",
		);
	});

	it("unsnoozes without a success toast", async () => {
		addSnoozedRow();
		uiState.snoozedShelfOpen = true;
		render(SessionList);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Sleeping work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-unsnooze"));
		await waitFor(() =>
			expect(unsnoozeSessionRpc).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: "sleeping" }),
			),
		);
		expect(uiState.toasts).toEqual([]);
	});
});
