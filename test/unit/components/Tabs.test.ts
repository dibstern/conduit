import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import TabsSnippetHost from "../../../src/lib/frontend/components/ui/__fixtures__/TabsSnippetHost.svelte";
import Tabs from "../../../src/lib/frontend/components/ui/Tabs.svelte";

describe("Tabs option content", () => {
	afterEach(cleanup);

	it("receives each option and its current selected state", async () => {
		const { getByRole, getByTestId } = render(TabsSnippetHost);
		expect(getByTestId("content-chat").textContent).toContain("Chat selected");
		expect(getByTestId("content-terminal").textContent).toContain(
			"Terminal idle",
		);
		expect(getByRole("tab", { name: "Diff" }).hasAttribute("disabled")).toBe(
			true,
		);

		await fireEvent.click(getByRole("tab", { name: "Terminal" }));
		expect(getByTestId("content-chat").textContent).toContain("Chat idle");
		expect(getByTestId("content-terminal").textContent).toContain(
			"Terminal selected",
		);
	});
});

/**
 * Vertical orientation (SettingsPanel's left section list). Ways it can fail:
 * - the tablist still announces horizontal (no aria-orientation="vertical");
 * - ArrowDown/ArrowUp do nothing because bits still listens for Left/Right;
 * - Left/Right still move, so the keys mean two things in one list;
 * - focus moves but selection does not follow, so the panel never changes;
 * - Home/End or the wrap at either end break, or land on a disabled section;
 * - more than one tab is a Tab stop.
 */
describe("Tabs vertical orientation", () => {
	afterEach(cleanup);

	const sections = [
		{ value: "alerts", label: "Alerts" },
		{ value: "theme", label: "Theme" },
		{ value: "claude", label: "Claude", disabled: true },
		{ value: "debug", label: "Debug" },
	];

	function renderVertical() {
		const changes: string[] = [];
		const view = render(Tabs, {
			value: "alerts",
			options: sections,
			label: "Settings sections",
			orientation: "vertical",
			onValueChange: (value: string) => changes.push(value),
		});
		const tab = (name: string) => view.getByRole("tab", { name });
		return { ...view, changes, tab };
	}

	const selected = (element: HTMLElement) =>
		element.getAttribute("aria-selected") === "true";

	it("announces a vertical tablist with a single Tab stop", () => {
		const { getByRole, getAllByRole } = renderVertical();
		expect(
			getByRole("tablist", { name: "Settings sections" }).getAttribute(
				"aria-orientation",
			),
		).toBe("vertical");
		expect(getAllByRole("tab").filter((t) => t.tabIndex === 0)).toHaveLength(1);
	});

	it("moves focus and selection with ArrowDown and ArrowUp, skipping disabled", async () => {
		const { tab, changes } = renderVertical();
		tab("Alerts").focus();
		await fireEvent.keyDown(tab("Alerts"), { key: "ArrowDown" });
		expect(document.activeElement).toBe(tab("Theme"));
		expect(selected(tab("Theme"))).toBe(true);
		await fireEvent.keyDown(tab("Theme"), { key: "ArrowDown" });
		expect(document.activeElement).toBe(tab("Debug"));
		await fireEvent.keyDown(tab("Debug"), { key: "ArrowUp" });
		expect(document.activeElement).toBe(tab("Theme"));
		expect(changes).toEqual(["theme", "debug", "theme"]);
	});

	it("ignores ArrowLeft and ArrowRight", async () => {
		const { tab, changes } = renderVertical();
		tab("Alerts").focus();
		await fireEvent.keyDown(tab("Alerts"), { key: "ArrowRight" });
		await fireEvent.keyDown(tab("Alerts"), { key: "ArrowLeft" });
		expect(document.activeElement).toBe(tab("Alerts"));
		expect(changes).toEqual([]);
	});

	it("jumps with Home and End and wraps at both ends", async () => {
		const { tab } = renderVertical();
		tab("Alerts").focus();
		await fireEvent.keyDown(tab("Alerts"), { key: "End" });
		expect(document.activeElement).toBe(tab("Debug"));
		await fireEvent.keyDown(tab("Debug"), { key: "ArrowDown" });
		expect(document.activeElement).toBe(tab("Alerts"));
		await fireEvent.keyDown(tab("Alerts"), { key: "ArrowUp" });
		expect(document.activeElement).toBe(tab("Debug"));
		await fireEvent.keyDown(tab("Debug"), { key: "Home" });
		expect(document.activeElement).toBe(tab("Alerts"));
		expect(selected(tab("Alerts"))).toBe(true);
	});
});
