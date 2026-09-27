import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import FieldWithInput from "../../../src/lib/frontend/components/ui/__fixtures__/FieldWithInput.svelte";

describe("Field", () => {
	afterEach(cleanup);

	it("wires its label to the child input", () => {
		const { getByRole, getByText } = render(FieldWithInput);
		const input = getByRole("textbox");
		const label = getByText("Email");

		expect(label).toBeInstanceOf(HTMLLabelElement);
		expect(label.getAttribute("for")).toBe(input.id);
	});

	it("describes the input with its hint while remaining valid", () => {
		const { getByRole, getByText } = render(FieldWithInput, {
			props: { hint: "Used for account notifications" },
		});
		const input = getByRole("textbox");
		const hint = getByText("Used for account notifications");

		expect(hint.id).not.toBe("");
		expect(input.getAttribute("aria-describedby")).toBe(hint.id);
		expect(input.hasAttribute("aria-invalid")).toBe(false);
	});

	it("marks and describes the input with an alert when errored", () => {
		const { getByRole } = render(FieldWithInput, {
			props: { error: "Enter a valid email" },
		});
		const input = getByRole("textbox");
		const error = getByRole("alert");

		expect(error.textContent).toBe("Enter a valid email");
		expect(error.id).not.toBe("");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);
	});

	it("prefers the error description when hint and error are both present", () => {
		const { getByRole, queryByText } = render(FieldWithInput, {
			props: {
				hint: "Used for account notifications",
				error: "Enter a valid email",
			},
		});
		const input = getByRole("textbox");
		const error = getByRole("alert");

		expect(queryByText("Used for account notifications")).toBeNull();
		expect(input.getAttribute("aria-describedby")).toBe(error.id);
	});

	it("reactively rewires the child when error toggles on a mounted field", async () => {
		const { getByRole, queryByRole, rerender } = render(FieldWithInput, {
			props: { label: "Email", hint: "Used for account notifications" },
		});
		const input = getByRole("textbox");

		expect(input.hasAttribute("aria-invalid")).toBe(false);

		// Toggle error ON — the getter-based context must propagate live.
		await rerender({ label: "Email", error: "Enter a valid email" });
		const error = getByRole("alert");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);

		// Toggle error OFF (rerender merges props, so clear it explicitly) —
		// invalid clears and the alert unmounts, live.
		await rerender({
			label: "Email",
			hint: "Used for account notifications",
			error: undefined,
		});
		expect(input.hasAttribute("aria-invalid")).toBe(false);
		expect(queryByRole("alert")).toBeNull();
	});

	it("marks the label and child input as required", () => {
		const { getByRole, getByText } = render(FieldWithInput, {
			props: { required: true },
		});
		const input = getByRole("textbox");
		const asterisk = getByText("*");

		expect(asterisk.getAttribute("aria-hidden")).toBe("true");
		expect(input.hasAttribute("required")).toBe(true);
	});
});
