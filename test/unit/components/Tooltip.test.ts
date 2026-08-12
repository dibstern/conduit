import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import TooltipTestHarness from "./fixtures/TooltipTestHarness.svelte";

describe("Tooltip", () => {
	afterEach(cleanup);

	it("renders a described tooltip with floating-surface styles", () => {
		const { getByRole } = render(TooltipTestHarness, {
			props: { open: true },
		});
		const trigger = getByRole("button", { name: "Show details" });
		const tooltip = getByRole("tooltip");

		// Assert the id is non-empty *before* comparing: Bits derives describedby from
		// `contentNode.id`, so dropping the wrapper's own `id` makes both sides "" and a
		// bare toBe() passes on a tooltip with no accessible description at all.
		expect(tooltip.id).not.toBe("");
		expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
		expect(tooltip.classList.contains("rounded-lg")).toBe(true);
		expect(tooltip.classList.contains("bg-bg-alt")).toBe(true);
	});

	it("registers its trigger as active when it mounts already open", () => {
		const { getByRole } = render(TooltipTestHarness, {
			props: { open: true },
		});
		const trigger = getByRole("button", { name: "Show details" });

		// Bits only marks the trigger open when that trigger is the *active* one,
		// and the active trigger is what floating-ui anchors the content to. A
		// controlled-open tooltip that never registers one still renders visible,
		// correctly sized content -- unanchored, at the top-left of the viewport.
		// `data-state` is the only jsdom-observable proxy for that; layout is not.
		expect(trigger.getAttribute("data-state")).toBe("instant-open");
	});

	it("supplies the tooltip role that Bits omits", () => {
		const { getByRole } = render(TooltipTestHarness, {
			props: { open: true },
		});

		expect(getByRole("tooltip").getAttribute("role")).toBe("tooltip");
	});

	it("opens on focus, closes on blur, and reports state changes", async () => {
		const onopenchange = vi.fn();
		const view = render(TooltipTestHarness, {
			props: { open: false, onopenchange },
		});
		const trigger = view.getByRole("button", { name: "Show details" });

		expect(view.getByTestId("tooltip-open").textContent).toBe("false");
		await fireEvent.focus(trigger);
		expect(view.getByTestId("tooltip-open").textContent).toBe("true");
		expect(onopenchange).toHaveBeenCalledWith(true);

		expect(trigger.getAttribute("aria-describedby")).toBe(
			view.getByRole("tooltip").id,
		);
		expect(view.getByRole("tooltip").id).not.toBe("");

		await fireEvent.blur(trigger);
		await waitFor(() =>
			expect(view.getByTestId("tooltip-open").textContent).toBe("false"),
		);
		// The describedby fallback must be *removed* on close, not just added on open:
		// an id left pointing at unmounted content is a dangling ARIA reference, which
		// is worse for a screen reader than no attribute at all.
		expect(trigger.getAttribute("aria-describedby")).toBeNull();
	});

	it("closes on Escape", async () => {
		const onopenchange = vi.fn();
		const view = render(TooltipTestHarness, {
			props: { open: true, onopenchange },
		});

		await fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() =>
			expect(view.getByTestId("tooltip-open").textContent).toBe("false"),
		);
		expect(onopenchange).toHaveBeenLastCalledWith(false);
	});

	it("keeps a body-portaled tooltip live while its trigger is inside a modal", async () => {
		const view = render(TooltipTestHarness, {
			props: { insideModal: true, open: false },
		});
		const modal = view.getByRole("dialog", { name: "Modal with tooltip" });
		const trigger = view.getByRole("button", { name: "Show details" });

		expect(view.getByTestId("tooltip-open").textContent).toBe("false");
		await fireEvent.focus(trigger);
		expect(view.getByTestId("tooltip-open").textContent).toBe("true");

		await waitFor(() => {
			const tooltip = document.querySelector<HTMLElement>(
				"[data-tooltip-content]",
			);
			expect(tooltip).not.toBeNull();
			expect(document.body.contains(tooltip)).toBe(true);
			expect(modal.contains(tooltip)).toBe(false);
			const modalBranch = [...document.body.children].find((element) =>
				element.contains(modal),
			);
			const tooltipBranch = [...document.body.children].find((element) =>
				element.contains(tooltip),
			);
			expect(tooltipBranch).toBeDefined();
			expect(tooltipBranch).not.toBe(modalBranch);

			let current: HTMLElement | null = tooltip;
			while (current && current !== document.body) {
				expect(current.hasAttribute("inert")).toBe(false);
				expect(current.hasAttribute("aria-hidden")).toBe(false);
				current = current.parentElement;
			}
		});
	});

	it("portals content to an explicit target", () => {
		const portalTarget = document.createElement("div");
		document.body.append(portalTarget);
		const { getByRole } = render(TooltipTestHarness, {
			props: { open: true, portalTo: portalTarget },
		});

		expect(portalTarget.contains(getByRole("tooltip"))).toBe(true);
		portalTarget.remove();
	});

	it("warns when tooltip content contains only whitespace", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		render(TooltipTestHarness, {
			props: { emptyContent: true, open: true },
		});

		await waitFor(() =>
			expect(warning).toHaveBeenCalledWith(
				"[ui/Tooltip] tooltip content must render non-whitespace text.",
			),
		);
		warning.mockRestore();
	});

	it("does not warn when tooltip content has text", async () => {
		// Without this, a component that warns unconditionally passes the test above.
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		const view = render(TooltipTestHarness, { props: { open: true } });
		await waitFor(() => expect(view.getByRole("tooltip")).toBeTruthy());

		expect(warning).not.toHaveBeenCalled();
		warning.mockRestore();
	});
});
