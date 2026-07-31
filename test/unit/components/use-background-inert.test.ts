import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import BackgroundInertHost from "./fixtures/BackgroundInertHost.svelte";
import NestedModals from "./fixtures/NestedModals.svelte";

describe("backgroundInert", () => {
	afterEach(cleanup);

	it("inerts HTML and SVG background siblings and restores their prior state", async () => {
		const view = render(BackgroundInertHost);
		const backgroundControl = view.getByTestId("background-control");
		const backgroundSvg = view.getByTestId("background-svg");

		expect(backgroundControl.hasAttribute("inert")).toBe(true);
		expect(backgroundControl.getAttribute("aria-hidden")).toBe("true");
		expect(backgroundSvg.hasAttribute("inert")).toBe(true);
		expect(backgroundSvg.getAttribute("aria-hidden")).toBe("true");

		await view.rerender({ enabled: false });

		expect(backgroundControl.hasAttribute("inert")).toBe(false);
		expect(backgroundControl.getAttribute("aria-hidden")).toBe("false");
		expect(backgroundSvg.hasAttribute("inert")).toBe(false);
		expect(backgroundSvg.getAttribute("aria-hidden")).toBe("false");
	});

	it("restores outer modal controls when a nested modal closes", async () => {
		const view = render(NestedModals);
		const outerAction = view.getByTestId("outer-action");
		const outerHeader = view.getByText("Outer modal").closest("header");

		expect(outerHeader).not.toBeNull();
		await waitFor(() => {
			expect(outerHeader?.hasAttribute("inert")).toBe(true);
			expect(outerHeader?.getAttribute("aria-hidden")).toBe("true");
			expect(outerAction.hasAttribute("inert")).toBe(true);
			expect(outerAction.getAttribute("aria-hidden")).toBe("true");
		});

		await view.rerender({ innerOpen: false });

		await waitFor(() => {
			expect(outerHeader?.hasAttribute("inert")).toBe(false);
			expect(outerHeader?.hasAttribute("aria-hidden")).toBe(false);
			expect(outerAction.hasAttribute("inert")).toBe(false);
			expect(outerAction.hasAttribute("aria-hidden")).toBe(false);
		});
	});
});
