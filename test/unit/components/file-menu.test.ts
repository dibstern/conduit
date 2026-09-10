import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileMenu from "../../../src/lib/frontend/components/input/FileMenu.svelte";

const listboxId = "file-menu-test-listbox";

describe("FileMenu", () => {
	beforeEach(() => {
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		});
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("renders a named inline listbox with stable option ids", () => {
		const { getByRole, getAllByRole } = render(FileMenu, {
			listboxId,
			query: "",
			visible: true,
			entries: ["README.md", "src/index.ts"],
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		const listbox = getByRole("listbox", { name: "File suggestions" });
		expect(listbox.id).toBe(listboxId);
		expect(listbox.hasAttribute("tabindex")).toBe(false);
		expect(listbox.hasAttribute("aria-activedescendant")).toBe(false);
		expect(listbox.classList.contains("file-menu-list")).toBe(true);

		const options = getAllByRole("option");
		expect(options.map((option) => option.id)).toEqual([
			`${listboxId}-option-0`,
			`${listboxId}-option-1`,
		]);
		expect(options[0]?.getAttribute("aria-selected")).toBe("true");
		for (const option of options) {
			expect(listbox.contains(option)).toBe(true);
			expect(option.tabIndex).toBe(-1);
			expect(option).not.toBe(document.activeElement);
		}
	});

	it("closes and consumes Escape while visible", () => {
		const onClose = vi.fn();
		const { component } = render(FileMenu, {
			listboxId,
			query: "",
			visible: true,
			entries: ["README.md"],
			onSelect: vi.fn(),
			onClose,
		});
		const escapeEvent = new KeyboardEvent("keydown", {
			key: "Escape",
			cancelable: true,
		});

		expect(component["handleKeydown"](escapeEvent)).toBe(true);
		expect(escapeEvent.defaultPrevented).toBe(true);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("keeps Tab as commit and scrolls the active inline option", async () => {
		const onSelect = vi.fn();
		const { component, getAllByRole, getByRole } = render(FileMenu, {
			listboxId,
			query: "",
			visible: true,
			entries: ["README.md", "src/index.ts"],
			onSelect,
			onClose: vi.fn(),
		});

		const arrowDown = new KeyboardEvent("keydown", {
			key: "ArrowDown",
			cancelable: true,
		});
		expect(component["handleKeydown"](arrowDown)).toBe(true);
		await tick();

		const options = getAllByRole("option");
		expect(options[1]?.getAttribute("aria-selected")).toBe("true");
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
			block: "nearest",
		});
		expect(getByRole("listbox").contains(options[1] as HTMLElement)).toBe(true);

		const tab = new KeyboardEvent("keydown", {
			key: "Tab",
			cancelable: true,
		});
		expect(component["handleKeydown"](tab)).toBe(true);
		expect(tab.defaultPrevented).toBe(true);
		expect(onSelect).toHaveBeenCalledWith("src/index.ts");
	});

	it("exposes loading as a busy named listbox without an active option", () => {
		const { getByRole, queryByRole } = render(FileMenu, {
			listboxId,
			query: "",
			visible: true,
			entries: [],
			onSelect: vi.fn(),
			onClose: vi.fn(),
			loading: true,
		});

		expect(
			getByRole("listbox", { name: "File suggestions" }).getAttribute(
				"aria-busy",
			),
		).toBe("true");
		expect(queryByRole("option")).toBeNull();
	});
});
