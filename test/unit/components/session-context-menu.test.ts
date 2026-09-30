import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionContextMenu from "../../../src/lib/frontend/components/session/SessionContextMenu.svelte";
import { openSnoozePicker } from "../../../src/lib/frontend/stores/snooze-picker.svelte.js";
import {
	setSessionAutoSettleRpc,
	setSessionPinnedRpc,
	setSessionSettledRpc,
	unsnoozeSessionRpc,
} from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/stores/router.svelte.js")
		>()),
		getCurrentSlug: () => "test",
	}),
);
vi.mock(
	"../../../src/lib/frontend/stores/snooze-picker.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/stores/snooze-picker.svelte.js")
		>()),
		openSnoozePicker: vi.fn(),
	}),
);
vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		setSessionAutoSettleRpc: vi.fn().mockResolvedValue(undefined),
		setSessionPinnedRpc: vi.fn().mockResolvedValue(undefined),
		setSessionSettledRpc: vi.fn().mockResolvedValue(undefined),
		unsnoozeSessionRpc: vi.fn().mockResolvedValue(undefined),
	}),
);

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function openMenu(
	session: SessionInfo,
	options?: {
		anchor?: HTMLElement;
		projectLabel?: string;
		branch?: string;
		onrename?: () => void;
	},
) {
	render(SessionContextMenu, {
		props: {
			session,
			anchor: options?.anchor ?? document.body,
			projectLabel: options?.projectLabel,
			branch: options?.branch,
			host: { rename: options?.onrename ?? vi.fn() },
			onclose: vi.fn(),
		},
	});
}

describe("session triage menu", () => {
	it("shows a two-line title and separate project and branch in its header", async () => {
		openMenu(
			{
				id: "a",
				title: "Investigate why the websocket reconnect loop double subscribes",
			},
			{ projectLabel: "Conduit", branch: "fix/reconnect" },
		);
		const header = await screen.findByTestId("session-ctx-header");
		expect(header.textContent).toContain(
			"Investigate why the websocket reconnect loop double subscribes",
		);
		expect(header.querySelector(".line-clamp-2")).toBeTruthy();
		expect(
			[...header.querySelectorAll("span")].map((part) => part.textContent),
		).toEqual(["Conduit", "fix/reconnect"]);
		expect(header.getAttribute("tabindex")).toBeNull();
	});

	it("returns focus to its live anchor on Escape", async () => {
		const anchor = document.createElement("button");
		anchor.textContent = "Actions";
		document.body.append(anchor);
		anchor.focus();
		openMenu({ id: "a", title: "Alpha" }, { anchor });
		await screen.findByRole("menu");
		await fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		await vi.waitFor(() => expect(document.activeElement).toBe(anchor));
		anchor.remove();
	});

	it("keeps focus in the rename input after selecting Rename", async () => {
		const anchor = document.createElement("button");
		const input = document.createElement("input");
		document.body.append(anchor, input);
		openMenu(
			{ id: "a", title: "Alpha" },
			{ anchor, onrename: () => input.focus() },
		);
		await fireEvent.click(await screen.findByTestId("session-ctx-rename"));
		expect(document.activeElement).toBe(input);
		anchor.remove();
		input.remove();
	});
	it("puts Settle and Pin above Rename, with a divider", async () => {
		openMenu({ id: "a", title: "Alpha" });
		await screen.findByTestId("session-ctx-rename");
		const firstFour = [
			...screen
				.getByRole("menu")
				.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'),
		].slice(0, 4);
		expect(firstFour.map((item) => item.getAttribute("data-testid"))).toEqual([
			"session-ctx-settle",
			"session-ctx-auto-settle",
			"session-ctx-snooze",
			"session-ctx-pin",
		]);
		for (const [index, label] of [
			"Settle",
			"Auto-settle when idle",
			"Snooze…",
			"Pin to top",
		].entries()) {
			expect(firstFour[index]?.textContent).toContain(label);
		}
		expect(screen.getAllByRole("separator").length).toBeGreaterThan(0);
		expect(screen.getByTestId("session-ctx-rename")).toBeTruthy();
		await fireEvent.click(screen.getByTestId("session-ctx-settle"));
		expect(setSessionSettledRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				projectSlug: "test",
				sessionId: "a",
				settled: true,
			}),
		);
	});

	it("toggles auto-settle through a checkbox item", async () => {
		openMenu({ id: "a", title: "Alpha" });
		const checkbox = await screen.findByRole("menuitemcheckbox", {
			name: "Auto-settle when idle",
		});
		expect(checkbox.getAttribute("aria-checked")).toBe("true");
		await fireEvent.click(checkbox);
		expect(setSessionAutoSettleRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				projectSlug: "test",
				sessionId: "a",
				disabled: true,
			}),
		);
		cleanup();
		openMenu({ id: "a", title: "Alpha", autoSettleDisabled: true });
		const unchecked = await screen.findByRole("menuitemcheckbox", {
			name: "Auto-settle when idle",
		});
		expect(unchecked.getAttribute("aria-checked")).toBe("false");
		await fireEvent.click(unchecked);
		expect(setSessionAutoSettleRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				projectSlug: "test",
				sessionId: "a",
				disabled: false,
			}),
		);
	});

	it("hides snooze on settled rows", async () => {
		openMenu({ id: "a", title: "Alpha", settledAt: 1 });
		await screen.findByTestId("session-ctx-unsettle");
		expect(screen.queryByTestId("session-ctx-snooze")).toBeNull();
	});

	it("disables snooze on pinned and waiting rows with reasons", async () => {
		openMenu({ id: "a", title: "Alpha", pinnedAt: 1 });
		const snooze = await screen.findByTestId("session-ctx-snooze");
		expect(snooze.getAttribute("aria-disabled")).toBe("true");
		expect(snooze.textContent).toContain("Unpin to snooze");
		await fireEvent.click(snooze);
		expect(openSnoozePicker).not.toHaveBeenCalled();
		cleanup();
		for (const attention of ["needs-approval", "needs-reply"] as const) {
			openMenu({ id: "a", title: "Alpha", attention });
			const waiting = await screen.findByTestId("session-ctx-snooze");
			expect(waiting.getAttribute("aria-disabled")).toBe("true");
			expect(waiting.textContent).toContain("Waiting on you");
			await fireEvent.click(waiting);
			expect(openSnoozePicker).not.toHaveBeenCalled();
			cleanup();
		}
	});

	it("changes or removes an existing snooze", async () => {
		const anchor = document.createElement("button");
		document.body.append(anchor);
		openMenu({ id: "a", title: "Alpha", snoozedAt: 1 }, { anchor });
		const change = await screen.findByTestId("session-ctx-snooze");
		expect(change.textContent).toContain("Change snooze…");
		await fireEvent.click(change);
		expect(openSnoozePicker).toHaveBeenCalledWith(
			expect.objectContaining({ id: "a" }),
			"center",
			expect.any(Function),
		);
		expect(vi.mocked(openSnoozePicker).mock.calls[0]?.[2]?.()).toBe(anchor);
		anchor.remove();
		// Re-open with the same snoozed state.
		cleanup();
		openMenu({ id: "a", title: "Alpha", snoozedAt: 1 });
		await fireEvent.click(await screen.findByTestId("session-ctx-unsnooze"));
		expect(unsnoozeSessionRpc).toHaveBeenCalledWith(
			expect.objectContaining({ projectSlug: "test", sessionId: "a" }),
		);
	});

	it("un-settles a settled session", async () => {
		openMenu({ id: "a", title: "Alpha", settledAt: 0 });
		await fireEvent.click(await screen.findByTestId("session-ctx-unsettle"));
		expect(setSessionSettledRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				projectSlug: "test",
				sessionId: "a",
				settled: false,
			}),
		);
	});

	it("pins a session", async () => {
		openMenu({ id: "a", title: "Alpha" });
		await fireEvent.click(await screen.findByTestId("session-ctx-pin"));
		expect(setSessionPinnedRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				projectSlug: "test",
				sessionId: "a",
				pinned: true,
			}),
		);
	});

	it("explains the disabled Settle action on a pinned session and allows Unpin", async () => {
		openMenu({
			id: "a",
			title: "Alpha",
			pinnedAt: 0,
		});
		const settle = await screen.findByTestId("session-ctx-settle");
		expect(settle.getAttribute("aria-disabled")).toBe("true");
		expect(settle.textContent).toContain("Unpin to settle");
		await fireEvent.click(settle);
		expect(setSessionSettledRpc).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByTestId("session-ctx-unpin"));
		expect(setSessionPinnedRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				projectSlug: "test",
				sessionId: "a",
				pinned: false,
			}),
		);
	});
});
