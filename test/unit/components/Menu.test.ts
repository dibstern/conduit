import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FLOATING_ITEM_CLASSES,
	FLOATING_SURFACE_CLASSES,
	MENU_ITEM_VARIANT_CLASSES,
	MENU_RADIO_ITEM_COLOR_CLASSES,
} from "../../../src/lib/frontend/components/ui/floating-styles.js";
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

	it("presents a sheet with one row recipe and Escape dismissal", async () => {
		const view = render(MenuTestHarness, {
			props: { open: false, presentation: "sheet" },
		});
		const trigger = view.getByRole("button", { name: "Open actions" });
		trigger.focus();
		await fireEvent.click(trigger);
		const menu = view.getByRole("menu", { name: "Test actions" });
		expect(menu.classList.contains("fixed")).toBe(true);
		expect(menu.classList.contains("bottom-0")).toBe(true);
		expect(menu.classList.contains("z-[var(--z-sheet)]")).toBe(true);
		expect(
			view.getByTestId("menu-sheet-scrim").classList.contains("bg-backdrop"),
		).toBe(true);
		for (const item of ["archive-item", "pinned-item", "compact-item"]) {
			const row = view.getByTestId(item);
			for (const className of [
				"min-h-[44px]",
				"text-[14.5px]",
				"font-[system-ui]",
				"gap-[13px]",
				"px-4",
			]) {
				expect(row.classList.contains(className)).toBe(true);
			}
			expect(row.querySelector(".w-\\[20px\\]")).not.toBeNull();
		}
		expect(
			view
				.getByRole("menuitem", { name: "Open project" })
				.querySelector(".w-\\[20px\\]"),
		).not.toBeNull();
		expect(
			view
				.getByRole("group", { name: "Actions" })
				.querySelector("[data-dropdown-menu-group-heading]")
				?.classList.contains("uppercase"),
		).toBe(true);
		expect(
			view.getByTestId("explicit-density-item").classList.contains("py-1.5"),
		).toBe(true);

		await fireEvent.keyDown(menu, { key: "Escape" });
		await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});

	it("keeps compact dropdown rows and heading typography", () => {
		const view = render(MenuTestHarness);
		for (const item of ["archive-item", "pinned-item", "compact-item"]) {
			const row = view.getByTestId(item);
			expect(row.classList.contains("text-sm")).toBe(true);
			expect(row.classList.contains("py-1.5")).toBe(true);
			expect(row.classList.contains("min-h-[44px]")).toBe(false);
		}
		expect(
			view
				.getByRole("group", { name: "Actions" })
				.querySelector("[data-dropdown-menu-group-heading]")
				?.classList.contains("text-xs"),
		).toBe(true);
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

	it("renders the default leading icon for danger items", () => {
		const { getByRole } = render(MenuTestHarness);
		const deleteItem = getByRole("menuitem", { name: "Delete" });

		expect(
			deleteItem.querySelector("[data-menu-item-icon] svg.lucide-trash-2"),
		).not.toBeNull();
	});

	it("does not render an icon for default items", () => {
		const { getByTestId } = render(MenuTestHarness);

		expect(getByTestId("archive-item").querySelector("svg")).toBeNull();
	});

	it("renders a danger item's icon override", () => {
		const { getByRole } = render(MenuTestHarness, {
			props: { dangerIcon: "wifi-off" },
		});
		const deleteItem = getByRole("menuitem", { name: "Delete" });

		expect(
			deleteItem.querySelector("[data-menu-item-icon] svg.lucide-wifi-off"),
		).not.toBeNull();
		expect(deleteItem.querySelector("svg.lucide-trash-2")).toBeNull();
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
