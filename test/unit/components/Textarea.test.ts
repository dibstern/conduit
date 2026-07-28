import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import Textarea from "../../../src/lib/frontend/components/ui/Textarea.svelte";

describe("Textarea", () => {
	afterEach(cleanup);

	it("renders a textarea textbox", () => {
		const { getByRole } = render(Textarea);

		expect(getByRole("textbox")).toBeInstanceOf(HTMLTextAreaElement);
	});

	it("reflects a seeded value", () => {
		const { getByRole } = render(Textarea, {
			props: { value: "First line" },
		});

		expect((getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"First line",
		);
	});

	it("forwards rows", () => {
		const { getByRole } = render(Textarea, { props: { rows: 6 } });

		expect(getByRole("textbox").getAttribute("rows")).toBe("6");
	});

	it("emits aria-invalid only when invalid", () => {
		const invalidRender = render(Textarea, { props: { invalid: true } });
		expect(
			invalidRender.getByRole("textbox").getAttribute("aria-invalid"),
		).toBe("true");
		invalidRender.unmount();

		const idleRender = render(Textarea);
		expect(idleRender.getByRole("textbox").hasAttribute("aria-invalid")).toBe(
			false,
		);
	});

	it("applies the small size class", () => {
		const { getByRole } = render(Textarea, { props: { size: "sm" } });

		expect(getByRole("textbox").className).toContain("py-1.5");
	});
});
