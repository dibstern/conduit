import { describe, expect, it } from "vitest";
import { getSnoozePresets } from "../../../src/lib/frontend/utils/snooze.js";

describe("getSnoozePresets", () => {
	it("resolves a morning with this evening", () => {
		const now = new Date(2026, 9, 5, 9, 15).getTime();
		const presets = getSnoozePresets(now);
		expect(presets.map((preset) => preset.id)).toEqual([
			"1h",
			"3h",
			"evening",
			"tomorrow",
			"next-week",
			"indefinite",
		]);
		expect(presets.map((preset) => preset.until)).toEqual([
			new Date(2026, 9, 5, 10, 15).getTime(),
			new Date(2026, 9, 5, 12, 15).getTime(),
			new Date(2026, 9, 5, 18).getTime(),
			new Date(2026, 9, 6, 9).getTime(),
			new Date(2026, 9, 12, 9).getTime(),
			null,
		]);
	});

	it("omits evening after 17:00, including late evening", () => {
		for (const hour of [17, 23]) {
			const now = new Date(2026, 9, 5, hour, 30).getTime();
			const presets = getSnoozePresets(now);
			expect(presets.some((preset) => preset.id === "evening")).toBe(false);
			expect(presets.find((preset) => preset.id === "tomorrow")?.until).toBe(
				new Date(2026, 9, 6, 9).getTime(),
			);
		}
	});

	it("chooses the next Monday from Sunday", () => {
		const presets = getSnoozePresets(new Date(2026, 9, 11, 11).getTime());
		expect(presets.find((preset) => preset.id === "next-week")?.until).toBe(
			new Date(2026, 9, 12, 9).getTime(),
		);
	});
});
