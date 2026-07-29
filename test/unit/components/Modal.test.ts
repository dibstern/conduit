import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModalDemo from "../../../src/lib/frontend/components/ui/__fixtures__/ModalDemo.svelte";
import OverlappingModals from "./fixtures/OverlappingModals.svelte";

describe("Modal", () => {
	beforeEach(() => {
		vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({
			length: 1,
		} as unknown as DOMRectList);
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
			x: 100,
			y: 100,
			top: 100,
			right: 200,
			bottom: 200,
			left: 100,
			width: 100,
			height: 100,
			toJSON: () => ({}),
		} as DOMRect);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("mounts only when opened", async () => {
		const { getByRole, queryByRole } = render(ModalDemo);

		expect(queryByRole("dialog")).toBeNull();

		await fireEvent.click(getByRole("button", { name: "Open modal" }));

		expect(getByRole("dialog")).toBeTruthy();
	});

	it("renders a modal dialog named by its title", () => {
		const { getByRole } = render(ModalDemo, {
			props: { initiallyOpen: true },
		});
		const dialog = getByRole("dialog", { name: "Modal title" });
		const heading = getByRole("heading", { name: "Modal title", level: 2 });

		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(heading.id).not.toBe("");
		expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
	});

	it("supports a headerless accessible name", () => {
		const { getByRole, queryByRole } = render(ModalDemo, {
			props: {
				initiallyOpen: true,
				title: undefined,
				ariaLabel: "Quick actions",
			},
		});

		expect(getByRole("dialog", { name: "Quick actions" })).toBeTruthy();
		expect(queryByRole("heading")).toBeNull();
	});

	it("falls back to its aria-label when the title is blank", () => {
		const { getByRole, queryByRole } = render(ModalDemo, {
			props: {
				initiallyOpen: true,
				title: " ",
				ariaLabel: "Quick actions",
			},
		});

		expect(getByRole("dialog", { name: "Quick actions" })).toBeTruthy();
		expect(queryByRole("heading")).toBeNull();
	});

	it("wires its description to the dialog", () => {
		const { getByRole, getByText } = render(ModalDemo, {
			props: {
				initiallyOpen: true,
				description: "Supporting details",
			},
		});
		const dialog = getByRole("dialog");
		const description = getByText("Supporting details");

		expect(description.id).not.toBe("");
		expect(dialog.getAttribute("aria-describedby")).toBe(description.id);
	});

	it("dismisses on Escape", async () => {
		const { getByRole, queryByRole } = render(ModalDemo, {
			props: { initiallyOpen: true },
		});

		await fireEvent.keyDown(document, { key: "Escape" });

		expect(queryByRole("dialog")).toBeNull();
		expect(getByRole("button", { name: "Open modal" })).toBeTruthy();
	});

	it("leaves controlled close decisions to the parent", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(ModalDemo, {
			props: { initiallyOpen: true, onclose },
		});

		await fireEvent.keyDown(document, { key: "Escape" });

		expect(onclose).toHaveBeenCalledOnce();
		expect(getByRole("dialog")).toBeTruthy();
	});

	it("stays open when an unprevented Bits close is refused by the parent", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(ModalDemo, {
			props: {
				initiallyOpen: true,
				onclose,
				withBitsClose: true,
			},
		});

		await fireEvent.click(getByRole("button", { name: "Close through Bits" }));

		expect(onclose).toHaveBeenCalledOnce();
		expect(getByRole("dialog")).toBeTruthy();
	});

	it("dismisses on backdrop clicks but not panel clicks", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(ModalDemo, {
			props: { initiallyOpen: true, onclose },
		});
		const dialog = getByRole("dialog");
		const backdrop = document.querySelector<HTMLElement>(
			"[data-dialog-overlay]",
		);

		expect(backdrop).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await fireEvent.pointerDown(dialog, { button: 0, pointerType: "mouse" });
		expect(onclose).not.toHaveBeenCalled();

		await fireEvent.pointerDown(backdrop as HTMLElement, {
			button: 0,
			pointerType: "mouse",
			clientX: 0,
			clientY: 0,
		});

		await waitFor(() => expect(onclose).toHaveBeenCalledOnce());
	});

	it("keeps dismiss gestures inert while leaving the close button independent", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(ModalDemo, {
			props: { initiallyOpen: true, dismissible: false, onclose },
		});
		const dialog = getByRole("dialog");
		const backdrop = document.querySelector<HTMLElement>(
			"[data-dialog-overlay]",
		);

		expect(backdrop).not.toBeNull();
		await fireEvent.keyDown(document, { key: "Escape" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		await fireEvent.pointerDown(backdrop as HTMLElement, {
			button: 0,
			pointerType: "mouse",
			clientX: 0,
			clientY: 0,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onclose).not.toHaveBeenCalled();
		expect(getByRole("dialog")).toBe(dialog);

		await fireEvent.click(getByRole("button", { name: "Close" }));
		expect(onclose).toHaveBeenCalledOnce();
	});

	it("shows the close button by default and can hide it", async () => {
		const view = render(ModalDemo, {
			props: { initiallyOpen: true },
		});

		expect(view.getByRole("button", { name: "Close" })).toBeTruthy();

		await view.rerender({ initiallyOpen: true, showClose: false });

		expect(view.queryByRole("button", { name: "Close" })).toBeNull();
	});

	it("focuses body content first, keeps Close last, and restores trigger focus", async () => {
		const { getByRole, queryByRole } = render(ModalDemo);
		const trigger = getByRole("button", { name: "Open modal" });
		trigger.focus();

		await fireEvent.click(trigger);
		const dialog = getByRole("dialog");
		const firstAction = getByRole("button", { name: "First action" });
		const focusable = dialog.querySelectorAll<HTMLElement>(
			'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
		);
		await waitFor(() => expect(document.activeElement).toBe(firstAction));
		expect(focusable.item(focusable.length - 1)).toBe(
			getByRole("button", { name: "Close" }),
		);

		await fireEvent.click(getByRole("button", { name: "Close" }));

		expect(queryByRole("dialog")).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});

	it("makes the background inert while open and restores it on close", async () => {
		const { getByRole } = render(ModalDemo);
		const trigger = getByRole("button", { name: "Open modal" });

		expect(trigger.hasAttribute("inert")).toBe(false);
		expect(trigger.hasAttribute("aria-hidden")).toBe(false);

		await fireEvent.click(trigger);

		expect(trigger.hasAttribute("inert")).toBe(true);
		expect(trigger.getAttribute("aria-hidden")).toBe("true");

		await fireEvent.click(getByRole("button", { name: "Close" }));

		expect(trigger.hasAttribute("inert")).toBe(false);
		expect(trigger.hasAttribute("aria-hidden")).toBe(false);
	});

	it("never inerts portaled dialog content", () => {
		const view = render(OverlappingModals);

		const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
		expect(dialogs).toHaveLength(2);
		const overlays = document.querySelectorAll<HTMLElement>(
			"[data-dialog-overlay]",
		);
		expect(overlays).toHaveLength(2);
		for (const portalElement of [...dialogs, ...overlays]) {
			let current: HTMLElement | null = portalElement;
			while (current && current !== document.body) {
				expect(current.hasAttribute("inert")).toBe(false);
				expect(current.hasAttribute("aria-hidden")).toBe(false);
				current = current.parentElement;
			}
		}
		expect(view.getByTestId("background-control").hasAttribute("inert")).toBe(
			true,
		);
	});

	it("keeps overlapping modals compositional when closed out of order", async () => {
		const view = render(OverlappingModals);
		const background = view.getByTestId("background-control");

		expect(background.hasAttribute("inert")).toBe(true);
		expect(background.getAttribute("aria-hidden")).toBe("true");

		await view.rerender({ firstOpen: false, secondOpen: true });

		expect(background.hasAttribute("inert")).toBe(true);
		expect(background.getAttribute("aria-hidden")).toBe("true");

		await view.rerender({ firstOpen: false, secondOpen: false });

		expect(background.hasAttribute("inert")).toBe(false);
		expect(background.hasAttribute("aria-hidden")).toBe(false);
	});

	it("contains focus when the modal has no tabbable descendants", async () => {
		const { getByRole } = render(ModalDemo, {
			props: {
				initiallyOpen: true,
				showClose: false,
				bodyHasAction: false,
			},
		});
		const dialog = getByRole("dialog");
		await waitFor(() => expect(document.activeElement).toBe(dialog));

		const tab = new KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		});
		dialog.dispatchEvent(tab);

		expect(tab.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(dialog);
	});
});
