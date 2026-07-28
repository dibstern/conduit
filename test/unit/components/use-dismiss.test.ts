import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DismissHost from "./fixtures/DismissHost.svelte";

describe("dismiss", () => {
	afterEach(cleanup);

	it("dismisses on outside clicks but not inside or ignored clicks", async () => {
		const onDismiss = vi.fn();
		const { getByRole, getByTestId } = render(DismissHost, {
			props: {
				options: {
					onDismiss,
					ignore: [
						() =>
							document.querySelector<HTMLElement>(
								'[data-testid="dismiss-ignore"]',
							),
					],
				},
			},
		});

		await fireEvent.click(getByRole("button", { name: "Inside" }));
		await fireEvent.click(getByTestId("dismiss-ignore"));
		expect(onDismiss).not.toHaveBeenCalled();

		await fireEvent.click(document.body);
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("dismisses on Escape by default", async () => {
		const onDismiss = vi.fn();
		render(DismissHost, { props: { options: { onDismiss } } });

		await fireEvent.keyDown(document, { key: "Escape" });

		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("can disable Escape dismissal", async () => {
		const onDismiss = vi.fn();
		render(DismissHost, {
			props: { options: { onDismiss, escape: false } },
		});

		await fireEvent.keyDown(document, { key: "Escape" });

		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("does nothing while disabled", async () => {
		const onDismiss = vi.fn();
		render(DismissHost, {
			props: { options: { onDismiss, enabled: false } },
		});

		await fireEvent.click(document.body);
		await fireEvent.keyDown(document, { key: "Escape" });

		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("uses updated options", async () => {
		const originalOnDismiss = vi.fn();
		const updatedOnDismiss = vi.fn();
		const { rerender } = render(DismissHost, {
			props: { options: { onDismiss: originalOnDismiss } },
		});

		await rerender({
			options: {
				onDismiss: updatedOnDismiss,
				outsideClick: false,
			},
		});
		await fireEvent.click(document.body);
		await fireEvent.keyDown(document, { key: "Escape" });

		expect(originalOnDismiss).not.toHaveBeenCalled();
		expect(updatedOnDismiss).toHaveBeenCalledOnce();
	});

	it("ignores Escape while an IME composition is active", async () => {
		const onDismiss = vi.fn();
		render(DismissHost, { props: { options: { onDismiss } } });

		await fireEvent.keyDown(document, { key: "Escape", isComposing: true });

		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("removes its document listeners on destroy", async () => {
		const onDismiss = vi.fn();
		const { unmount } = render(DismissHost, {
			props: { options: { onDismiss } },
		});

		unmount();
		await fireEvent.click(document.body);
		await fireEvent.keyDown(document, { key: "Escape" });

		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("dismisses only the topmost stacked surface on Escape", async () => {
		const lowerOnDismiss = vi.fn();
		const upperOnDismiss = vi.fn();
		render(DismissHost, {
			props: { options: { onDismiss: lowerOnDismiss } },
		});
		const upper = render(DismissHost, {
			props: { options: { onDismiss: upperOnDismiss } },
		});

		await fireEvent.keyDown(document, { key: "Escape" });

		expect(lowerOnDismiss).not.toHaveBeenCalled();
		expect(upperOnDismiss).toHaveBeenCalledOnce();

		upper.unmount();
		await fireEvent.keyDown(document, { key: "Escape" });

		expect(lowerOnDismiss).toHaveBeenCalledOnce();
		expect(upperOnDismiss).toHaveBeenCalledOnce();
	});

	it("preserves mount order when a lower surface is re-enabled", async () => {
		const lowerOnDismiss = vi.fn();
		const upperOnDismiss = vi.fn();
		const lower = render(DismissHost, {
			props: { options: { onDismiss: lowerOnDismiss } },
		});
		render(DismissHost, {
			props: { options: { onDismiss: upperOnDismiss } },
		});

		await lower.rerender({
			options: { onDismiss: lowerOnDismiss, enabled: false },
		});
		await lower.rerender({
			options: { onDismiss: lowerOnDismiss, enabled: true },
		});
		await fireEvent.keyDown(document, { key: "Escape" });

		expect(lowerOnDismiss).not.toHaveBeenCalled();
		expect(upperOnDismiss).toHaveBeenCalledOnce();
	});

	it("lets an enabled lower surface dismiss beneath a disabled upper surface", async () => {
		const lowerOnDismiss = vi.fn();
		const upperOnDismiss = vi.fn();
		render(DismissHost, {
			props: { options: { onDismiss: lowerOnDismiss } },
		});
		render(DismissHost, {
			props: { options: { onDismiss: upperOnDismiss, enabled: false } },
		});

		await fireEvent.keyDown(document, { key: "Escape" });

		expect(lowerOnDismiss).toHaveBeenCalledOnce();
		expect(upperOnDismiss).not.toHaveBeenCalled();
	});
});
