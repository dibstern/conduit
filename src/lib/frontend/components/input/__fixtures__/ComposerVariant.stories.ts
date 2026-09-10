import type { Meta, StoryObj } from "@storybook/svelte-vite";
import axe from "axe-core";
import { expect, userEvent, waitFor, within } from "storybook/test";
import ComposerVariant from "./ComposerVariant.svelte";
import ComposerVariantsSideBySide from "./ComposerVariantsSideBySide.svelte";

/**
 * The 3G.1 test article for conduit-test-n9s. See ComposerVariant.svelte.
 *
 * These stories are the surface the 3G.2 Guidepup harness drives, which is why the
 * single-variant stories are separate from the side-by-side one: a screen reader
 * walks the whole document, so one arm per page is what makes a transcript
 * attributable to a variant.
 *
 * They run in real Chromium (vitest.storybook.config.ts, Playwright provider), so
 * the axe results below are from a real accessibility tree, not a jsdom
 * approximation of one.
 */

/**
 * Identical for both arms — that is the entire point. The comparison is only
 * meaningful if the two variants are judged by the same instrument.
 *
 * color-contrast is the one rule disabled, and not to spare a failure: these
 * fixtures use throwaway scaffolding styles, so the rule would measure the
 * harness rather than the ARIA shape under test. conduit's real contrast floor is
 * a separate concern with its own ticket. Every other rule stays on, including
 * the ones nobody expects to fire.
 */
const AXE_OPTIONS = { rules: { "color-contrast": { enabled: false } } };

async function violationIds(el: HTMLElement): Promise<string[]> {
	const results = await axe.run(el, AXE_OPTIONS);
	return results.violations.map((v) => v.id).sort();
}

const meta = {
	title: "Input/ComposerVariant",
	component: ComposerVariant,
	parameters: {
		layout: "padded",
		// Assertions live in play() so both arms are measured by one instrument
		// (see AXE_OPTIONS). The addon would apply its own differently-configured
		// pass on top, so it reports here rather than gating.
		a11y: { test: "todo" },
	},
} satisfies Meta<typeof ComposerVariant>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Option 3A — role=combobox on the <textarea>. The status quo on
 * ds/de3-3-9-combobox, and what google.com ships on its search box.
 *
 * Asserted to violate EXACTLY aria-allowed-role, not merely to violate. The parent
 * ticket's claim is that 3A costs one specific, well-understood violation and no
 * others; an extra violation would falsify that, and zero violations would mean the
 * arm had silently stopped being variant A.
 */
export const VariantA: Story = {
	args: { variant: "A" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = canvas.getByTestId("input-A") as HTMLTextAreaElement;

		await userEvent.click(input);
		await userEvent.type(input, "look at @input");

		await canvas.findByTestId("listbox-A");
		// A exposes "open" as widget STATE, readable at any time on the textarea.
		await expect(input).toHaveAttribute("aria-expanded", "true");

		const firstActive = input.getAttribute("aria-activedescendant");
		await expect(firstActive).toBeTruthy();

		await userEvent.keyboard("{ArrowDown}");
		await waitFor(() =>
			expect(input.getAttribute("aria-activedescendant")).not.toBe(firstActive),
		);

		// Measured while OPEN: the parent ticket records the violation firing both
		// expanded and collapsed, and expanded is the state under test in 3G.2.
		await expect(await violationIds(canvasElement)).toEqual([
			"aria-allowed-role",
		]);

		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(canvas.queryByTestId("listbox-A")).toBeNull());
		await expect(input.value).toContain("FileMenu.svelte");
		await expect(input).toHaveAttribute("aria-expanded", "false");
	},
};

/**
 * Option 3C — no role, no aria-expanded, opened signal via visually-hidden status.
 *
 * Asserted to have ZERO violations. The parent ticket calls 3C "the ONLY option
 * clean under every rule"; this is what makes that claim falsifiable instead of
 * merely asserted.
 */
export const VariantB: Story = {
	args: { variant: "B" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = canvas.getByTestId("input-B") as HTMLTextAreaElement;

		await userEvent.click(input);
		await userEvent.type(input, "look at @input");

		await canvas.findByTestId("listbox-B");
		// B carries neither, by construction. If either appears, the arm has drifted
		// into variant A and every transcript captured from it would be worthless.
		await expect(input).not.toHaveAttribute("role");
		await expect(input).not.toHaveAttribute("aria-expanded");

		// B's replacement signal: spoken via role=status rather than exposed as state.
		await waitFor(() =>
			expect(canvas.getByTestId("status-B")).toHaveTextContent(
				"3 files available",
			),
		);

		const firstActive = input.getAttribute("aria-activedescendant");
		await expect(firstActive).toBeTruthy();

		await userEvent.keyboard("{ArrowDown}");
		await waitFor(() =>
			expect(input.getAttribute("aria-activedescendant")).not.toBe(firstActive),
		);

		await expect(await violationIds(canvasElement)).toEqual([]);

		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(canvas.queryByTestId("listbox-B")).toBeNull());
		await expect(input.value).toContain("FileMenu.svelte");
	},
};

/** Manual side-by-side comparison. Not used by the capture harness. */
export const SideBySide: StoryObj = {
	render: () => ({ Component: ComposerVariantsSideBySide }),
};
