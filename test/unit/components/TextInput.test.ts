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

	// The whole point of `chrome`/`size="content"` is that a consumer class is
	// never contested: two utilities from the same Tailwind group are resolved
	// by STYLESHEET order, not by class order, so a call site can never win an
	// argument the primitive started. These assert emission, not precedence.
	const tokens = (el: Element) =>
		(el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

	it("emits exactly one utility per contested group when bordered", () => {
		const { getByRole } = render(TextInput);
		const emitted = tokens(getByRole("textbox"));

		expect(emitted.filter((t) => t.startsWith("rounded-"))).toHaveLength(1);
		expect(emitted.filter((t) => /^bg-/.test(t))).toHaveLength(1);
		expect(emitted.filter((t) => /^min-h-/.test(t))).toHaveLength(1);
		expect(emitted.filter((t) => /^px-/.test(t))).toHaveLength(1);
	});

	it("hands the real input node to a parent through bind:element", async () => {
		const { getByRole, getByTestId } = render(BoundTextInput);

		expect(getByTestId("element-tag").textContent).toBe("INPUT");

		await fireEvent.click(getByTestId("focus-it"));
		expect(document.activeElement).toBe(getByRole("textbox"));
	});
});
