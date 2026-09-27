import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import Badge from "../../../src/lib/frontend/components/ui/Badge.svelte";

const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe("Badge", () => {
	afterEach(cleanup);

	it("renders a span and forwards native attributes to its root", () => {
		const { getByTestId } = render(Badge, {
			props: {
				"data-testid": "client-count",
				title: "Connected clients",
				children: label("3"),
			},
		});
		const badge = getByTestId("client-count");

		expect(badge.tagName).toBe("SPAN");
		expect(badge.getAttribute("title")).toBe("Connected clients");
		expect(badge.textContent).toContain("3");
	});

	it("appends the consumer class without replacing variant classes", () => {
		const { getByTestId } = render(Badge, {
			props: {
				variant: "accent",
				class: "consumer-badge",
				"data-testid": "badge",
				children: label("Live"),
			},
		});
		const badge = getByTestId("badge");

		expect(badge.classList.contains("consumer-badge")).toBe(true);
		expect(badge.classList.contains("bg-accent-bg")).toBe(true);
	});

	it.each([
		["neutral", "bg-bg"],
		["accent", "bg-accent-bg"],
		["accent-solid", "bg-accent"],
		["tag", "bg-[rgba(var(--overlay-rgb),0.05)]"],
	] as const)("applies the %s variant", (variant, expectedClass) => {
		const { getByTestId } = render(Badge, {
			props: {
				variant,
				"data-testid": "badge",
				children: label(variant),
			},
		});

		expect(getByTestId("badge").classList.contains(expectedClass)).toBe(true);
	});

	it.each([
		["xs", "text-xs"],
		["sm", "text-sm"],
		["count", "h-[18px]"],
	] as const)("applies the %s size", (size, expectedClass) => {
		const { getByTestId } = render(Badge, {
			props: {
				size,
				"data-testid": "badge",
				children: label(size),
			},
		});

		expect(getByTestId("badge").classList.contains(expectedClass)).toBe(true);
	});

	it.each([
		["rounded", "rounded"],
		["pill", "rounded-full"],
	] as const)("applies the %s shape", (shape, expectedClass) => {
		const { getByTestId } = render(Badge, {
			props: {
				shape,
				"data-testid": "badge",
				children: label(shape),
			},
		});

		expect(getByTestId("badge").classList.contains(expectedClass)).toBe(true);
	});
});
