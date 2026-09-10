import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandMenu from "../../../src/lib/frontend/components/input/CommandMenu.svelte";

const listboxId = "command-menu-test-listbox";
const commands = [
	{ name: "review", description: "Review a pull request" },
	{ name: "compact", description: "Compact conversation history" },
	{ name: "config", description: "View configuration" },
];

describe("CommandMenu", () => {
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

	it("renders sorted filtered options in a named inline listbox", () => {
		const { getByRole, getAllByRole } = render(CommandMenu, {
			listboxId,
			query: "co",
			visible: true,
			commands,
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		const listbox = getByRole("listbox", { name: "Slash commands" });
		expect(listbox.id).toBe(listboxId);
		expect(listbox.hasAttribute("tabindex")).toBe(false);
		expect(listbox.hasAttribute("aria-activedescendant")).toBe(false);
		expect(listbox.classList.contains("cmd-menu")).toBe(true);

		const options = getAllByRole("option");
		expect(
			options.map((option) =>
				option.querySelector(".cmd-name")?.textContent?.trim(),
			),
		).toEqual(["/compact", "/config"]);
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

	it("keeps Tab as commit and scrolls the active inline option", async () => {
		const onSelect = vi.fn();
		const { component, getAllByRole, getByRole } = render(CommandMenu, {
			listboxId,
			query: "",
			visible: true,
			commands,
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
		expect(onSelect).toHaveBeenCalledWith("/config ");
	});

	it("closes and consumes Escape while visible", () => {
		const onClose = vi.fn();
		const { component } = render(CommandMenu, {
			listboxId,
			query: "",
			visible: true,
			commands,
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
});
