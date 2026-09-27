import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import DetachedListboxDemo from "./__fixtures__/DetachedListboxDemo.svelte";
import { DETACHED_LISTBOX_SURFACE_CLASSES } from "./floating-styles.js";

/**
 * `DetachedListbox` only makes sense next to the input that owns it, so — like
 * `Menu` — these stories render the primitive through a fixture that supplies a
 * real external combobox input, the controls/active-descendant wiring, and two
 * options. That way addon-a11y evaluates the whole ownership relationship rather
 * than an orphan listbox.
 */
const meta = {
	title: "UI/DetachedListbox",
	component: DetachedListboxDemo,
	tags: ["autodocs"],
	parameters: {
		layout: "padded",
		// Opted in per story: the repository-wide setting is still "todo" pending
		// the conduit-test-de3.28 burn-down.
		a11y: { test: "error" },
	},
	argTypes: {
		activeIndex: { control: { type: "number", min: 0 } },
	},
} satisfies Meta<typeof DetachedListboxDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

// The listbox is absolutely positioned, so an expanded surface escapes
// `#storybook-root` and the element-scoped screenshot would silently capture the
// trigger alone. `viewport-capture` screenshots the page instead. Applied
// per-story rather than on `meta`: `Collapsed` renders no surface at all, and
// tagging it would swap its capture mode for no reason.
const VIEWPORT_CAPTURE = ["viewport-capture"];

/** The populated surface, owned by an external combobox input. */
export const Populated: Story = { tags: VIEWPORT_CAPTURE };

/** Collapsed: the input reports `aria-expanded="false"` and no listbox exists. */
export const Collapsed: Story = { args: { open: false } };

/** Loading: an expanded, `aria-busy` listbox with no active descendant. */
export const Loading: Story = {
	args: { busy: true, options: [] },
	tags: VIEWPORT_CAPTURE,
};

/**
 * The full ownership relationship: DOM focus stays on the input, which points at
 * the listbox and at the one selected option.
 */
export const Ownership: Story = {
	args: { activeIndex: 1 },
	tags: VIEWPORT_CAPTURE,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const doc = canvasElement.ownerDocument;
		const input = canvas.getByRole("combobox", { name: "Directory filter" });
		const listbox = canvas.getByRole("listbox", {
			name: "Directory suggestions",
		});

		input.focus();
		await expect(input).toHaveFocus();
		await expect(input).toHaveAttribute("aria-expanded", "true");

		// aria-controls and aria-activedescendant must resolve, not merely exist.
		await expect(
			doc.getElementById(input.getAttribute("aria-controls") ?? ""),
		).toBe(listbox);

		const rows = canvas.getAllByRole("option");
		const selected = rows.filter(
			(row) => row.getAttribute("aria-selected") === "true",
		);
		await expect(selected).toHaveLength(1);
		await expect(
			doc.getElementById(input.getAttribute("aria-activedescendant") ?? ""),
		).toBe(selected[0]);

		// aria-activedescendant navigation, not roving tabindex: nothing in the
		// list is focusable, and the list is inline rather than portaled.
		await expect(listbox.hasAttribute("tabindex")).toBe(false);
		await expect(listbox).not.toHaveFocus();
		for (const row of rows) {
			await expect(listbox.contains(row)).toBe(true);
			await expect(row).not.toHaveFocus();
		}

		await expect(listbox).toHaveAttribute("data-side", "top");
		for (const canonicalClass of DETACHED_LISTBOX_SURFACE_CLASSES.split(
			/\s+/,
		)) {
			await expect(listbox).toHaveClass(canonicalClass);
		}

		// Radius and stacking tier are measured, not matched as class names: both
		// used to be consumer `!` overrides, and a class string proves nothing
		// about which declaration wins without `tailwind-merge`. Probing the
		// popover tier too is the point — that is the value this surface must
		// NOT have (conduit-test-llxm).
		const radiusProbe = document.createElement("div");
		radiusProbe.className = "rounded-lg";
		const dropdownProbe = document.createElement("div");
		dropdownProbe.className = "z-[var(--z-dropdown)]";
		const popoverProbe = document.createElement("div");
		popoverProbe.className = "z-[var(--z-popover)]";
		canvasElement.append(radiusProbe, dropdownProbe, popoverProbe);
		try {
			const surface = getComputedStyle(listbox);
			await expect(surface.borderRadius).toBe(
				getComputedStyle(radiusProbe).borderRadius,
			);
			await expect(surface.zIndex).toBe(getComputedStyle(dropdownProbe).zIndex);
			await expect(surface.zIndex).not.toBe(
				getComputedStyle(popoverProbe).zIndex,
			);
		} finally {
			radiusProbe.remove();
			dropdownProbe.remove();
			popoverProbe.remove();
		}
	},
};
