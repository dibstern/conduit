import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import TabsSnippetHost from "../../../src/lib/frontend/components/ui/__fixtures__/TabsSnippetHost.svelte";

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
