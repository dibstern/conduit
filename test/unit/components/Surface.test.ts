import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Surface from "../../../src/lib/frontend/components/ui/Surface.svelte";

const content = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe("Surface", () => {
	afterEach(cleanup);

	it("renders a div and forwards native attributes to its root", () => {
		const { getByTestId } = render(Surface, {
			props: {
				"data-testid": "settings-panel",
				title: "Settings",
				children: content("General"),
			},
		});
		const surface = getByTestId("settings-panel");

		expect(surface.tagName).toBe("DIV");
		expect(surface.getAttribute("title")).toBe("Settings");
		expect(surface.textContent).toContain("General");
	});

	it("appends the consumer class without replacing variant classes", () => {
		const { getByTestId } = render(Surface, {
			props: {
				variant: "inset",
				class: "consumer-surface",
				"data-testid": "surface",
				children: content("Result"),
			},
		});
		const surface = getByTestId("surface");

		expect(surface.classList.contains("consumer-surface")).toBe(true);
		expect(surface.classList.contains("bg-code-bg")).toBe(true);
	});

	it.each([
		["card", ["bg-bg-surface", "border", "border-border"], []],
		["quiet", ["bg-bg-surface", "border", "border-border-subtle"], []],
		["plain", ["bg-bg-surface"], ["border"]],
		["bare", [], ["border", "bg-bg-surface", "bg-bg-alt", "bg-code-bg"]],
		["raised", ["bg-bg-alt", "border", "border-border"], []],
		["inset", ["bg-code-bg", "border", "border-border-subtle"], []],
	] as const)("applies the %s variant", (variant, expectedClasses, absentClasses) => {
		const { getByTestId } = render(Surface, {
			props: {
				variant,
				"data-testid": "surface",
				children: content(variant),
			},
		});
		const surface = getByTestId("surface");

		for (const expectedClass of expectedClasses) {
			expect(surface.classList.contains(expectedClass)).toBe(true);
		}
		for (const absentClass of absentClasses) {
			expect(surface.classList.contains(absentClass)).toBe(false);
		}
	});

	it.each([
		["none", undefined],
		["sm", "px-3"],
		["md", "px-4"],
		["lg", "px-5"],
	] as const)("applies the %s padding", (padding, expectedClass) => {
		const { getByTestId } = render(Surface, {
			props: {
				padding,
				"data-testid": "surface",
				children: content(padding),
			},
		});
		const surface = getByTestId("surface");

		if (expectedClass) {
			expect(surface.classList.contains(expectedClass)).toBe(true);
		} else {
			expect(
				["px-3", "px-4", "px-5"].some((className) =>
					surface.classList.contains(className),
				),
			).toBe(false);
		}
	});

	it.each([
		["none", undefined],
		["sm", "rounded"],
		["md", "rounded-lg"],
		["lg", "rounded-xl"],
		["panel", "rounded-panel"],
	] as const)("applies the %s radius", (radius, expectedClass) => {
		const { getByTestId } = render(Surface, {
			props: {
				radius,
				"data-testid": "surface",
				children: content(radius),
			},
		});
		const surface = getByTestId("surface");
		const emitted = [...surface.classList].filter((className) =>
			className.startsWith("rounded"),
		);

		expect(emitted).toEqual(expectedClass ? [expectedClass] : []);
	});

	it.each([
		["none", undefined],
		["menu", "shadow-menu"],
		["menu-lg", "shadow-menu-lg"],
		["panel", "shadow-panel"],
		["modal", "shadow-modal"],
		["dropdown", "shadow-dropdown"],
	] as const)("applies the %s elevation", (elevation, expectedClass) => {
		const { getByTestId } = render(Surface, {
			props: {
				elevation,
				"data-testid": "surface",
				children: content(elevation),
			},
		});
		const surface = getByTestId("surface");
		const emitted = [...surface.classList].filter((className) =>
			className.startsWith("shadow"),
		);

		expect(emitted).toEqual(expectedClass ? [expectedClass] : []);
	});

	// The defaults are the zero-diff contract the four migration batches rely
	// on: a Surface that is handed nothing but a class must not quietly add
	// padding or a shadow that the site it replaced never had.
	it("emits no padding and no shadow by default", () => {
		const { getByTestId } = render(Surface, {
			props: { "data-testid": "surface", children: content("Default") },
		});
		const classes = [...getByTestId("surface").classList];

		expect(classes.filter((c) => /^p[xytrbl]?-/.test(c))).toEqual([]);
		expect(classes.filter((c) => c.startsWith("shadow"))).toEqual([]);
		expect(classes).toContain("rounded-panel");
	});

	describe("collision guard", () => {
		it.each([
			["radius", { radius: "panel" }, "rounded-lg"],
			["shadow", { elevation: "panel" }, "shadow-2xl"],
			["padding", { padding: "md" }, "px-6"],
			["background", { variant: "card" }, "bg-bg-alt"],
		] as const)("warns when a consumer class fights the %s Surface emits", (_label, props, className) => {
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);

			render(Surface, {
				props: { ...props, class: className, children: content("x") },
			});

			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(`class="${className}"`),
			);
			warn.mockRestore();
		});

		it.each([
			["the prop is none", { radius: "none" }, "rounded-lg"],
			[
				"the utility is variant-prefixed",
				{ radius: "panel" },
				"max-md:rounded-lg",
			],
			[
				"the utility is an explicit override",
				{ radius: "panel" },
				"rounded-lg!",
			],
			["the group is untouched", { elevation: "none" }, "shadow-2xl"],
		] as const)("stays quiet when %s", (_why, props, className) => {
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);

			render(Surface, {
				props: { ...props, class: className, children: content("x") },
			});

			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});
	});
});
