import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Toast from "../../../src/lib/frontend/components/overlays/Toast.svelte";
import {
	showToast,
	uiState,
} from "../../../src/lib/frontend/stores/ui.svelte.js";
import type { Toast as ToastType } from "../../../src/lib/frontend/types.js";

async function renderToasts(toasts: ToastType[]): Promise<void> {
	uiState.toasts = toasts;
	render(Toast);
	flushSync();
	await tick();
}

describe("Toast", () => {
	it("runs the stored action and dismisses its toast", async () => {
		const run = vi.fn();
		showToast("Moved a session to Settled", {
			duration: 5000,
			action: { label: "Undo", run },
		});
		render(Toast);
		const action = screen.getByTestId("toast-action");
		expect(action.dataset["kind"]).toBe("primary");
		expect(action.tagName).toBe("BUTTON");
		expect(action.textContent?.trim()).toBe("Undo");
		await fireEvent.click(action);
		expect(run).toHaveBeenCalledOnce();
		expect(uiState.toasts).toEqual([]);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("renders no action for an ordinary toast", () => {
		showToast("Saved");
		render(Toast);
		expect(screen.queryByTestId("toast-action")).toBeNull();
		expect(screen.getByRole("status").textContent?.trim()).toBe("Saved");
	});

	it("puts a dismiss action last and closes the toast without running anything", async () => {
		showToast({
			title: "Switched to personal",
			body: "personal has 77% of its week left.",
			emphasis: "personal",
			actions: [
				{ label: "Later", kind: "dismiss" },
				{ label: "Undo", run: vi.fn(), kind: "primary" },
			],
		});
		render(Toast);
		expect(screen.getByText("personal", { selector: "b" })).toBeTruthy();
		const actions = screen.getAllByTestId("toast-action");
		expect(actions.map((action) => action.textContent?.trim())).toEqual([
			"Undo",
			"Later",
		]);
		const later = actions[1];
		if (!later) throw new Error("expected the Later action");
		await fireEvent.click(later);
		expect(uiState.toasts).toEqual([]);
	});

	beforeEach(() => {
		uiState.toasts = [];
	});

	afterEach(() => {
		cleanup();
		uiState.toasts = [];
	});

	it("announces error toasts assertively and shows an error icon", async () => {
		await renderToasts([
			{
				id: "error-toast",
				title: "Failed to send message",
				actions: [],
				variant: "error",
				duration: 7000,
			},
		]);

		const toast = screen.getByRole("alert");
		expect(toast.getAttribute("aria-live")).toBe("assertive");
		expect(
			toast.querySelector('[aria-hidden="true"] svg.lucide-circle-x'),
		).not.toBeNull();
	});

	it("keeps warning toasts polite status messages", async () => {
		await renderToasts([
			{
				id: "warn-toast",
				title: "Message queued — sending shortly",
				actions: [],
				variant: "warn",
				duration: 7000,
			},
		]);

		const toast = screen.getByRole("status");
		expect(toast.getAttribute("aria-live")).toBe("polite");
	});
});
