import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import DetachedListbox from "../../../src/lib/frontend/components/ui/DetachedListbox.svelte";
import { FLOATING_SURFACE_CLASSES } from "../../../src/lib/frontend/components/ui/floating-styles.js";

const option = (text: string, id: string) =>
	createRawSnippet(() => ({
		render: () =>
			`<div id="${id}" role="option" aria-selected="true">${text}</div>`,
	}));

describe("DetachedListbox", () => {
	afterEach(cleanup);

	it("renders a named listbox at the required id", () => {
		const { getByRole } = render(DetachedListbox, {
			props: {
				id: "file-suggestions",
				ariaLabel: "File suggestions",
				children: option("src/lib/", "file-suggestions-option-0"),
			},
		});
		const listbox = getByRole("listbox", { name: "File suggestions" });

		expect(listbox.tagName).toBe("DIV");
		expect(listbox.id).toBe("file-suggestions");
	});

	it("is not focusable, because the combobox input keeps DOM focus", () => {
		const { getByRole } = render(DetachedListbox, {
			props: {
				id: "cmd-suggestions",
				ariaLabel: "Command suggestions",
				children: option("/compact", "cmd-suggestions-option-0"),
			},
		});
		const listbox = getByRole("listbox", { name: "Command suggestions" });

		expect(listbox.hasAttribute("tabindex")).toBe(false);
	});

	it("applies the canonical floating surface on the top side", () => {
		const { getByRole } = render(DetachedListbox, {
			props: {
				id: "dir-suggestions",
				ariaLabel: "Directory suggestions",
				children: option("src/", "dir-suggestions-option-0"),
			},
		});
		const listbox = getByRole("listbox", { name: "Directory suggestions" });

		for (const canonicalClass of FLOATING_SURFACE_CLASSES.split(/\s+/)) {
			expect(listbox.classList.contains(canonicalClass)).toBe(true);
		}
		expect(listbox.getAttribute("data-side")).toBe("top");
	});

	it("appends the consumer class after the canonical classes", () => {
		const { getByRole } = render(DetachedListbox, {
			props: {
				id: "dir-suggestions",
				ariaLabel: "Directory suggestions",
				class: "dir-autocomplete-list absolute bottom-full",
				children: option("src/", "dir-suggestions-option-0"),
			},
		});
		const listbox = getByRole("listbox", { name: "Directory suggestions" });

		expect(
			listbox.getAttribute("class")?.startsWith(`${FLOATING_SURFACE_CLASSES} `),
		).toBe(true);
		expect(listbox.classList.contains("dir-autocomplete-list")).toBe(true);
		expect(listbox.classList.contains("absolute")).toBe(true);
	});

	it("forwards unmanaged native attributes to the listbox root", () => {
		const { getByTestId } = render(DetachedListbox, {
			props: {
				id: "file-suggestions",
				ariaLabel: "File suggestions",
				"aria-busy": true,
				"data-testid": "file-listbox",
				children: option("Loading files…", "file-suggestions-option-0"),
			},
		});
		const listbox = getByTestId("file-listbox");

		expect(listbox.getAttribute("aria-busy")).toBe("true");
		expect(listbox.getAttribute("role")).toBe("listbox");
	});

	it("renders options inline, as descendants rather than through a portal", () => {
		const { container, getByRole } = render(DetachedListbox, {
			props: {
				id: "file-suggestions",
				ariaLabel: "File suggestions",
				children: option("src/lib/", "file-suggestions-option-0"),
			},
		});
		const listbox = getByRole("listbox", { name: "File suggestions" });
		const renderedOption = getByRole("option");

		expect(container.contains(listbox)).toBe(true);
		expect(listbox.contains(renderedOption)).toBe(true);
	});
});
