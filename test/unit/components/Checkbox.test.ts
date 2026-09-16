import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import BoundCheckbox from "../../../src/lib/frontend/components/ui/__fixtures__/BoundCheckbox.svelte";
import Checkbox from "../../../src/lib/frontend/components/ui/Checkbox.svelte";

describe("Checkbox", () => {
	afterEach(cleanup);

	it("renders a checkbox input", () => {
		const { getByRole } = render(Checkbox);

		expect(getByRole("checkbox")).toBeInstanceOf(HTMLInputElement);
	});

	it("propagates a click to the bound parent value", async () => {
		const { getByRole, getByTestId } = render(BoundCheckbox);

		await fireEvent.click(getByRole("checkbox"));

		// The mirror reflects the parent's bound state, proving bind:checked flows out.
		expect(getByTestId("mirror").textContent).toBe("true");
	});

	it("emits aria-invalid only when invalid", () => {
		const invalidRender = render(Checkbox, { props: { invalid: true } });
		expect(
			invalidRender.getByRole("checkbox").getAttribute("aria-invalid"),
		).toBe("true");
		invalidRender.unmount();

		const idleRender = render(Checkbox);
		expect(idleRender.getByRole("checkbox").hasAttribute("aria-invalid")).toBe(
			false,
		);
	});

	it("carries the invalid affordance as an outline, since a UA-painted box ignores border", () => {
		const { getByRole } = render(Checkbox);

		expect(getByRole("checkbox").className).toContain(
			"aria-invalid:outline-error",
		);
	});
});
