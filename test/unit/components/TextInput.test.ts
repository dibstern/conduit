import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import BoundTextInput from "../../../src/lib/frontend/components/ui/__fixtures__/BoundTextInput.svelte";
import TextInput from "../../../src/lib/frontend/components/ui/TextInput.svelte";

describe("TextInput", () => {
	afterEach(cleanup);

	it("renders a textbox", () => {
		const { getByRole } = render(TextInput);

		expect(getByRole("textbox")).toBeInstanceOf(HTMLInputElement);
	});

	it("reflects a seeded value", () => {
		const { getByRole } = render(TextInput, { props: { value: "seed" } });

		expect((getByRole("textbox") as HTMLInputElement).value).toBe("seed");
	});

	it("propagates typed input to the bound parent value", async () => {
		const { getByRole, getByTestId } = render(BoundTextInput);

		await fireEvent.input(getByRole("textbox"), {
			target: { value: "updated" },
		});

		// The mirror reflects the parent's bound state, proving bind:value flows out.
		expect(getByTestId("mirror").textContent).toBe("updated");
	});

	it("applies the small size class", () => {
		const { getByRole } = render(TextInput, { props: { size: "sm" } });

		expect(getByRole("textbox").className).toContain("h-8");
	});

	it("emits aria-invalid only when invalid", () => {
		const invalidRender = render(TextInput, { props: { invalid: true } });
		expect(
			invalidRender.getByRole("textbox").getAttribute("aria-invalid"),
		).toBe("true");
		invalidRender.unmount();

		const idleRender = render(TextInput);
		expect(idleRender.getByRole("textbox").hasAttribute("aria-invalid")).toBe(
			false,
		);
	});

	it("reflects disabled and forwards rest attributes", () => {
		const { getByRole } = render(TextInput, {
			props: {
				disabled: true,
				placeholder: "Project name",
				"data-testid": "project-name",
			},
		});
		const input = getByRole("textbox");

		expect(input.hasAttribute("disabled")).toBe(true);
		expect(input.getAttribute("placeholder")).toBe("Project name");
		expect(input.getAttribute("data-testid")).toBe("project-name");
	});
});
