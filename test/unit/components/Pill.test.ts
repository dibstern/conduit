import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Pill from "../../../src/lib/frontend/components/ui/Pill.svelte";

const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe("Pill", () => {
	afterEach(cleanup);

	it("renders a button with a safe type and forwards native attributes", () => {
		const { getByTestId } = render(Pill, {
			props: {
				"aria-expanded": true,
				"data-testid": "model-picker",
				title: "Choose a model",
				children: label("Default model"),
			},
		});
		const pill = getByTestId("model-picker");

		expect(pill.tagName).toBe("BUTTON");
		expect(pill.getAttribute("type")).toBe("button");
		expect(pill.getAttribute("aria-expanded")).toBe("true");
		expect(pill.getAttribute("title")).toBe("Choose a model");
	});

	it("appends the consumer class without replacing variant classes", () => {
		const { getByRole } = render(Pill, {
			props: {
				variant: "warning",
				class: "consumer-pill",
				children: label("Elevated access"),
			},
		});
		const pill = getByRole("button");

		expect(pill.classList.contains("consumer-pill")).toBe(true);
		expect(pill.classList.contains("bg-warning-bg")).toBe(true);
	});

	it.each([
		["neutral", "bg-bg-alt"],
		["warning", "bg-warning-bg"],
	] as const)("applies the %s variant", (variant, expectedClass) => {
		const { getByRole } = render(Pill, {
			props: { variant, children: label(variant) },
		});

		expect(getByRole("button").classList.contains(expectedClass)).toBe(true);
	});

	it("fires onclick when enabled", async () => {
		const onclick = vi.fn();
		const { getByRole } = render(Pill, {
			props: { onclick, children: label("Open models") },
		});

		await fireEvent.click(getByRole("button"));

		expect(onclick).toHaveBeenCalledOnce();
	});

	it("does not fire onclick when disabled", () => {
		const onclick = vi.fn();
		const { getByRole } = render(Pill, {
			props: { disabled: true, onclick, children: label("Unavailable") },
		});
		const pill = getByRole("button");

		expect(pill.hasAttribute("disabled")).toBe(true);
		pill.click();
		expect(onclick).not.toHaveBeenCalled();
	});
});
