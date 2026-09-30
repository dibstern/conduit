import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModalDemo from "../../../src/lib/frontend/components/ui/__fixtures__/ModalDemo.svelte";
import OverlappingModals from "./fixtures/OverlappingModals.svelte";

describe("Modal", () => {
	let nativeOpeners: WeakMap<HTMLDialogElement, HTMLElement | null>;
	beforeEach(() => {
		nativeOpeners = new WeakMap();
		vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(
			function (this: HTMLDialogElement) {
				nativeOpeners.set(
					this,
					document.activeElement instanceof HTMLElement
						? document.activeElement
						: null,
				);
				this.open = true;
				const first = this.querySelector<HTMLElement>(
					'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
				);
				(first ?? this).focus();
			},
		);
		vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
			this: HTMLDialogElement,
		) {
			this.open = false;
			nativeOpeners.get(this)?.focus();
		});
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

		expect((dialog as HTMLDialogElement).open).toBe(true);
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

		await fireEvent(
			getByRole("dialog"),
			new Event("cancel", { cancelable: true }),
		);

		expect(queryByRole("dialog")).toBeNull();
		expect(getByRole("button", { name: "Open modal" })).toBeTruthy();
	});

	it("leaves controlled close decisions to the parent", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(ModalDemo, {
			props: { initiallyOpen: true, onclose },
		});

		await fireEvent(
			getByRole("dialog"),
			new Event("cancel", { cancelable: true }),
		);

		expect(onclose).toHaveBeenCalledOnce();
		expect(getByRole("dialog")).toBeTruthy();
	});

	it("stays open when a child close is refused by the parent", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(ModalDemo, {
			props: {
				initiallyOpen: true,
				onclose,
				withChildClose: true,
			},
		});

		await fireEvent.click(getByRole("button", { name: "Close through child" }));

		expect(onclose).toHaveBeenCalledOnce();
		expect(getByRole("dialog")).toBeTruthy();
	});

	it("dismisses on backdrop clicks but not panel clicks", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(ModalDemo, {
			props: { initiallyOpen: true, onclose },
		});
		const dialog = getByRole("dialog");
		const panel = dialog.firstElementChild as HTMLElement;
		await fireEvent.click(panel);
		expect(onclose).not.toHaveBeenCalled();
		// ::backdrop reports the native dialog as the click target.
		await fireEvent.click(dialog);

		await waitFor(() => expect(onclose).toHaveBeenCalledOnce());
	});

	it("keeps dismiss gestures inert while leaving the close button independent", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(ModalDemo, {
			props: { initiallyOpen: true, dismissible: false, onclose },
		});
		const dialog = getByRole("dialog");
		await fireEvent(dialog, new Event("cancel", { cancelable: true }));
		await fireEvent.click(dialog);
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

	it("opens and closes through the native modal dialog", async () => {
		const { getByRole } = render(ModalDemo);
		const trigger = getByRole("button", { name: "Open modal" });

		await fireEvent.click(trigger);
		const dialog = getByRole("dialog") as HTMLDialogElement;
		expect(dialog.open).toBe(true);

		await fireEvent.click(getByRole("button", { name: "Close" }));

		expect(dialog.open).toBe(false);
	});

	it("keeps both native dialogs open when they overlap", () => {
		const view = render(OverlappingModals);

		const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog");
		expect(dialogs).toHaveLength(2);
		for (const dialog of dialogs) expect(dialog.open).toBe(true);
		expect(view.getByTestId("background-control")).toBeTruthy();
	});

	it("keeps overlapping modals compositional when closed out of order", async () => {
		const view = render(OverlappingModals);
		const first = view.getByRole("dialog", {
			name: "First modal",
		}) as HTMLDialogElement;
		const second = view.getByRole("dialog", {
			name: "Second modal",
		}) as HTMLDialogElement;
		expect(first.open).toBe(true);
		expect(second.open).toBe(true);

		await view.rerender({ firstOpen: false, secondOpen: true });

		expect(first.open).toBe(false);
		expect(second.open).toBe(true);

		await view.rerender({ firstOpen: false, secondOpen: false });

		expect(second.open).toBe(false);
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
