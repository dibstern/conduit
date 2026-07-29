import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
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
		["inset", ["bg-code-bg", "border", "border-border-subtle"], []],
		["floating", ["bg-bg-alt", "border", "border-border"], []],
		["plain", ["bg-bg-surface"], ["border"]],
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
		["menu", "shadow-menu"],
		["panel", "shadow-panel"],
		["modal", "shadow-modal"],
	] as const)("applies the %s elevation", (elevation, expectedClass) => {
		const { getByTestId } = render(Surface, {
			props: {
				elevation,
				"data-testid": "surface",
				children: content(elevation),
			},
		});
		const surface = getByTestId("surface");

		if (expectedClass) {
			expect(surface.classList.contains(expectedClass)).toBe(true);
		} else {
			expect(
				["shadow-menu", "shadow-panel", "shadow-modal"].some((className) =>
					surface.classList.contains(className),
				),
			).toBe(false);
		}
	});
});
