import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import RovingFocusHost from "./fixtures/RovingFocusHost.svelte";

describe("rovingFocus", () => {
	afterEach(cleanup);

	it("moves focus and the active tabindex with vertical arrows", async () => {
		const { getByTestId } = render(RovingFocusHost);
		const host = getByTestId("roving-host");
		const first = getByTestId("roving-first");
		const middle = getByTestId("roving-middle");
		first.focus();

		await fireEvent.keyDown(host, { key: "ArrowDown" });

		expect(first.getAttribute("tabindex")).toBe("-1");
		expect(middle.getAttribute("tabindex")).toBe("0");
		expect(document.activeElement).toBe(middle);

		await fireEvent.keyDown(host, { key: "ArrowUp" });

		expect(first.getAttribute("tabindex")).toBe("0");
		expect(middle.getAttribute("tabindex")).toBe("-1");
		expect(document.activeElement).toBe(first);
	});

	it("supports Home and End", async () => {
		const { getByTestId } = render(RovingFocusHost);
		const host = getByTestId("roving-host");

		await fireEvent.keyDown(host, { key: "End" });
		expect(document.activeElement).toBe(getByTestId("roving-last"));

		await fireEvent.keyDown(host, { key: "Home" });
		expect(document.activeElement).toBe(getByTestId("roving-first"));
	});

	it("loops at the ends by default", async () => {
		const { getByTestId } = render(RovingFocusHost);
		const host = getByTestId("roving-host");

		await fireEvent.keyDown(host, { key: "ArrowUp" });

		expect(document.activeElement).toBe(getByTestId("roving-last"));
	});

	it("uses only horizontal arrows in horizontal orientation", async () => {
		const { getByTestId } = render(RovingFocusHost, {
			props: { options: { orientation: "horizontal" } },
		});
		const host = getByTestId("roving-host");
		const first = getByTestId("roving-first");
		first.focus();

		const verticalEvent = new KeyboardEvent("keydown", {
			key: "ArrowDown",
			bubbles: true,
			cancelable: true,
		});
		host.dispatchEvent(verticalEvent);

		expect(verticalEvent.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(first);

		await fireEvent.keyDown(host, { key: "ArrowRight" });
		expect(document.activeElement).toBe(getByTestId("roving-middle"));
	});

	it("reports virtual highlights without moving focus or tabindex", async () => {
		const onHighlight = vi.fn();
		const { getByTestId } = render(RovingFocusHost, {
			props: { options: { virtual: true, onHighlight } },
		});
		const host = getByTestId("roving-host");
		const middle = getByTestId("roving-middle");
		host.focus();

		await fireEvent.keyDown(host, { key: "ArrowDown" });

		expect(document.activeElement).toBe(host);
		expect(middle.hasAttribute("tabindex")).toBe(false);
		expect(onHighlight).toHaveBeenCalledWith(1, middle);
	});

	it("still focuses the new last item after the list shrinks (End)", async () => {
		const { getByTestId } = render(RovingFocusHost);
		const host = getByTestId("roving-host");
		const middle = getByTestId("roving-middle");
		const last = getByTestId("roving-last");

		await fireEvent.keyDown(host, { key: "End" });
		expect(document.activeElement).toBe(last);

		last.remove();
		await fireEvent.keyDown(host, { key: "End" });

		expect(document.activeElement).toBe(middle);
	});

	it("skips disabled items when arrowing", async () => {
		const { getByTestId } = render(RovingFocusHost);
		const host = getByTestId("roving-host");
		const first = getByTestId("roving-first");
		const middle = getByTestId("roving-middle");
		const last = getByTestId("roving-last");
		middle.setAttribute("disabled", "");
		first.focus();

		await fireEvent.keyDown(host, { key: "ArrowDown" });

		expect(document.activeElement).toBe(last);
		expect(last.getAttribute("tabindex")).toBe("0");
	});

	it("ignores modifier-chorded arrow keys", () => {
		const { getByTestId } = render(RovingFocusHost);
		const host = getByTestId("roving-host");
		const first = getByTestId("roving-first");
		first.focus();

		const event = new KeyboardEvent("keydown", {
			key: "ArrowDown",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		host.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(first);
	});

	it("clamps at the ends when loop is disabled", async () => {
		const { getByTestId } = render(RovingFocusHost, {
			props: { options: { loop: false } },
		});
		const host = getByTestId("roving-host");
		const first = getByTestId("roving-first");
		first.focus();

		await fireEvent.keyDown(host, { key: "ArrowUp" });
		expect(document.activeElement).toBe(first);

		await fireEvent.keyDown(host, { key: "End" });
		await fireEvent.keyDown(host, { key: "ArrowDown" });
		expect(document.activeElement).toBe(getByTestId("roving-last"));
	});
});
