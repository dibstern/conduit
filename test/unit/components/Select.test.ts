import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import BoundSelect from "../../../src/lib/frontend/components/ui/__fixtures__/BoundSelect.svelte";
import Select from "../../../src/lib/frontend/components/ui/Select.svelte";

const options = () =>
	createRawSnippet(() => ({
		render: () =>
			'<optgroup label="Options"><option value="a">A</option><option value="b">B</option></optgroup>',
	}));

describe("Select", () => {
	afterEach(cleanup);

	it("renders a combobox with snippet-provided options", () => {
		const { getByRole, getAllByRole } = render(Select, {
			props: { children: options() },
		});

		expect(getByRole("combobox")).toBeInstanceOf(HTMLSelectElement);
		expect(getAllByRole("option")).toHaveLength(2);
	});

	it("selects the native first option when no value is provided", () => {
		const { getByRole } = render(Select, { props: { children: options() } });
		const select = getByRole("combobox") as HTMLSelectElement;

		// Regression: a "" default deselected everything (selectedIndex -1, blank).
		expect(select.selectedIndex).toBe(0);
		expect(select.value).toBe("a");
	});

	it("reflects a seeded value", () => {
		const { getByRole } = render(Select, {
			props: { value: "b", children: options() },
		});

		expect((getByRole("combobox") as HTMLSelectElement).value).toBe("b");
	});

	it("propagates selection to the bound parent value", async () => {
		const { getByRole, getByTestId } = render(BoundSelect);

		await fireEvent.change(getByRole("combobox"), { target: { value: "b" } });

		expect(getByTestId("mirror").textContent).toBe("b");
	});

	it("emits aria-invalid only when invalid", () => {
		const invalidRender = render(Select, {
			props: { invalid: true, children: options() },
		});
		expect(
			invalidRender.getByRole("combobox").getAttribute("aria-invalid"),
		).toBe("true");
		invalidRender.unmount();

		const idleRender = render(Select, { props: { children: options() } });
		expect(idleRender.getByRole("combobox").hasAttribute("aria-invalid")).toBe(
			false,
		);
	});

	it("applies the small size class", () => {
		const { getByRole } = render(Select, {
			props: { size: "sm", children: options() },
		});

		expect(getByRole("combobox").className).toContain("h-8");
	});

	it("reflects disabled", () => {
		const { getByRole } = render(Select, {
			props: { disabled: true, children: options() },
		});

		expect(getByRole("combobox").hasAttribute("disabled")).toBe(true);
	});
});
