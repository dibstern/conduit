import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import BackgroundInertHost from "./fixtures/BackgroundInertHost.svelte";

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
});
