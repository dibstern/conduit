import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import BoundTextarea from "../../../src/lib/frontend/components/ui/__fixtures__/BoundTextarea.svelte";
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

	// Assert EMISSION, not precedence. Two utilities from one Tailwind group are
	// resolved by stylesheet order, so "the consumer class is in the string"
	// proves nothing; what matters is that the primitive emits nothing to argue
	// with.
	const tokens = (el: Element) =>
		(el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

	it("emits no chrome, colour or sizing utility when bare and content-sized", () => {
		const { getByRole } = render(Textarea, {
			props: { chrome: "bare", size: "content" },
		});

		const contested = tokens(getByRole("textbox")).filter((t) =>
			/^(bg-|border|rounded-|placeholder:|text-|transition|p[xy]?-|w-)/.test(t),
		);
		// `text-` is in the list deliberately: the composer swaps between
		// text-transparent and text-text on IME composition, so a primitive
		// text colour would contest it (conduit-test-1k0g).
		expect(contested).toEqual([]);
	});

	it("keeps outline-none when bare, because preflight does not", () => {
		const { getByRole } = render(Textarea, { props: { chrome: "bare" } });

		expect(tokens(getByRole("textbox"))).toContain("outline-none");
	});

	it("emits exactly one utility per contested group when bordered", () => {
		const emitted = tokens(render(Textarea).getByRole("textbox"));

		expect(emitted.filter((t) => t.startsWith("rounded-"))).toHaveLength(1);
		expect(emitted.filter((t) => /^bg-/.test(t))).toHaveLength(1);
		expect(emitted.filter((t) => /^px-/.test(t))).toHaveLength(1);
		expect(emitted.filter((t) => /^text-(?!transparent)/.test(t))).toEqual([
			"text-text",
			"text-sm",
		]);
	});

	it("hands the real textarea node to a parent through bind:element", async () => {
		const { getByRole, getByTestId } = render(BoundTextarea);

		expect(getByTestId("element-tag").textContent).toBe("TEXTAREA");

		await fireEvent.click(getByTestId("focus-it"));
		expect(document.activeElement).toBe(getByRole("textbox"));
	});
});
