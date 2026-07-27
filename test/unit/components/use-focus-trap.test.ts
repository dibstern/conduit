import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FocusTrapHost from "./fixtures/FocusTrapHost.svelte";

describe("focusTrap", () => {
	beforeEach(() => {
		vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({
			length: 1,
		} as unknown as DOMRectList);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("focuses the first focusable descendant on activation", () => {
		const { getByTestId } = render(FocusTrapHost);

		expect(document.activeElement).toBe(getByTestId("focus-first"));
	});

	it("honors an explicit initial focus target", () => {
		const { getByTestId } = render(FocusTrapHost, {
			props: {
				options: {
					initialFocus: () =>
						document.querySelector<HTMLElement>('[data-testid="focus-middle"]'),
				},
			},
		});

		expect(document.activeElement).toBe(getByTestId("focus-middle"));
	});

	it("wraps Tab from the last item to the first", async () => {
		const { getByTestId } = render(FocusTrapHost);
		const trap = getByTestId("focus-trap");
		getByTestId("focus-last").focus();

		await fireEvent.keyDown(trap, { key: "Tab" });

		expect(document.activeElement).toBe(getByTestId("focus-first"));
	});

	it("wraps Shift+Tab from the first item to the last", async () => {
		const { getByTestId } = render(FocusTrapHost);
		const trap = getByTestId("focus-trap");

		await fireEvent.keyDown(trap, { key: "Tab", shiftKey: true });

		expect(document.activeElement).toBe(getByTestId("focus-last"));
	});

	it("restores focus to the pre-activation element on unmount", () => {
		const returnTarget = document.createElement("button");
		document.body.append(returnTarget);
		returnTarget.focus();
		const { unmount } = render(FocusTrapHost);

		unmount();

		expect(document.activeElement).toBe(returnTarget);
		returnTarget.remove();
	});

	it("applies and precisely restores background attributes", async () => {
		const { getByTestId, rerender } = render(FocusTrapHost, {
			props: { options: { enabled: false } },
		});
		const trigger = getByTestId("focus-trigger");
		const background = getByTestId("focus-background");
		background.setAttribute("aria-hidden", "false");
		trigger.focus();

		await rerender({ options: { enabled: true } });

		expect(trigger.hasAttribute("inert")).toBe(true);
		expect(trigger.getAttribute("aria-hidden")).toBe("true");
		expect(background.hasAttribute("inert")).toBe(true);
		expect(background.getAttribute("aria-hidden")).toBe("true");

		await rerender({ options: { enabled: false } });

		expect(trigger.hasAttribute("inert")).toBe(false);
		expect(trigger.hasAttribute("aria-hidden")).toBe(false);
		expect(background.hasAttribute("inert")).toBe(false);
		expect(background.getAttribute("aria-hidden")).toBe("false");
		expect(document.activeElement).toBe(trigger);
	});

	it("does not trap focus while disabled", async () => {
		const { getByTestId } = render(FocusTrapHost, {
			props: { options: { enabled: false } },
		});
		const background = getByTestId("focus-background");
		background.focus();

		await fireEvent.focusIn(background);

		expect(document.activeElement).toBe(background);
		expect(background.hasAttribute("inert")).toBe(false);
		expect(background.hasAttribute("aria-hidden")).toBe(false);
	});

	it("lets only the topmost stacked trap reclaim escaped focus", async () => {
		const lower = render(FocusTrapHost);
		const upper = render(FocusTrapHost);
		const upperFirst = upper.container.querySelector<HTMLElement>(
			'[data-testid="focus-first"]',
		);
		const lowerFirst = lower.container.querySelector<HTMLElement>(
			'[data-testid="focus-first"]',
		);
		upperFirst?.focus();
		expect(document.activeElement).toBe(upperFirst);

		// A focusin originating inside the top trap must not be yanked away by the
		// lower trap's guard (which would otherwise ping-pong / recurse).
		await fireEvent.focusIn(upperFirst as HTMLElement);

		expect(document.activeElement).toBe(upperFirst);
		expect(document.activeElement).not.toBe(lowerFirst);

		upper.unmount();
		lower.unmount();
	});
});
