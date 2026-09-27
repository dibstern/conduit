import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import ControlledRadioGroup from "../../../src/lib/frontend/components/ui/__fixtures__/ControlledRadioGroup.svelte";
import Radio from "../../../src/lib/frontend/components/ui/Radio.svelte";

describe("Radio", () => {
	afterEach(cleanup);

	it("renders a radio input", () => {
		const { getByRole } = render(Radio);

		expect(getByRole("radio")).toBeInstanceOf(HTMLInputElement);
	});

	// The contract the component's doc comment promises, and the one thing a
	// `bind:group`-shaped API would have silently broken across a component
	// boundary: selecting a member deselects its siblings.
	it("selects exactly one member of a controlled group", async () => {
		const { getByLabelText, getByTestId } = render(ControlledRadioGroup);
		const a = getByLabelText("a") as HTMLInputElement;
		const b = getByLabelText("b") as HTMLInputElement;

		expect(a.checked).toBe(true);

		await fireEvent.click(b);

		expect(getByTestId("mirror").textContent).toBe("b");
		expect(b.checked).toBe(true);
		expect(a.checked).toBe(false);
	});

	// ARIA does not support aria-invalid on role="radio"; validity belongs to the
	// group, so the primitive must not offer a per-option invalid state.
	it("never emits aria-invalid", () => {
		const { getByRole } = render(Radio, { props: { required: true } });

		expect(getByRole("radio").hasAttribute("aria-invalid")).toBe(false);
	});
});
