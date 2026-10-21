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
			["background", { variant: "card" }, "bg-code-bg"],
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
