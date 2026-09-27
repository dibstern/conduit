export type SnoozePreset = {
	id: "1h" | "3h" | "evening" | "tomorrow" | "next-week" | "indefinite";
	label: string;
	until: number | null;
};

/** Resolve every preset in local wall time. The caller supplies `now` so the
 * sheet and its stories can share one stable instant. */
export function getSnoozePresets(now: number): SnoozePreset[] {
	const date = new Date(now);
	const tomorrow = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate() + 1,
		9,
	);
	const daysToNextMonday = (8 - date.getDay()) % 7 || 7;
	const nextWeek = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate() + daysToNextMonday,
		9,
	);
	const presets: SnoozePreset[] = [
		{ id: "1h", label: "In 1 hour", until: now + 3_600_000 },
		{ id: "3h", label: "In 3 hours", until: now + 10_800_000 },
	];
	if (date.getHours() < 17) {
		presets.push({
			id: "evening",
			label: "This evening",
			until: new Date(
				date.getFullYear(),
				date.getMonth(),
				date.getDate(),
				18,
			).getTime(),
		});
	}
	presets.push(
		{ id: "tomorrow", label: "Tomorrow", until: tomorrow.getTime() },
		{ id: "next-week", label: "Next week", until: nextWeek.getTime() },
		{ id: "indefinite", label: "Until something happens", until: null },
	);
	return presets;
}
