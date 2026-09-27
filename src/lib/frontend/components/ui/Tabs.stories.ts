import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { SEGMENTED_VARIANT_NAMES } from "./segmented-styles.js";
import Tabs from "./Tabs.svelte";

const SECTIONS = [
	{ value: "notifications", label: "Alerts" },
	{ value: "appearance", label: "Theme" },
	{ value: "visibility", label: "Agents & Models" },
];

const meta = {
	title: "UI/Tabs",
	component: Tabs,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: {
		value: "notifications",
		options: SECTIONS,
		label: "Settings sections",
	},
	argTypes: {
		variant: { control: "select", options: SEGMENTED_VARIANT_NAMES },
	},
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

/** SettingsPanel's five-tab header: an underline pulled over the strip's rule. */
export const Underline: Story = {};

/** DiffView's Unified/Split switch, the only variant that hovers a border colour. */
export const Pill: Story = {
	args: {
		variant: "pill",
		value: "unified",
		label: "Diff view mode",
		options: [
			{ value: "unified", label: "Unified" },
			{ value: "split", label: "Split" },
		],
	},
};

/** The last option selected, so the unselected recipe is what is mostly on screen. */
export const LastSelected: Story = {
	args: { value: "visibility" },
};

/**
 * The reason the primitive exists. Both hand-written strips it replaced were,
 * to a screen reader, a row of unrelated buttons: no tablist, no tab roles, no
 * aria-selected. This asserts all three, and that exactly one tab is selected.
 */
export const AnnouncesTabSemantics: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);

		await expect(canvas.getByRole("tablist")).toHaveAccessibleName(
			"Settings sections",
		);

		const tabs = canvas.getAllByRole("tab");
		await expect(tabs).toHaveLength(3);
		await expect(
			tabs.filter((t) => t.getAttribute("aria-selected") === "true"),
		).toHaveLength(1);
		await expect(tabs[0]).toHaveAttribute("aria-selected", "true");
	},
};

/**
 * Roving tabindex plus arrow keys is the behaviour neither hand-written strip
 * had, and the whole reason this is built on bits-ui rather than hand-rolled.
 * Only the selected tab is reachable by Tab; the arrows move between them.
 */
export const ArrowKeysMoveSelection: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const tabs = canvas.getAllByRole("tab");

		// Roving: one stop in the tab order, not three.
		await expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);

		tabs[0]?.focus();
		await userEvent.keyboard("{ArrowRight}");

		await expect(tabs[1]).toHaveAttribute("aria-selected", "true");
		await expect(tabs[0]).toHaveAttribute("aria-selected", "false");
	},
};

/**
 * The underline is drawn by `border-b-2` + `border-accent`, not by an inline
 * style. The as-found SettingsPanel markup carried `border-none`, which sets
 * border-style to none and so killed `border-b-2` outright; the underline was
 * being drawn entirely by an inline `style="border-bottom: ..."` while the
 * conditional border-colour class sat there as dead code contradicting it.
 * This asserts the classes are load-bearing again and no inline style remains.
 *
 * The colour was `brand-a` until conduit-test-de3.6 converged all three strips
 * onto `accent` -- same value in both themes, so this assertion moved one word
 * and no pixel.
 */
export const UnderlineIsDrawnByClasses: Story = {
	play: async ({ canvasElement }) => {
		const selected = within(canvasElement)
			.getAllByRole("tab")
			.find((t) => t.getAttribute("aria-selected") === "true");

		await expect(selected).toBeDefined();
		await expect(selected?.getAttribute("style")).toBeNull();
		await expect(selected?.className).toContain("border-accent");
		await expect(selected?.className).not.toContain("border-none");
	},
};
