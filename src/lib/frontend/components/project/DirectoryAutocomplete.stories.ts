import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import DirectoryAutocompleteDemo from "./__fixtures__/DirectoryAutocompleteDemo.svelte";
import DirectoryAutocomplete from "./DirectoryAutocomplete.svelte";

const LISTBOX_NAME = "Directory suggestions";

/**
 * `class` on DetachedListbox is additive and this repo has no `tailwind-merge`,
 * so a class string proves nothing about which declaration wins. Measure the
 * computed values against live reference probes instead. DirectoryAutocomplete
 * keeps the canonical `rounded-lg` (no radius override) and overrides only the
 * stacking tier, down from the popover tier to the dropdown tier.
 */
async function assertSwapStyles(
	canvasElement: HTMLElement,
	surface: HTMLElement,
) {
	const radiusProbe = document.createElement("div");
	radiusProbe.className = "rounded-lg";
	const dropdownProbe = document.createElement("div");
	dropdownProbe.className = "z-[var(--z-dropdown)]";
	const popoverProbe = document.createElement("div");
	popoverProbe.className = "z-[var(--z-popover)]";
	canvasElement.append(radiusProbe, dropdownProbe, popoverProbe);

	try {
		const surfaceStyle = getComputedStyle(surface);
		const radius = getComputedStyle(radiusProbe).borderRadius;
		const dropdownZIndex = getComputedStyle(dropdownProbe).zIndex;
		const popoverZIndex = getComputedStyle(popoverProbe).zIndex;
		console.log(
			`[swap-style] DirectoryAutocomplete borderRadius=${surfaceStyle.borderRadius} reference=${radius}; zIndex=${surfaceStyle.zIndex} dropdownReference=${dropdownZIndex} popoverReference=${popoverZIndex}`,
		);
		await expect(surfaceStyle.borderRadius).toBe(radius);
		await expect(surfaceStyle.zIndex).toBe(dropdownZIndex);
		await expect(surfaceStyle.zIndex).not.toBe(popoverZIndex);
	} finally {
		radiusProbe.remove();
		dropdownProbe.remove();
		popoverProbe.remove();
	}
}

const meta = {
	title: "Project/DirectoryAutocomplete",
	component: DirectoryAutocomplete,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: {
		value: "",
		placeholder: "/path/to/project",
		onsubmit: fn(),
	},
} satisfies Meta<typeof DirectoryAutocomplete>;

export default meta;
type Story = StoryObj<typeof meta>;

// The interaction stories opt into a strict axe gate for the combobox/listbox ARIA this
// ticket adds. Exactly one rule is disabled, and it names a decision open elsewhere:
//
//   aria-allowed-role  Stays live. Unlike InputArea's <textarea>, this consumer drives a real
//                      <input>, where role="combobox" is conforming — the rule genuinely
//                      protects this surface, so conduit-test-n9s does not reach here.
//   color-contrast     Disabled, matching InputArea.stories.ts. The option row's muted
//                      `parentPath` span measures 3.08:1 (#71717a on #27272a), and it is
//                      byte-identical to HEAD's markup — this swap did not introduce it. It is
//                      conduit-test-de3.28.2's contrast floor, gated on a pending colour
//                      decision, so enabling the rule here would silently make that decision.
//                      Expires when de3.28.2 lands.
//
// Worth knowing if you re-measure: an earlier revision left color-contrast live on the
// strength of a green `vitest --project=storybook` run. That gate is not sensitive to this
// rule — the same story fails color-contrast in the built preview, which is where
// `test:storybook-visual` evaluates it. Trust the preview, not vitest, for contrast.
const STRICT_ARIA = {
	a11y: {
		test: "error",
		config: { rules: [{ id: "color-contrast", enabled: false }] },
	},
} as const;

export const Default: Story = {};

export const WithPath: Story = {
	args: {
		value: "/Users/dev/src/conduit",
	},
};

/**
 * The full contract, driven through the real component against a deterministic
 * loader: Tab drills, Enter commits, closed Enter submits, open Escape is
 * consumed and closed Escape bubbles, and blur keeps the surface alive for its
 * grace window. The exact 199/200 ms boundary is asserted under fake timers in
 * `test/unit/components/directory-autocomplete.test.ts`.
 */
export const DrillDownInteraction: Story = {
	parameters: STRICT_ARIA,
	render: () => ({ Component: DirectoryAutocompleteDemo }),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = canvas.getByRole("combobox", { name: "Project directory" });
		const originalScrollIntoView = Element.prototype.scrollIntoView;
		const scrollIntoView = fn();
		Element.prototype.scrollIntoView = scrollIntoView;

		try {
			await expect(input).toHaveAttribute("aria-expanded", "false");
			await expect(input).not.toHaveAttribute("aria-controls");

			// ── Level one ────────────────────────────────────────────────────────
			await userEvent.click(input);
			await userEvent.type(input, "/src");
			const listbox = await canvas.findByRole("listbox", {
				name: LISTBOX_NAME,
			});
			await expect(input).toHaveFocus();
			await expect(input).toHaveAttribute("aria-expanded", "true");
			await expect(
				document.getElementById(input.getAttribute("aria-controls") ?? ""),
			).toBe(listbox);
			await expect(canvas.getByTestId("loader-calls")).toHaveTextContent(
				"/src",
			);

			let options = canvas.getAllByRole("option");
			await expect(options[0]).toHaveAttribute("aria-selected", "true");
			await expect(
				document.getElementById(
					input.getAttribute("aria-activedescendant") ?? "",
				),
			).toBe(options[0]);
			for (const option of options) {
				// Never a tab stop — see the note in directory-autocomplete.test.ts.
				await expect(option).toHaveAttribute("tabindex", "-1");
				await expect(listbox.contains(option)).toBe(true);
			}

			await assertSwapStyles(canvasElement, listbox);
			// More rows than the preserved max height: the surface still scrolls itself.
			await expect(listbox.scrollHeight).toBeGreaterThan(listbox.clientHeight);

			await userEvent.keyboard("{ArrowDown}");
			await waitFor(() => {
				options = canvas.getAllByRole("option");
				expect(options[1]).toHaveAttribute("aria-selected", "true");
				expect(input).toHaveFocus();
				expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
				expect(listbox.contains(options[1] as HTMLElement)).toBe(true);
			});

			// ── Tab drills into the directory; it does not commit ────────────────
			await userEvent.keyboard("{Tab}");
			await waitFor(() => {
				expect(canvas.getAllByRole("option")).toHaveLength(2);
			});
			await expect(input).toHaveValue("/src/routes/");
			await expect(input).toHaveFocus();
			await expect(input).toHaveAttribute("aria-expanded", "true");
			await expect(canvas.getByTestId("loader-calls")).toHaveTextContent(
				"/src /src/routes/",
			);
			await expect(
				canvas
					.getAllByRole("option")
					.map((option) => option.textContent?.trim()),
			).toEqual(["/src/routes/api/", "/src/routes/app/"]);

			// ── Enter commits the level-two path and closes ──────────────────────
			await userEvent.keyboard("{ArrowDown}");
			await userEvent.keyboard("{Enter}");
			await expect(input).toHaveValue("/src/routes/app/");
			await expect(input).toHaveAttribute("aria-expanded", "false");
			await expect(
				canvas.queryByRole("listbox", { name: LISTBOX_NAME }),
			).toBeNull();

			// ── Enter while closed submits exactly once ──────────────────────────
			await expect(canvas.getByTestId("submit-count")).toHaveTextContent("0");
			await userEvent.keyboard("{Enter}");
			await expect(canvas.getByTestId("submit-count")).toHaveTextContent("1");

			// ── Escape: consumed while open, bubbles while closed ────────────────
			await userEvent.clear(input);
			await userEvent.type(input, "/src");
			await canvas.findByRole("listbox", { name: LISTBOX_NAME });
			await userEvent.keyboard("{Escape}");
			await expect(
				canvas.queryByRole("listbox", { name: LISTBOX_NAME }),
			).toBeNull();
			await expect(canvas.getByTestId("parent-escape-count")).toHaveTextContent(
				"0",
			);

			await userEvent.keyboard("{Escape}");
			await expect(canvas.getByTestId("parent-escape-count")).toHaveTextContent(
				"1",
			);

			// ── Blur keeps the surface alive through its grace window ────────────
			await userEvent.clear(input);
			await userEvent.type(input, "/src");
			await canvas.findByRole("listbox", { name: LISTBOX_NAME });
			const outside = canvas.getByTestId("outside-target");
			outside.focus();
			// Queried synchronously, inside the 200 ms grace window.
			await expect(
				canvas.queryByRole("listbox", { name: LISTBOX_NAME }),
			).not.toBeNull();
			await expect(outside).toHaveFocus();
			await waitFor(() =>
				expect(
					canvas.queryByRole("listbox", { name: LISTBOX_NAME }),
				).toBeNull(),
			);
		} finally {
			Element.prototype.scrollIntoView = originalScrollIntoView;
		}
	},
};

/**
 * Pointer selection behaves like Tab, not like Enter: mousedown is prevented so
 * the input never loses focus, and the surface stays open on the next level.
 */
export const PointerDrillKeepsFocus: Story = {
	// Ends with the drop-up still expanded, and it is absolutely positioned, so it
	// escapes `#storybook-root`. `DrillDownInteraction` needs no such tag: it ends
	// on the closed surface after the blur window, so nothing escapes.
	tags: ["viewport-capture"],
	parameters: STRICT_ARIA,
	render: () => ({ Component: DirectoryAutocompleteDemo }),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = canvas.getByRole("combobox", { name: "Project directory" });

		await userEvent.click(input);
		await userEvent.type(input, "/src");
		await canvas.findByRole("listbox", { name: LISTBOX_NAME });

		const routes = canvas
			.getAllByRole("option")
			.find((option) => option.textContent?.trim() === "/src/routes/");
		await userEvent.click(routes as HTMLElement);

		await waitFor(() => {
			expect(
				canvas
					.getAllByRole("option")
					.map((option) => option.textContent?.trim()),
			).toEqual(["/src/routes/api/", "/src/routes/app/"]);
		});
		await expect(input).toHaveValue("/src/routes/");
		await expect(input).toHaveFocus();
		await expect(input).toHaveAttribute("aria-expanded", "true");
	},
};
