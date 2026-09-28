import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import ToggleGroupSnippetHost from "../../../src/lib/frontend/components/ui/__fixtures__/ToggleGroupSnippetHost.svelte";

describe("ToggleGroup", () => {
	afterEach(cleanup);

	it("names a multiple selection group, renders content, and delegates toggles", async () => {
		const { getByRole, getByTestId } = render(ToggleGroupSnippetHost);
		const group = getByRole("group", { name: "Session views" });
		expect(group).toBeTruthy();
		const chat = getByRole("button", { name: "Chat" });
		const terminal = getByRole("button", { name: "Terminal" });
		expect(chat.getAttribute("aria-pressed")).toBe("true");
		expect(terminal.getAttribute("aria-pressed")).toBe("false");
		expect(getByTestId("content-terminal").textContent).toContain("⌘J");
		expect(getByRole("button", { name: "Diff" }).hasAttribute("disabled")).toBe(
			true,
		);
		await fireEvent.click(terminal);
		expect(terminal.getAttribute("aria-pressed")).toBe("true");
		expect(chat.getAttribute("aria-pressed")).toBe("true");
		await fireEvent.click(terminal);
		expect(terminal.getAttribute("aria-pressed")).toBe("false");
	});
});
