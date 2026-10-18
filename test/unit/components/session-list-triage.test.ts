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
import SnoozePickerHost from "../../../src/lib/frontend/components/session/SnoozePickerHost.svelte";
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
import { WsRpcError } from "../../../src/lib/frontend/transport/ws-rpc.js";
import { rpc as callRpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import {
	formatSnoozeTime,
	formatTimeAgo,
} from "../../../src/lib/frontend/utils/format.js";
import {
	applySessionSnapshot,
	clearSessionSearch,
	seedFamilySessions,
	seedRootSessions,
	seedSearchResults,
} from "../stores/session-fixtures.js";

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		rpc: vi.fn().mockResolvedValue(undefined),
	}),
);

beforeEach(() => {
	clearSessionState();
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
		{ slug: "current-project", title: "Current", folders: ["/current"] },
	];
	seedRootSessions([
		{
			projectSlug: "current-project",
			id: "idle",
			title: "Idle work",
			attention: "idle",
		},
		{
			projectSlug: "current-project",
			id: "approval",
			title: "Approval",
			attention: "needs-approval",
		},
		{
			projectSlug: "current-project",
			id: "pin",
			title: "Pinned work",
			attention: "needs-approval",
			pinnedAt: 1,
		},
		{
			projectSlug: "current-project",
			id: "settled",
			title: "Finished work",
			attention: "done-unread",
			settledAt: Date.now() - 120_000,
			updatedAt: Date.now(),
		},
	]);
	seedFamilySessions([...sessionState.rootSessions]);

	sessionState.searchQuery = "";
	clearSessionSearch();
	openSessionForSetup(null);
	sessionState.now = Date.now();
});
afterEach(() => {
	cleanup();
	if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore();
	vi.unstubAllGlobals();
});

function addSnoozedRow(until: number | null = Date.now() + 3_600_000) {
	const row = {
		projectSlug: "current-project",
		id: "sleeping",
		title: "Sleeping work",
		attention: "idle" as const,
		snoozedAt: Date.now() - 1_000,
		...(until === null ? {} : { snoozedUntil: until }),
	};
	seedRootSessions([...sessionState.rootSessions, row]);
	return row;
}

async function touchSwipe(row: HTMLElement, dx: number) {
	vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
		width: 200,
		height: 52,
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 200,
		bottom: 52,
		toJSON: () => ({}),
	});
	await fireEvent.pointerDown(row, {
		pointerId: 1,
		pointerType: "touch",
		clientX: 100,
		clientY: 10,
	});
	await fireEvent.pointerMove(window, {
		pointerId: 1,
		pointerType: "touch",
		clientX: 100 + dx,
		clientY: 10,
	});
	await fireEvent.pointerUp(window, {
		pointerId: 1,
		pointerType: "touch",
		clientX: 100 + dx,
		clientY: 10,
	});
}

describe("session triage list", () => {
	it("commits a left swipe to tomorrow at 9:00 using the existing snooze toast", async () => {
		const now = new Date(2026, 9, 5, 15).getTime();
		vi.spyOn(Date, "now").mockReturnValue(now);
		render(SessionList);
		render(Toast);
		const row = screen.getByText("Idle work").closest("a");
		if (!row) throw new Error("Missing row");
		await touchSwipe(row, -120);
		const tomorrow = new Date(2026, 9, 6, 9).getTime();
		await waitFor(() =>
			expect(callRpc).toHaveBeenCalledWith(
				"SnoozeSession",
				expect.objectContaining({ sessionId: "idle", until: tomorrow }),
			),
		);
		expect((await screen.findByRole("status")).textContent).toContain(
			`Snoozed “Idle work” until ${formatSnoozeTime(tomorrow, now)}`,
		);
	});

	it("keeps snoozed rows in a counted shelf after Settled", async () => {
		const until = new Date(2099, 9, 12, 9).getTime();
		addSnoozedRow(until);
		render(SessionList);
		const toggle = screen.getByTestId("snoozed-shelf-toggle");
		expect(toggle.textContent?.trim()).toBe("Snoozed 1");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-controls")).toBe("snoozed-shelf-rows");
		expect(screen.queryByText("Sleeping work")).toBeNull();
		expect(
			toggle.compareDocumentPosition(
				screen.getByTestId("settled-shelf-toggle"),
			) & Node.DOCUMENT_POSITION_PRECEDING,
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

	it("allocates the first page to Settled before Snoozed and reveals its more rows", async () => {
		const now = sessionState.now;
		seedRootSessions([
			...Array.from({ length: 4 }, (_, i) => ({
				projectSlug: "current-project",
				id: `settled-${i}`,
				title: `Settled task ${i + 1}`,
				settledAt: now - (i + 1) * 1_000,
			})),
			...Array.from({ length: 30 }, (_, i) => ({
				projectSlug: "current-project",
				id: `snoozed-${i}`,
				title: `Snoozed task ${i + 1}`,
				snoozedAt: now,
				snoozedUntil: now + 3_600_000,
			})),
		]);
		uiState.settledShelfOpen = true;
		uiState.snoozedShelfOpen = true;
		const { container } = render(SessionList);
		expect(screen.getAllByText(/^Settled task/)).toHaveLength(2);
		expect(screen.getByTestId("settled-shelf-more").textContent).toContain(
			"+ 2 more",
		);
		await fireEvent.click(screen.getByTestId("settled-shelf-more"));
		expect(screen.getAllByText(/^Settled task/)).toHaveLength(4);
		await fireEvent.click(screen.getByTestId("snoozed-shelf-more"));
		expect(screen.getAllByText(/^Snoozed task/)).toHaveLength(26);
		expect(container.querySelectorAll("[data-session-id]")).toHaveLength(30);
	});

	it("wakes a timed row on the client clock without another list read", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(2026, 9, 5, 9));
			const now = Date.now();
			sessionState.now = now;
			seedRootSessions([
				{
					projectSlug: "current-project",
					id: "wake",
					title: "Wake soon",
					attention: "idle",
					snoozedAt: now,
					snoozedUntil: now + 5_000,
				},
			]);
			uiState.snoozedShelfOpen = true;
			render(SessionList);
			await tick();
			expect(
				screen.getByText("Wake soon").closest("#snoozed-shelf-rows"),
			).not.toBeNull();
			expect(vi.getTimerCount()).toBe(1);
			seedRootSessions([
				{
					projectSlug: "current-project",
					id: "wake",
					title: "Wake soon",
					attention: "idle",
					snoozedAt: now,
					snoozedUntil: now + 1_000,
				},
			]);
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
	it("places Pinned first and hides settled rows behind a counted disclosure", () => {
		const { container } = render(SessionList);
		expect(
			container.querySelector(".session-group-label")?.textContent?.trim(),
		).toBe("Pinned 1");
		expect(
			container
				.querySelector("[data-session-id]")
				?.getAttribute("data-session-id"),
		).toBe("pin");
		expect(screen.queryByText("Finished work")).toBeNull();
		const toggle = screen.getByTestId("settled-shelf-toggle");
		expect(toggle.textContent?.trim()).toBe("Settled 1");
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
			formatTimeAgo(Date.now() - 120_000).replace(/ ago$/, ""),
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
		seedRootSessions([
			{ projectSlug: "current-project", id: "idle", title: "Idle work" },
		]);
		render(SessionList);
		expect(screen.queryByText("Pinned")).toBeNull();
		expect(screen.queryByTestId("settled-shelf-toggle")).toBeNull();
	});

	it.each([
		"settle",
		"pin",
	] as const)("calls %s with the row session and offers Undo", async (command) => {
		render(SessionList);
		render(Toast);
		const row = screen.getByText("Idle work").closest("a");
		if (!row) throw new Error("Missing row");
		await fireEvent.contextMenu(row);
		await fireEvent.click(await screen.findByTestId(`session-ctx-${command}`));
		const tag = command === "settle" ? "SetSessionSettled" : "SetSessionPinned";
		const key = command === "settle" ? "settled" : "pinned";
		await waitFor(() =>
			expect(callRpc).toHaveBeenCalledWith(
				tag,
				expect.objectContaining({
					sessionId: "idle",
					[key]: true,
				}),
			),
		);
		expect(screen.getAllByRole("status")).toHaveLength(1);
		expect(screen.getByRole("status").textContent).toContain(
			command === "settle"
				? "Moved “Idle work” to Settled"
				: "Pinned “Idle work” to the top",
		);
		expect(uiState.toasts[0]?.duration).toBe(5000);
		await fireEvent.click(screen.getByTestId("toast-action"));
		await waitFor(() =>
			expect(callRpc).toHaveBeenLastCalledWith(
				tag,
				expect.objectContaining({ sessionId: "idle", [key]: false }),
			),
		);
		expect(uiState.toasts).toEqual([]);
	});

	it.each([
		"settle",
		"pin",
	] as const)("reports a failed %s without a success toast", async (command) => {
		vi.mocked(callRpc).mockRejectedValueOnce(new Error("offline"));
		render(SessionList);
		render(Toast);
		const row = screen.getByText("Idle work").closest("a");
		if (!row) throw new Error("Missing row");
		await fireEvent.mouseOver(row);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Idle work" }),
		);
		await fireEvent.click(await screen.findByTestId(`session-ctx-${command}`));
		expect((await screen.findByRole("alert")).textContent).toContain(
			`Couldn't ${command} session`,
		);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("does not reannounce the search summary when a result settles", async () => {
		sessionState.searchQuery = "Idle";
		seedSearchResults([
			{ projectSlug: "current-project", id: "idle", title: "Idle work" },
		]);
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
		seedRootSessions([
			{
				projectSlug: "current-project",
				id: "idle",
				title: "Idle work",
				settledAt: Date.now(),
			},
		]);
		await tick();
		expect(live.textContent).toBe("1 match");
		expect(mutations).not.toHaveBeenCalled();
		observer.disconnect();
	});

	it.each([
		"unsettle",
		"unpin",
	] as const)("%s sends false without a toast", async (command) => {
		uiState.settledShelfOpen = true;
		render(SessionList);
		const title = command === "unsettle" ? "Finished work" : "Pinned work";
		const row = screen.getByText(title).closest("a");
		if (!row) throw new Error("Missing row");
		await fireEvent.mouseOver(row);
		await fireEvent.click(
			screen.getByRole("button", { name: `More options for ${title}` }),
		);
		await fireEvent.click(await screen.findByTestId(`session-ctx-${command}`));
		const tag =
			command === "unsettle" ? "SetSessionSettled" : "SetSessionPinned";
		await waitFor(() =>
			expect(callRpc).toHaveBeenCalledWith(
				tag,
				expect.objectContaining(
					command === "unsettle" ? { settled: false } : { pinned: false },
				),
			),
		);
		expect(uiState.toasts).toEqual([]);
	});

	it("keeps Undo addressed to the original session after navigation", async () => {
		seedRootSessions([
			{ id: "empty-title", title: "", projectSlug: "current-project" },
		]);
		render(SessionList);
		render(Toast);
		const row = screen.getByText("New Session").closest("a");
		if (!row) throw new Error("Missing row");
		await fireEvent.mouseOver(row);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for New Session" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-settle"));
		expect((await screen.findByRole("status")).textContent).toContain(
			"Moved “New Session” to Settled",
		);
		attachedProjectState.slug = "another-project";
		vi.mocked(callRpc).mockRejectedValueOnce(new Error("offline"));
		await fireEvent.click(screen.getByTestId("toast-action"));
		expect(callRpc).toHaveBeenLastCalledWith(
			"SetSessionSettled",
			expect.objectContaining({
				sessionId: "empty-title",
				settled: false,
			}),
		);
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Couldn't undo",
		);
	});

	it("addresses another project's row by its session", async () => {
		applySessionSnapshot(
			[
				{
					id: "foreign",
					title: "Foreign work",
					projectSlug: "other-project",
					pinnedAt: 1,
				},
			],
			"partial",
		);
		render(SessionList);
		const row = screen.getByText("Foreign work").closest("a");
		if (!row) throw new Error("Missing foreign row");
		await fireEvent.contextMenu(row);
		await fireEvent.click(screen.getByTestId("session-ctx-unpin"));
		expect(callRpc).toHaveBeenCalledWith(
			"SetSessionPinned",
			expect.objectContaining({
				sessionId: "foreign",
				pinned: false,
			}),
		);
	});

	it("snoozes through the sheet and Undo unsnoozes the same session", async () => {
		const now = new Date(2026, 9, 5, 9).getTime();
		vi.spyOn(Date, "now").mockReturnValue(now);
		render(SessionList);
		render(Toast);
		render(SnoozePickerHost);
		const row = screen.getByText("Idle work").closest("a");
		if (!row) throw new Error("Missing row");
		await fireEvent.mouseOver(row);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Idle work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-snooze"));
		expect(screen.getByText("Snooze until…")).toBeTruthy();
		await fireEvent.click(screen.getByTestId("snooze-option-1h"));
		await waitFor(() =>
			expect(callRpc).toHaveBeenCalledWith(
				"SnoozeSession",
				expect.objectContaining({
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
			expect(callRpc).toHaveBeenCalledWith(
				"UnsnoozeSession",
				expect.objectContaining({
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
		render(SnoozePickerHost);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Sleeping work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-snooze"));
		await fireEvent.click(screen.getByTestId("snooze-option-3h"));
		await waitFor(() =>
			expect(callRpc).toHaveBeenCalledWith(
				"SnoozeSession",
				expect.objectContaining({ until: now + 10_800_000 }),
			),
		);
		await fireEvent.click(screen.getByTestId("toast-action"));
		await waitFor(() =>
			expect(callRpc).toHaveBeenLastCalledWith(
				"SnoozeSession",
				expect.objectContaining({
					sessionId: "sleeping",
					until: previousUntil,
				}),
			),
		);
		expect(callRpc).not.toHaveBeenCalledWith(
			"UnsnoozeSession",
			expect.anything(),
		);
	});

	it("reports RPC refusal text, transport failure, and failed Undo", async () => {
		const now = new Date(2026, 9, 5, 9).getTime();
		vi.spyOn(Date, "now").mockReturnValue(now);
		vi.mocked(callRpc).mockRejectedValueOnce(
			new WsRpcError({ message: "Waiting on you" }),
		);
		render(SessionList);
		render(Toast);
		render(SnoozePickerHost);
		await fireEvent.click(
			screen.getByRole("button", { name: "More options for Idle work" }),
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-snooze"));
		await fireEvent.click(screen.getByTestId("snooze-option-1h"));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Waiting on you",
		);
		uiState.toasts = [];
		vi.mocked(callRpc).mockRejectedValueOnce(new Error("offline"));
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
		vi.mocked(callRpc).mockRejectedValueOnce(new Error("offline"));
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
			expect(callRpc).toHaveBeenCalledWith(
				"UnsnoozeSession",
				expect.objectContaining({ sessionId: "sleeping" }),
			),
		);
		expect(uiState.toasts).toEqual([]);
	});
});

// A user's sidebar pick is the only thing that clears the turn-end dot, and
// the browser reports it; the server no longer marks a switch read, because a
// switch also fires on restore, reload and reconnect (ADR-0004, Scope;
// conduit-test-hk9m.3).
describe("sidebar pick", () => {
	const pick = (id: string) => {
		const row = document.querySelector(`a[data-session-id="${id}"]`);
		if (!row) throw new Error(`no row for ${id}`);
		return fireEvent.click(row);
	};

	beforeEach(() => {
		seedRootSessions([
			{
				projectSlug: "current-project",
				id: "unread",
				title: "unread",
				unread: true,
				lastTurnEndVersion: 7,
			},
			{
				projectSlug: "current-project",
				id: "read",
				title: "read",
				lastTurnEndVersion: 3,
			},
		]);
	});

	it("reports an unread row seen up to its latest turn end, even when it is already open", async () => {
		openSessionForSetup("unread", "current-project");
		render(SessionList);
		await pick("unread");
		expect(callRpc).toHaveBeenCalledExactlyOnceWith("MarkSessionSeen", {
			sessionId: "unread",
			upTo: 7,
			originId: expect.any(String),
		});
	});

	it("reports nothing for a row with no dot", async () => {
		render(SessionList);
		await pick("read");
		await tick();
		expect(callRpc).not.toHaveBeenCalledWith(
			"MarkSessionSeen",
			expect.anything(),
		);
	});
});
