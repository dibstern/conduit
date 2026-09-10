import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackgroundInertHost from "./fixtures/BackgroundInertHost.svelte";
import BackgroundOverlayHost from "./fixtures/BackgroundOverlayHost.svelte";
import ModalSurfaceHost from "./fixtures/ModalSurfaceHost.svelte";
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

	it("preserves pre-existing inert and aria-hidden state on teardown", async () => {
		const view = render(BackgroundInertHost);
		const preexistingBackground = view.getByTestId("preexisting-background");

		expect(preexistingBackground.hasAttribute("inert")).toBe(true);
		expect(preexistingBackground.getAttribute("aria-hidden")).toBe("true");

		await view.rerender({ enabled: false });

		expect(preexistingBackground.hasAttribute("inert")).toBe(true);
		expect(preexistingBackground.getAttribute("aria-hidden")).toBe("true");
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

	it("closes an earlier Menu on modal open and keeps a later Menu inside the modal open", async () => {
		const onopenchange = vi.fn();
		const view = render(ModalSurfaceHost, { surfaceOpen: true, onopenchange });
		await waitFor(() =>
			expect(view.queryByTestId("surface-content")).not.toBeNull(),
		);
		await view.rerender({ modalOpen: true });
		await waitFor(() =>
			expect(view.getByTestId("surface-open").textContent).toBe("false"),
		);
		expect(view.queryByTestId("surface-content")).toBeNull();
		expect(onopenchange).toHaveBeenCalledWith(false);
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
		const overlay = document.querySelector("[data-dialog-overlay]");
		expect(overlay).not.toBeNull();
		expect(overlay?.closest("[inert], [aria-hidden='true']")).toBeNull();
	});

	it("closes an earlier Popover on modal open and keeps a later Popover inside the modal open", async () => {
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
		await waitFor(() =>
			expect(view.getByTestId("surface-open").textContent).toBe("false"),
		);
		expect(view.queryByTestId("surface-content")).toBeNull();
		expect(onopenchange).toHaveBeenCalledWith(false);
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
		const overlay = document.querySelector("[data-dialog-overlay]");
		expect(overlay).not.toBeNull();
		expect(overlay?.closest("[inert], [aria-hidden='true']")).toBeNull();
	});
});
