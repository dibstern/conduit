import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FLOATING_ITEM_CLASSES,
	FLOATING_SURFACE_CLASSES,
	MENU_ITEM_VARIANT_CLASSES,
	MENU_RADIO_ITEM_COLOR_CLASSES,
} from "../../../src/lib/frontend/components/ui/floating-styles.js";
import MenuInModalHarness from "./fixtures/MenuInModalHarness.svelte";
import MenuTestHarness from "./fixtures/MenuTestHarness.svelte";

const textColorClasses = (classes: string): string[] =>
	classes
		.split(/\s+/)
		.filter((className) =>
			/(?:^|:)text-(?:accent|error|text)$/.test(className),
		);

describe("Menu", () => {
	afterEach(cleanup);

	it("assigns exactly one text color through each item variant or radio state", () => {
		expect(textColorClasses(FLOATING_ITEM_CLASSES)).toEqual([]);
		expect(
			Object.fromEntries(
				Object.entries(MENU_ITEM_VARIANT_CLASSES).map(([variant, classes]) => [
					variant,
					textColorClasses(classes),
				]),
			),
		).toEqual({
			default: ["text-text"],
			danger: ["text-error"],
		});
		expect(textColorClasses(MENU_RADIO_ITEM_COLOR_CLASSES)).toEqual([
			"data-[state=unchecked]:text-text",
			"data-[state=checked]:text-accent",
		]);
	});

	it("suppresses the native surface outline without adding a focus ring", () => {
		const surfaceClasses = FLOATING_SURFACE_CLASSES.split(/\s+/);

		expect(
			surfaceClasses.filter((className) => className.includes("outline-")),
		).toEqual(["focus-visible:outline-hidden"]);
		expect(
			surfaceClasses.filter((className) =>
				className.startsWith("focus-visible:ring-"),
			),
		).toEqual([]);
	});

	it("applies the canonical classes and a valid computed max-height", async () => {
		const { getByRole } = render(MenuTestHarness);
		const menu = getByRole("menu", { name: "Test actions" });

		for (const className of [
			"rounded-lg",
			"border",
			"border-border",
			"bg-bg-alt",
			"py-1",
			"data-[side=top]:shadow-menu",
			"data-[side=bottom]:shadow-dropdown",
			"z-[var(--z-popover)]",
		]) {
			expect(menu.classList.contains(className)).toBe(true);
		}
		const stylesheet = document.createElement("style");
		stylesheet.textContent = (await compile("@tailwind utilities;")).build([
			...menu.classList,
		]);
		document.head.append(stylesheet);
		expect(getComputedStyle(menu).maxHeight).toBe(
			"var(--bits-dropdown-menu-content-available-height)",
		);
		stylesheet.remove();
	});

	it("keeps a body-portaled menu live while its trigger is inside a modal", async () => {
		const view = render(MenuInModalHarness);
		const modal = view.getByRole("dialog", { name: "Modal with menu" });
		const trigger = view.getByRole("button", { name: "Open modal actions" });

		expect(view.getByTestId("modal-menu-open").textContent).toBe("false");
		await fireEvent.click(trigger);
		expect(view.getByTestId("modal-menu-open").textContent).toBe("true");

		await waitFor(() => {
			const menu = document.querySelector<HTMLElement>(
				"[data-dropdown-menu-content]",
			);
			expect(menu).not.toBeNull();
			expect(document.body.contains(menu)).toBe(true);
			expect(modal.contains(menu)).toBe(false);
			const modalBranch = [...document.body.children].find((element) =>
				element.contains(modal),
			);
			const menuBranch = [...document.body.children].find((element) =>
				element.contains(menu),
			);
			expect(menuBranch).toBeDefined();
			expect(menuBranch).not.toBe(modalBranch);

			let current: HTMLElement | null = menu;
			while (current && current !== document.body) {
				expect(current.hasAttribute("inert")).toBe(false);
				expect(current.hasAttribute("aria-hidden")).toBe(false);
				current = current.parentElement;
			}
		});
	});

	it("transitions radio selection, its binding, and the visible checkmark", async () => {
		const view = render(MenuTestHarness, {
			props: { open: true, selected: "compact" },
		});
		const compact = view.getByRole("menuitemradio", { name: "Compact" });
		const comfortable = view.getByRole("menuitemradio", {
			name: "Comfortable",
		});

		expect(view.getByTestId("menu-selected").textContent).toBe("compact");
		expect(compact.getAttribute("aria-checked")).toBe("true");
		expect(comfortable.getAttribute("aria-checked")).toBe("false");
		expect(compact.querySelector("[data-menu-radio-check]")).not.toBeNull();
		expect(comfortable.querySelector("[data-menu-radio-check]")).toBeNull();

		await fireEvent.click(comfortable);
		expect(view.getByTestId("menu-selected").textContent).toBe("comfortable");

		await fireEvent.click(view.getByRole("button", { name: "Open actions" }));
		const updatedCompact = view.getByRole("menuitemradio", { name: "Compact" });
		const updatedComfortable = view.getByRole("menuitemradio", {
			name: "Comfortable",
		});
		expect(updatedCompact.getAttribute("aria-checked")).toBe("false");
		expect(updatedComfortable.getAttribute("aria-checked")).toBe("true");
		expect(updatedCompact.querySelector("[data-menu-radio-check]")).toBeNull();
		expect(
			updatedComfortable.querySelector("[data-menu-radio-check]"),
		).not.toBeNull();
	});

	it("renders labelled groups, correct structural roles, variants, and attributes", () => {
		const { getByRole, getByTestId } = render(MenuTestHarness);

		expect(getByRole("group", { name: "Actions" })).toBeTruthy();
		expect(getByTestId("actions-group").getAttribute("role")).toBe("group");
		expect(
			getByRole("separator").getAttribute("data-dropdown-menu-separator"),
		).toBe("");
		expect(
			document
				.querySelector("[data-dropdown-menu-group-heading]")
				?.getAttribute("role"),
		).toBe("presentation");
		expect(getByTestId("archive-item").getAttribute("role")).toBe("menuitem");
		expect(getByTestId("menu").getAttribute("role")).toBe("menu");
	});

	it("toggles bindable open state, selects an item, and reports open changes", async () => {
		const onopenchange = vi.fn();
		const onarchive = vi.fn();
		const { getByRole, getByTestId, queryByRole } = render(MenuTestHarness, {
			props: { open: false, onopenchange, onarchive },
		});
		const trigger = getByRole("button", { name: "Open actions" });

		expect(getByTestId("menu-open").textContent).toBe("false");
		trigger.focus();
		await fireEvent.click(trigger);
		expect(getByTestId("menu-open").textContent).toBe("true");
		expect(getByRole("menu", { name: "Test actions" })).toBeTruthy();
		expect(onopenchange).toHaveBeenCalledWith(true);

		await fireEvent.click(getByRole("menuitem", { name: "Archive" }));
		await waitFor(() =>
			expect(queryByRole("menu", { name: "Test actions" })).toBeNull(),
		);
		expect(getByTestId("menu-open").textContent).toBe("false");
		expect(onarchive).toHaveBeenCalledOnce();
		expect(onopenchange).toHaveBeenLastCalledWith(false);
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});

	it("portals content to an explicit target", () => {
		const portalTarget = document.createElement("div");
		document.body.append(portalTarget);
		const { getByRole } = render(MenuTestHarness, {
			props: { portalTo: portalTarget },
		});

		expect(
			portalTarget.contains(getByRole("menu", { name: "Test actions" })),
		).toBe(true);
		portalTarget.remove();
	});

	it("positions from a supplied custom anchor", async () => {
		const customAnchor = document.createElement("button");
		document.body.append(customAnchor);
		const measureAnchor = vi
			.spyOn(customAnchor, "getBoundingClientRect")
			.mockReturnValue(
				DOMRect.fromRect({ x: 120, y: 80, width: 40, height: 20 }),
			);

		render(MenuTestHarness, { props: { customAnchor } });

		await waitFor(() => expect(measureAnchor).toHaveBeenCalled());
		customAnchor.remove();
	});

	it("renders native-link items and selects them on a plain click", async () => {
		const onproject = vi.fn();
		const { getByRole, queryByRole } = render(MenuTestHarness, {
			props: { onproject },
		});
		const project = getByRole("menuitem", { name: "Open project" });

		expect(project).toBeInstanceOf(HTMLAnchorElement);
		expect(project.getAttribute("href")).toBe("#project-a");
		await fireEvent.click(project);

		expect(onproject).toHaveBeenCalledOnce();
		await waitFor(() =>
			expect(queryByRole("menu", { name: "Test actions" })).toBeNull(),
		);
	});

	it("moves real focus with arrows and restores it on Escape", async () => {
		const { getByRole, queryByRole } = render(MenuTestHarness, {
			props: { open: false },
		});
		const trigger = getByRole("button", { name: "Open actions" });

		trigger.focus();
		await fireEvent.click(trigger);
		const menu = getByRole("menu", { name: "Test actions" });
		const archive = getByRole("menuitem", { name: "Archive" });
		const deleteItem = getByRole("menuitem", { name: "Delete" });
		await waitFor(() => expect(document.activeElement).toBe(menu));

		await fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement).toBe(archive);

		await fireEvent.keyDown(archive, { key: "ArrowDown" });
		expect(document.activeElement).toBe(deleteItem);

		await fireEvent.keyDown(deleteItem, { key: "Escape" });
		await waitFor(() => expect(queryByRole("menu")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});
});
