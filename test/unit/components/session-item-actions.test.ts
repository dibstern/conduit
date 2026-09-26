import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionItem from "../../../src/lib/frontend/components/session/SessionItem.svelte";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function item(session: SessionInfo = { id: "a", title: "Alpha" }) {
	const onsettle = vi.fn();
	const onpin = vi.fn();
	const onsnooze = vi.fn();
	const onunsnooze = vi.fn();
	const oncommitsnooze = vi.fn();
	const onswitchsession = vi.fn();
	const oncontextmenu = vi.fn();
	render(SessionItem, {
		props: {
			session,
			href: "/s/a",
			onsettle,
			onpin,
			onsnooze,
			onunsnooze,
			oncommitsnooze,
			onswitchsession,
			oncontextmenu,
		},
	});
	const row = screen.getByRole("link");
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
	return {
		row,
		onsettle,
		onpin,
		onsnooze,
		onunsnooze,
		oncommitsnooze,
		onswitchsession,
		oncontextmenu,
	};
}

async function swipe(
	row: HTMLElement,
	dx: number,
	end = dx,
	pointerType = "touch",
) {
	await fireEvent.pointerDown(row, {
		pointerId: 1,
		pointerType,
		clientX: 100,
		clientY: 10,
	});
	await fireEvent.pointerMove(window, {
		pointerId: 1,
		pointerType,
		clientX: 100 + dx,
		clientY: 10,
	});
	if (end !== dx)
		await fireEvent.pointerMove(window, {
			pointerId: 1,
			pointerType,
			clientX: 100 + end,
			clientY: 10,
		});
	await fireEvent.pointerUp(window, {
		pointerId: 1,
		pointerType,
		clientX: 100 + end,
		clientY: 10,
	});
}

describe("SessionItem row actions", () => {
	it("commits settle and tomorrow snooze in opposite directions", async () => {
		const first = item();
		await swipe(first.row, 120);
		expect(first.onsettle).toHaveBeenCalledWith("a", true);
		await fireEvent.click(first.row);
		expect(first.onswitchsession).not.toHaveBeenCalled();
		cleanup();
		const second = item();
		await swipe(second.row, -120);
		expect(second.oncommitsnooze).toHaveBeenCalledWith("a");
	});

	it("uses the inverse swipe verbs on settled and snoozed rows", async () => {
		const settled = item({ id: "a", title: "Alpha", settledAt: 1 });
		await swipe(settled.row, 120);
		expect(settled.onsettle).toHaveBeenCalledWith("a", false);
		cleanup();
		const snoozed = item({ id: "a", title: "Alpha", snoozedAt: 1 });
		await swipe(snoozed.row, -120);
		expect(snoozed.onunsnooze).toHaveBeenCalledWith("a");
		expect(snoozed.oncommitsnooze).not.toHaveBeenCalled();
	});

	it("shows reveal and armed labels before release", async () => {
		const { row } = item();
		await fireEvent.pointerDown(row, {
			pointerId: 1,
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});
		await fireEvent.pointerMove(window, {
			pointerId: 1,
			pointerType: "touch",
			clientX: 80,
			clientY: 10,
		});
		expect(
			screen.getByTestId("session-swipe-action").getAttribute("data-stage"),
		).toBe("reveal");
		expect(screen.getByTestId("session-swipe-action").textContent).toContain(
			"Settle",
		);
		await fireEvent.pointerMove(window, {
			pointerId: 1,
			pointerType: "touch",
			clientX: 130,
			clientY: 10,
		});
		expect(
			screen.getByTestId("session-swipe-action").getAttribute("data-stage"),
		).toBe("commit");
		expect(screen.getByTestId("session-swipe-action").textContent).toContain(
			"Release to settle",
		);
		await fireEvent.pointerCancel(window, {
			pointerId: 1,
			pointerType: "touch",
		});
	});

	it("holds a revealed action as a button, then closes without navigation", async () => {
		const { row, onsettle, onswitchsession } = item();
		await swipe(row, 70);
		const action = screen.getByTestId("session-swipe-action");
		expect(action.tagName).toBe("BUTTON");
		// The click some browsers send after the swipe must not close the hold.
		await fireEvent.click(row);
		expect(screen.getByTestId("session-swipe-action")).toBeTruthy();
		// A real tap starts with a pointerdown.
		await fireEvent.pointerDown(row, { pointerId: 2, pointerType: "touch" });
		await fireEvent.click(row);
		expect(screen.queryByTestId("session-swipe-action")).toBeNull();
		expect(onswitchsession).not.toHaveBeenCalled();
		await swipe(row, 70);
		await fireEvent.click(screen.getByTestId("session-swipe-action"));
		expect(onsettle).toHaveBeenCalledWith("a", true);
	});

	it("reveals Snooze as a button that opens presets", async () => {
		const { row, onsnooze, oncommitsnooze } = item();
		await swipe(row, -70);
		const action = screen.getByTestId("session-swipe-action");
		expect(action.getAttribute("aria-label")).toBe("Snooze Alpha");
		await fireEvent.click(action);
		expect(onsnooze).toHaveBeenCalledWith("a");
		expect(oncommitsnooze).not.toHaveBeenCalled();
	});

	it("closes a held action when another row is pressed without opening that row", async () => {
		const { row, onswitchsession } = item();
		await swipe(row, 70);
		const outside = document.createElement("button");
		outside.textContent = "Outside";
		const click = vi.fn();
		outside.addEventListener("click", click);
		document.body.append(outside);
		await fireEvent.pointerDown(outside, {
			pointerType: "touch",
			pointerId: 2,
		});
		await fireEvent.click(outside);
		expect(screen.queryByTestId("session-swipe-action")).toBeNull();
		expect(click).not.toHaveBeenCalled();
		expect(onswitchsession).not.toHaveBeenCalled();
		outside.remove();
	});

	it("leaves vertical scrolling and ordinary taps alone", async () => {
		const { row, onsettle, onswitchsession } = item();
		await fireEvent.pointerDown(row, {
			pointerId: 1,
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});
		await fireEvent.pointerMove(window, {
			pointerId: 1,
			pointerType: "touch",
			clientX: 15,
			clientY: 50,
		});
		await fireEvent.pointerUp(window, {
			pointerId: 1,
			pointerType: "touch",
			clientX: 15,
			clientY: 50,
		});
		expect(onsettle).not.toHaveBeenCalled();
		await fireEvent.pointerDown(row, {
			pointerId: 2,
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});
		await fireEvent.pointerUp(window, {
			pointerId: 2,
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});
		await fireEvent.click(row);
		expect(onswitchsession).toHaveBeenCalledWith("a");
	});

	it("backs out below reveal and ignores mouse drags", async () => {
		const { row, onsettle, onswitchsession } = item();
		await swipe(row, 120, 20);
		await swipe(row, 120, 120, "mouse");
		await swipe(row, 120, 120, "pen");
		expect(onsettle).not.toHaveBeenCalled();
		expect(screen.queryByTestId("session-swipe-action")).toBeNull();
		await fireEvent.click(row);
		expect(onswitchsession).not.toHaveBeenCalled();
	});

	it("refuses pinned settle and waiting snooze", async () => {
		const pinned = item({ id: "a", title: "Alpha", pinnedAt: 1 });
		await fireEvent.pointerDown(pinned.row, {
			pointerId: 3,
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});
		await fireEvent.pointerMove(window, {
			pointerId: 3,
			pointerType: "touch",
			clientX: 130,
			clientY: 10,
		});
		expect(pinned.row.style.transform).toBe("translateX(24px)");
		expect(screen.queryByTestId("session-swipe-action")).toBeNull();
		await fireEvent.pointerCancel(window, {
			pointerId: 3,
			pointerType: "touch",
		});
		await swipe(pinned.row, 120);
		expect(pinned.onsettle).not.toHaveBeenCalled();
		cleanup();
		const waiting = item({
			id: "a",
			title: "Alpha",
			attention: "needs-approval",
		});
		await swipe(waiting.row, -120);
		expect(waiting.oncommitsnooze).not.toHaveBeenCalled();
	});

	it("opens one menu on touch long press", async () => {
		vi.useFakeTimers();
		const { row, oncontextmenu, onswitchsession } = item();
		await fireEvent.pointerDown(row, {
			pointerId: 1,
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});
		vi.advanceTimersByTime(500);
		await fireEvent.contextMenu(row);
		expect(oncontextmenu).toHaveBeenCalledTimes(1);
		await fireEvent.click(row);
		expect(onswitchsession).not.toHaveBeenCalled();
	});

	it("lets an early native touch contextmenu open the menu only once", async () => {
		vi.useFakeTimers();
		const { row, oncontextmenu } = item();
		await fireEvent.pointerDown(row, {
			pointerId: 1,
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});
		vi.advanceTimersByTime(400);
		await fireEvent.contextMenu(row);
		vi.advanceTimersByTime(200);
		expect(oncontextmenu).toHaveBeenCalledTimes(1);
	});

	it("renders stateful desktop verbs with menu reasons", async () => {
		const first = item();
		await fireEvent.click(screen.getByTestId("session-act-settle"));
		expect(first.onsettle).toHaveBeenCalledWith("a", true);
		await fireEvent.click(screen.getByTestId("session-act-snooze"));
		expect(first.onsnooze).toHaveBeenCalledWith("a");
		await fireEvent.click(screen.getByTestId("session-act-pin"));
		expect(first.onpin).toHaveBeenCalledWith("a", true);
		cleanup();
		const pinned = item({ id: "a", title: "Alpha", pinnedAt: 1 });
		expect(screen.getByTestId("session-act-settle").getAttribute("title")).toBe(
			"Unpin to settle",
		);
		expect(screen.getByTestId("session-act-snooze").getAttribute("title")).toBe(
			"Unpin to snooze",
		);
		expect(
			screen.getByTestId("session-act-settle").hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen.getByTestId("session-act-snooze").hasAttribute("disabled"),
		).toBe(true);
		await fireEvent.click(screen.getByTestId("session-act-unpin"));
		expect(pinned.onpin).toHaveBeenCalledWith("a", false);
		cleanup();
		item({ id: "a", title: "Alpha", attention: "needs-reply" });
		expect(screen.getByTestId("session-act-snooze").getAttribute("title")).toBe(
			"Waiting on you",
		);
		expect(
			screen.getByTestId("session-act-snooze").hasAttribute("disabled"),
		).toBe(true);
		cleanup();
		const settled = item({ id: "a", title: "Alpha", settledAt: 1 });
		expect(screen.getByTestId("session-act-unsettle")).toBeTruthy();
		expect(screen.queryByTestId("session-act-snooze")).toBeNull();
		await fireEvent.click(screen.getByTestId("session-act-unsettle"));
		expect(settled.onsettle).toHaveBeenCalledWith("a", false);
		cleanup();
		const snoozed = item({ id: "a", title: "Alpha", snoozedAt: 1 });
		await fireEvent.click(screen.getByTestId("session-act-unsnooze"));
		expect(snoozed.onunsnooze).toHaveBeenCalledWith("a");
	});
});
