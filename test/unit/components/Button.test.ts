import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Button from "../../../src/lib/frontend/components/ui/Button.svelte";

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
