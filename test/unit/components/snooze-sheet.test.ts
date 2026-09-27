import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SnoozeSheet from "../../../src/lib/frontend/components/session/SnoozeSheet.svelte";

afterEach(cleanup);

describe("SnoozeSheet", () => {
	it("shows resolved local times and accepts a future picked time", async () => {
		const now = new Date(2026, 9, 5, 9).getTime();
		const onsnooze = vi.fn();
		render(SnoozeSheet, {
			props: {
				open: true,
				sessionTitle: "Alpha",
				now,
				onclose: vi.fn(),
				onsnooze,
			},
		});
		expect(screen.getByText("Snooze until…")).toBeTruthy();
		expect(screen.getByTestId("snooze-option-tomorrow").textContent).toContain(
			"Tue 9:00",
		);
		await fireEvent.click(screen.getByTestId("snooze-option-pick"));
		const submit = screen.getByTestId("snooze-pick-submit");
		expect(submit.hasAttribute("disabled")).toBe(true);
		await fireEvent.input(screen.getByTestId("snooze-pick-input"), {
			target: { value: "2026-10-05T08:00" },
		});
		expect(submit.hasAttribute("disabled")).toBe(true);
		await fireEvent.input(screen.getByTestId("snooze-pick-input"), {
			target: { value: "2026-10-05T12:30" },
		});
		expect(submit.hasAttribute("disabled")).toBe(false);
		await fireEvent.click(submit);
		expect(onsnooze).toHaveBeenCalledWith(
			new Date(2026, 9, 5, 12, 30).getTime(),
		);
	});
});
