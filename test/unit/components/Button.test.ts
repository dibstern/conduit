import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Button from "../../../src/lib/frontend/components/ui/Button.svelte";
import {
	BUTTON_DISABLED_STYLES,
	BUTTON_HOVER_FILLS,
	BUTTON_TONES,
	BUTTON_VARIANTS,
} from "../../../src/lib/frontend/components/ui/button-recipes.js";

const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe("Button", () => {
	afterEach(cleanup);

	it("renders its label and defaults to the secondary variant", () => {
		const { getByRole } = render(Button, {
			props: { children: label("Cancel") },
		});
		const button = getByRole("button");

		expect(button.textContent).toContain("Cancel");
		expect(button.getAttribute("type")).toBe("button");
		expect(button.className).toContain("border-border");
	});

	it("applies the variant and size class maps", () => {
		const { getByRole } = render(Button, {
			props: { variant: "primary", size: "sm", children: label("Go") },
		});
		const button = getByRole("button");

		expect(button.className).toContain("bg-accent");
		expect(button.className).toContain("h-8");
	});

	it("merges the consumer class additively while keeping the base classes", () => {
		const { getByRole } = render(Button, {
			props: { class: "w-full", children: label("Wide") },
		});
		const button = getByRole("button");

		// `class` is for additive utilities — assert presence, not cascade order
		// (attribute order does not decide the cascade; see conventions doc).
		expect(button.classList.contains("w-full")).toBe(true);
		expect(button.classList.contains("border-border")).toBe(true);
	});

	it("forwards rest attributes and omits busy state when idle", () => {
		const { getByRole } = render(Button, {
			props: {
				title: "Save now",
				"data-testid": "save-btn",
				children: label("Save"),
			},
		});
		const button = getByRole("button");

		expect(button.getAttribute("title")).toBe("Save now");
		expect(button.getAttribute("data-testid")).toBe("save-btn");
		expect(button.hasAttribute("aria-busy")).toBe(false);
		expect(button.hasAttribute("aria-disabled")).toBe(false);
	});

	it("fires onclick when enabled", async () => {
		const onclick = vi.fn();
		const { getByRole } = render(Button, {
			props: { onclick, children: label("Tap") },
		});

		await fireEvent.click(getByRole("button"));

		expect(onclick).toHaveBeenCalledOnce();
	});

	it("stays focusable and busy while loading, swallowing clicks", async () => {
		const onclick = vi.fn();
		const { getByRole } = render(Button, {
			props: { loading: true, onclick, children: label("Saving") },
		});
		const button = getByRole("button");

		// Not natively disabled — keyboard/SR focus is preserved mid-action.
		expect(button.hasAttribute("disabled")).toBe(false);
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.querySelector("svg.animate-spin")).not.toBeNull();

		await fireEvent.click(button);
		expect(onclick).not.toHaveBeenCalled();
	});

	it("reflects the disabled prop", () => {
		const { getByRole } = render(Button, {
			props: { disabled: true, children: label("Nope") },
		});

		expect(getByRole("button").hasAttribute("disabled")).toBe(true);
	});

	it("renders icon-only buttons as an accessible square with no text", () => {
		const { getByRole } = render(Button, {
			props: { iconOnly: true, icon: "settings", ariaLabel: "Settings" },
		});
		const button = getByRole("button");

		expect(button.getAttribute("aria-label")).toBe("Settings");
		expect(button.className).toContain("w-9");
		expect(button.querySelector("svg")).not.toBeNull();
		expect(button.textContent?.trim()).toBe("");
	});

	it("warns in dev when an icon-only button lacks an aria-label", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// The discriminated union enforces ariaLabel on `iconOnly` at real (template)
		// call sites; this render() path deliberately exercises the runtime backstop
		// for JS/spread callers that bypass the type.
		render(Button, { props: { iconOnly: true, icon: "settings" } });

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("iconOnly"));
		warn.mockRestore();
	});
});

/**
 * The one rule the whole `tone` / `hoverFill` design exists to keep.
 *
 * Two utilities from the same Tailwind group in one class list do not resolve
 * by class order; they resolve by which one Tailwind emitted LATER in the
 * built stylesheet, which is not alphabetical across groups and is invisible
 * from the call site. A primitive that emits two `text-*` colours has not made
 * a choice, it has made a coin flip -- and the only honest fix is to emit
 * exactly one. These tests assert that property across the FULL cross product
 * rather than for the handful of pairings the app happens to use today, so a
 * new variant or a new tone cannot quietly reintroduce the collision.
 */
describe("Button colour axes", () => {
	afterEach(cleanup);

	const emitted = (props: Record<string, unknown>) => {
		const { getByRole } = render(Button, {
			props: { children: label("x"), ...props },
		});
		return getByRole("button").className.split(/\s+/).filter(Boolean);
	};

	// Unprefixed only. `data-[active]:text-accent` and `hover:text-*` are
	// variant-prefixed, so they never compete with the resting colour.
	const restingText = (classes: string[]) =>
		classes.filter((c) =>
			/^text-(?!xs$|sm$|base$|lg$|left$|center$|right$)/.test(c),
		);
	const hoverFill = (classes: string[]) =>
		classes.filter((c) => c.startsWith("hover:bg-"));
	// Both prefixes, because Button sets `aria-disabled` for `loading` and for
	// the explain-why case, where a real `disabled` would kill the hover that
	// carries the explanation.
	const offState = (classes: string[], prop: "opacity" | "cursor") =>
		classes.filter((c) =>
			new RegExp(`^(disabled|aria-disabled):${prop}-`).test(c),
		);

	for (const variant of BUTTON_VARIANTS) {
		it(`variant ${variant} emits one resting text colour and at most one hover fill`, () => {
			const classes = emitted({ variant, size: "content" });
			expect(restingText(classes)).toHaveLength(1);
			expect(hoverFill(classes).length).toBeLessThanOrEqual(1);
		});
	}

	it("replaces the variant's tone rather than adding to it", () => {
		const classes = emitted({ variant: "secondary", tone: "muted" });

		expect(restingText(classes)).toEqual(["text-text-muted"]);
		expect(classes).toContain("hover:text-text");
		// `secondary`'s own `text-text` is gone, not merely outranked.
		expect(classes).not.toContain("text-text");
		// Non-colour parts of the variant survive.
		expect(classes).toContain("border-border");
	});

	it("replaces the variant's hover fill rather than adding to it", () => {
		const classes = emitted({ variant: "ghost", hoverFill: "sidebar" });

		expect(hoverFill(classes)).toEqual(["hover:bg-sidebar-hover"]);
		expect(restingText(classes)).toEqual(["text-text-secondary"]);
	});

	it('hoverFill="none" removes the wash entirely', () => {
		expect(
			hoverFill(emitted({ variant: "secondary", hoverFill: "none" })),
		).toEqual([]);
	});

	it('tone="inherit" emits no resting colour, leaving it to the call site', () => {
		const classes = emitted({ variant: "ghost", tone: "inherit" });

		expect(restingText(classes)).toEqual([]);
		expect(hoverFill(classes)).toEqual(["hover:bg-text/5"]);
	});

	it("defaults the off state to the pair that used to live in BASE_CLASSES", () => {
		const classes = emitted({ variant: "ghost" });

		expect(offState(classes, "opacity")).toEqual([
			"disabled:opacity-50",
			"aria-disabled:opacity-50",
		]);
		expect(offState(classes, "cursor")).toEqual([
			"disabled:cursor-not-allowed",
			"aria-disabled:cursor-not-allowed",
		]);
	});

	it("replaces the off state rather than adding to it", () => {
		const classes = emitted({ variant: "ghost", disabledStyle: "faint" });

		expect(offState(classes, "opacity")).toEqual([
			"disabled:opacity-30",
			"aria-disabled:opacity-30",
		]);
		// The old BASE pair is gone, not merely outranked.
		expect(classes).not.toContain("disabled:opacity-50");
		expect(classes).not.toContain("disabled:cursor-not-allowed");
	});

	it('disabledStyle="undimmed" refuses to dim but still changes the cursor', () => {
		const classes = emitted({
			variant: "ghost",
			disabledStyle: "undimmed",
		});

		expect(offState(classes, "opacity")).toEqual([
			"disabled:opacity-100",
			"aria-disabled:opacity-100",
		]);
		expect(offState(classes, "cursor")).toEqual([
			"disabled:cursor-default",
			"aria-disabled:cursor-default",
		]);
	});

	it("holds across every variant x tone x hoverFill x disabledStyle combination", () => {
		for (const variant of BUTTON_VARIANTS) {
			for (const tone of BUTTON_TONES) {
				for (const fill of BUTTON_HOVER_FILLS) {
					for (const off of BUTTON_DISABLED_STYLES) {
						const classes = emitted({
							variant,
							tone,
							hoverFill: fill,
							disabledStyle: off,
							size: "content",
						});
						const where = `${variant}/${tone}/${fill}/${off}`;

						expect(restingText(classes).length, where).toBeLessThanOrEqual(1);
						expect(hoverFill(classes).length, where).toBeLessThanOrEqual(1);
						// One per prefix, never two competing opacities.
						expect(offState(classes, "opacity"), where).toHaveLength(2);
						expect(offState(classes, "cursor"), where).toHaveLength(2);
						cleanup();
					}
				}
			}
		}
	});

	// conduit-test-or29: `:hover` keeps matching a disabled button, so a dead
	// control used to light up under the cursor. The drop now has to survive
	// the recipe being assembled from three slots instead of one string.
	it("drops the hover step when inert, whichever slot supplied it", () => {
		const classes = emitted({
			variant: "toolbar",
			tone: "muted",
			hoverFill: "alt",
			disabled: true,
		});

		expect(classes.filter((c) => c.startsWith("hover:"))).toEqual([]);
		expect(classes).toContain("text-text-muted");
	});
});
