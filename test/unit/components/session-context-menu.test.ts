import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionContextMenu from "../../../src/lib/frontend/components/session/SessionContextMenu.svelte";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

afterEach(cleanup);

function openMenu(session: SessionInfo) {
	const onsettle = vi.fn();
	const onpin = vi.fn();
	const onsnooze = vi.fn();
	const onunsnooze = vi.fn();
	render(SessionContextMenu, {
		props: {
			session,
			anchor: document.body,
			onsettle,
			onpin,
			onsnooze,
			onunsnooze,
			onrename: vi.fn(),
			ondelete: vi.fn(),
			oncopyresume: vi.fn(),
			onfork: vi.fn(),
			onclose: vi.fn(),
		},
	});
	return { onsettle, onpin, onsnooze, onunsnooze };
}

describe("session triage menu", () => {
	it("puts Settle and Pin above Rename, with a divider", async () => {
		const { onsettle } = openMenu({ id: "a", title: "Alpha" });
		const items = await screen.findAllByRole("menuitem");
		expect(items.slice(0, 4).map((item) => item.textContent?.trim())).toEqual([
			"Settle",
			"Pin to top",
			"Snooze…",
			"Rename",
		]);
		expect(screen.getByRole("separator")).toBeTruthy();
		await fireEvent.click(screen.getByTestId("session-ctx-settle"));
		expect(onsettle).toHaveBeenCalledWith("a", true);
	});

	it("hides snooze on settled rows", async () => {
		openMenu({ id: "a", title: "Alpha", settledAt: 1 });
		await screen.findByTestId("session-ctx-unsettle");
		expect(screen.queryByTestId("session-ctx-snooze")).toBeNull();
	});

	it("disables snooze on pinned and waiting rows with reasons", async () => {
		const { onsnooze } = openMenu({ id: "a", title: "Alpha", pinnedAt: 1 });
		const snooze = await screen.findByTestId("session-ctx-snooze");
		expect(snooze.getAttribute("aria-disabled")).toBe("true");
		expect(snooze.textContent).toContain("Unpin to snooze");
		await fireEvent.click(snooze);
		expect(onsnooze).not.toHaveBeenCalled();
		cleanup();
		for (const attention of ["needs-approval", "needs-reply"] as const) {
			openMenu({ id: "a", title: "Alpha", attention });
			const waiting = await screen.findByTestId("session-ctx-snooze");
			expect(waiting.getAttribute("aria-disabled")).toBe("true");
			expect(waiting.textContent).toContain("Waiting on you");
			cleanup();
		}
	});

	it("changes or removes an existing snooze", async () => {
		const { onsnooze } = openMenu({ id: "a", title: "Alpha", snoozedAt: 1 });
		const change = await screen.findByTestId("session-ctx-snooze");
		expect(change.textContent).toContain("Change snooze…");
		await fireEvent.click(change);
		expect(onsnooze).toHaveBeenCalledWith("a");
		// Re-open: selecting a menu item closes the portal.
		cleanup();
		const { onunsnooze } = openMenu({ id: "a", title: "Alpha", snoozedAt: 1 });
		await fireEvent.click(await screen.findByTestId("session-ctx-unsnooze"));
		expect(onunsnooze).toHaveBeenCalledWith("a");
	});

	it("un-settles a settled session", async () => {
		const { onsettle } = openMenu({ id: "a", title: "Alpha", settledAt: 0 });
		await fireEvent.click(await screen.findByTestId("session-ctx-unsettle"));
		expect(onsettle).toHaveBeenCalledWith("a", false);
	});

	it("pins a session", async () => {
		const { onpin } = openMenu({ id: "a", title: "Alpha" });
		await fireEvent.click(await screen.findByTestId("session-ctx-pin"));
		expect(onpin).toHaveBeenCalledWith("a", true);
	});

	it("explains the disabled Settle action on a pinned session and allows Unpin", async () => {
		const { onsettle, onpin } = openMenu({
			id: "a",
			title: "Alpha",
			pinnedAt: 0,
		});
		const settle = await screen.findByTestId("session-ctx-settle");
		expect(settle.getAttribute("aria-disabled")).toBe("true");
		expect(settle.textContent).toContain("Unpin to settle");
		await fireEvent.click(settle);
		expect(onsettle).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByTestId("session-ctx-unpin"));
		expect(onpin).toHaveBeenCalledWith("a", false);
	});
});
