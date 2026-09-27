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
		const toast = screen.getByRole("status");
		expect(toast.classList.contains("bg-inverse-bg")).toBe(true);
		expect(toast.classList.contains("text-inverse-text")).toBe(true);
		const action = screen.getByTestId("toast-action");
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
		expect(screen.getByRole("status").classList.contains("bg-bg-alt")).toBe(
			true,
		);
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
				message: "Failed to send message",
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
				message: "Message queued — sending shortly",
				variant: "warn",
				duration: 7000,
			},
		]);

		const toast = screen.getByRole("status");
		expect(toast.getAttribute("aria-live")).toBe("polite");
	});
});
