import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackgroundInertHost from "./fixtures/BackgroundInertHost.svelte";
import BackgroundOverlayHost from "./fixtures/BackgroundOverlayHost.svelte";
import ModalSurfaceHost from "./fixtures/ModalSurfaceHost.svelte";
import NestedModals from "./fixtures/NestedModals.svelte";

describe("backgroundInert", () => {
	// bits-ui's body-scroll-lock defers its body-style restore by 24ms so a
	// same-tick destroy/create does not flash the page back. Unmounting a modal
	// and ending the test immediately leaves that timer to fire into a torn-down
	// jsdom, which vitest reports as an unhandled `document is not defined` and
	// fails the whole run without failing any test. Outlive the timer instead.
	afterEach(async () => {
		cleanup();
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

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

	it("preserves pre-existing inert and aria-hidden state on teardown", async () => {
		const view = render(BackgroundInertHost);
		const preexistingBackground = view.getByTestId("preexisting-background");

		expect(preexistingBackground.hasAttribute("inert")).toBe(true);
		expect(preexistingBackground.getAttribute("aria-hidden")).toBe("true");

		await view.rerender({ enabled: false });

		expect(preexistingBackground.hasAttribute("inert")).toBe(true);
		expect(preexistingBackground.getAttribute("aria-hidden")).toBe("true");
	});

	it("keeps the outer dialog open when a nested dialog closes", async () => {
		const view = render(NestedModals);
		const outerAction = view.getByTestId("outer-action");
		const outer = view.getByRole("dialog", { name: "Outer modal" });
		const inner = view.getByRole("dialog", { name: "Inner modal" });
		expect((outer as HTMLDialogElement).open).toBe(true);
		expect((inner as HTMLDialogElement).open).toBe(true);

		await view.rerender({ innerOpen: false });

		await waitFor(() => {
			expect((inner as HTMLDialogElement).open).toBe(false);
			expect((outer as HTMLDialogElement).open).toBe(true);
			expect(outer.contains(outerAction)).toBe(true);
		});
	});
	it("keeps a later overlay live but inerts it when a subsequent boundary activates", async () => {
		const view = render(BackgroundOverlayHost, { enabled: true });
		await view.rerender({ overlay: true });
		const branch = view.getByTestId("background-branch");
		expect(branch.hasAttribute("inert")).toBe(false);
		expect(branch.hasAttribute("aria-hidden")).toBe(false);
		expect(
			view.getByTestId("overlay").closest("[inert], [aria-hidden='true']"),
		).toBeNull();

		await view.rerender({ enabled: false });
		await view.rerender({ enabled: true });
		expect(branch.hasAttribute("inert")).toBe(true);
		expect(branch.getAttribute("aria-hidden")).toBe("true");
	});

	it("inerts controls off a live overlay's path inside a background branch", async () => {
		const view = render(BackgroundOverlayHost, { enabled: true });
		await view.rerender({ overlay: true });
		expect(view.getByTestId("unrelated-control").hasAttribute("inert")).toBe(
			true,
		);
		expect(
			view.getByTestId("unrelated-control").getAttribute("aria-hidden"),
		).toBe("true");
		for (const id of [
			"background-branch",
			"overlay-path",
			"overlay",
			"boundary",
			"modal-control",
		]) {
			expect(
				view.getByTestId(id).closest("[inert], [aria-hidden='true']"),
			).toBeNull();
		}
	});

	it("keeps sibling modal content live when an overlay opens inline", async () => {
		const view = render(BackgroundOverlayHost, { enabled: true, inline: true });
		await view.rerender({ overlay: true });
		for (const id of ["boundary", "modal-control", "overlay"]) {
			expect(
				view.getByTestId(id).closest("[inert], [aria-hidden='true']"),
			).toBeNull();
		}
		expect(view.getByTestId("background-branch").hasAttribute("inert")).toBe(
			true,
		);
	});

	it("keeps Menu state while a native modal takes the top layer", async () => {
		const onopenchange = vi.fn();
		const view = render(ModalSurfaceHost, { surfaceOpen: true, onopenchange });
		await waitFor(() =>
			expect(view.queryByTestId("surface-content")).not.toBeNull(),
		);
		await view.rerender({ modalOpen: true });
		expect(view.getByRole("dialog", { name: "Host modal" })).toHaveProperty(
			"open",
			true,
		);
		expect(view.getByTestId("surface-open").textContent).toBe("true");
		expect(onopenchange).not.toHaveBeenCalledWith(false);
		view.unmount();

		const innerChange = vi.fn();
		const inner = render(ModalSurfaceHost, {
			modalOpen: true,
			inside: true,
			onopenchange: innerChange,
		});
		await inner.rerender({ surfaceOpen: true });
		await waitFor(() =>
			expect(inner.queryByTestId("surface-content")).not.toBeNull(),
		);
		expect(inner.getByTestId("surface-open").textContent).toBe("true");
		expect(innerChange).not.toHaveBeenCalledWith(false);
		for (const id of ["modal-action", "surface-content"]) {
			expect(
				inner.getByTestId(id).closest("[inert], [aria-hidden='true']"),
			).toBeNull();
		}
		expect(
			inner
				.getByRole("dialog", { name: "Host modal" })
				.closest("[inert], [aria-hidden='true']"),
		).toBeNull();
	});

	it("keeps Popover state while a native modal takes the top layer", async () => {
		const onopenchange = vi.fn();
		const view = render(ModalSurfaceHost, {
			surfaceOpen: true,
			popover: true,
			onopenchange,
		});
		await waitFor(() =>
			expect(view.queryByTestId("surface-content")).not.toBeNull(),
		);
		await view.rerender({ modalOpen: true });
		expect(view.getByRole("dialog", { name: "Host modal" })).toHaveProperty(
			"open",
			true,
		);
		expect(view.getByTestId("surface-open").textContent).toBe("true");
		expect(onopenchange).not.toHaveBeenCalledWith(false);
		view.unmount();

		const innerChange = vi.fn();
		const inner = render(ModalSurfaceHost, {
			modalOpen: true,
			inside: true,
			popover: true,
			onopenchange: innerChange,
		});
		await inner.rerender({ surfaceOpen: true });
		await waitFor(() =>
			expect(inner.queryByTestId("surface-content")).not.toBeNull(),
		);
		expect(inner.getByTestId("surface-open").textContent).toBe("true");
		expect(innerChange).not.toHaveBeenCalledWith(false);
		for (const id of ["modal-action", "surface-content"]) {
			expect(
				inner.getByTestId(id).closest("[inert], [aria-hidden='true']"),
			).toBeNull();
		}
		expect(
			inner
				.getByRole("dialog", { name: "Host modal" })
				.closest("[inert], [aria-hidden='true']"),
		).toBeNull();
	});
});
