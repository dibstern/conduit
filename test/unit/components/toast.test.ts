import { cleanup, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Toast from "../../../src/lib/frontend/components/overlays/Toast.svelte";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import type { Toast as ToastType } from "../../../src/lib/frontend/types.js";

async function renderToasts(toasts: ToastType[]): Promise<void> {
	uiState.toasts = toasts;
	render(Toast);
	flushSync();
	await tick();
}

describe("Toast", () => {
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
