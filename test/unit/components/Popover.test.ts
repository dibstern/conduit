import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import PopoverTestHarness from "./fixtures/PopoverTestHarness.svelte";

describe("Popover", () => {
	afterEach(cleanup);

	it("renders a named dialog without a computed menu max-height", async () => {
		const { getByRole, getByText } = render(PopoverTestHarness, {
			props: { open: true },
		});
		const dialog = getByRole("dialog", { name: "Details" });
		const heading = getByText("Details");

		expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
		expect(dialog.getAttribute("data-testid")).toBe("popover");
		expect(dialog.classList.contains("rounded-lg")).toBe(true);
		expect(dialog.classList.contains("bg-bg-alt")).toBe(true);
		const stylesheet = document.createElement("style");
		stylesheet.textContent = (await compile("@tailwind utilities;")).build([
			...dialog.classList,
		]);
		document.head.append(stylesheet);
		expect(getComputedStyle(dialog).maxHeight).toBe("");
		stylesheet.remove();
	});

	it("supports a headerless accessible name", () => {
		const { getByRole, queryByRole } = render(PopoverTestHarness, {
			props: { headerless: true, open: true },
		});

		expect(getByRole("dialog", { name: "Quick details" })).toBeTruthy();
		expect(queryByRole("heading")).toBeNull();
	});

	it("toggles its bindable open state and reports the change", async () => {
		const onopenchange = vi.fn();
		const { getByRole } = render(PopoverTestHarness, {
			props: { open: false, onopenchange },
		});
		const openState = getByRole("status");
		const trigger = getByRole("button", { name: "Open details" });

		expect(openState.textContent).toBe("false");
		await fireEvent.click(trigger);

		const dialog = getByRole("dialog", { name: "Details" });
		expect(openState.textContent).toBe("true");
		expect(onopenchange).toHaveBeenCalledWith(true);

		await fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(openState.textContent).toBe("false"));
		expect(onopenchange).toHaveBeenLastCalledWith(false);
	});

	it("keeps a body-portaled popover live while its trigger is inside a modal", async () => {
		const view = render(PopoverTestHarness, {
			props: { insideModal: true, open: false },
		});
		const modal = view.getByRole("dialog", { name: "Modal with popover" });
		const trigger = view.getByRole("button", { name: "Open details" });

		expect(view.getByTestId("popover-open").textContent).toBe("false");
		await fireEvent.click(trigger);
		expect(view.getByTestId("popover-open").textContent).toBe("true");

		await waitFor(() => {
			const popover = document.querySelector<HTMLElement>(
				"[data-popover-content]",
			);
			expect(popover).not.toBeNull();
			expect(document.body.contains(popover)).toBe(true);
			expect(modal.contains(popover)).toBe(false);
			const modalBranch = [...document.body.children].find((element) =>
				element.contains(modal),
			);
			const popoverBranch = [...document.body.children].find((element) =>
				element.contains(popover),
			);
			expect(popoverBranch).toBeDefined();
			expect(popoverBranch).not.toBe(modalBranch);

			let current: HTMLElement | null = popover;
			while (current && current !== document.body) {
				expect(current.hasAttribute("inert")).toBe(false);
				expect(current.hasAttribute("aria-hidden")).toBe(false);
				current = current.parentElement;
			}
		});
	});

	it("portals content to an explicit target", () => {
		const portalTarget = document.createElement("div");
		document.body.append(portalTarget);
		const { getByRole } = render(PopoverTestHarness, {
			props: { open: true, portalTo: portalTarget },
		});

		expect(
			portalTarget.contains(getByRole("dialog", { name: "Details" })),
		).toBe(true);
		portalTarget.remove();
	});

	it("warns when a dynamic accessible name contains only whitespace", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		render(PopoverTestHarness, {
			props: {
				open: true,
				headerless: true,
				accessibleName: " ",
			},
		});

		await waitFor(() =>
			expect(warning).toHaveBeenCalledWith(
				"[ui/Popover] `title` or `ariaLabel` must contain a non-whitespace accessible name.",
			),
		);
		warning.mockRestore();
	});
});
