import type { SessionInfo } from "../types.js";

export const snoozePicker = $state<{
	session: SessionInfo | null;
	placement: "center" | "sheet";
	now: number;
}>({ session: null, placement: "center", now: 0 });

export function openSnoozePicker(
	session: SessionInfo,
	placement: "center" | "sheet",
) {
	snoozePicker.now = Date.now();
	snoozePicker.placement = placement;
	snoozePicker.session = session;
}
