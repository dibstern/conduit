import type { SessionInfo } from "../types.js";

export const snoozePicker = $state<{
	session: SessionInfo | null;
	placement: "center" | "sheet";
	now: number;
	returnFocus: (() => HTMLElement | null) | undefined;
}>({ session: null, placement: "center", now: 0, returnFocus: undefined });

export function openSnoozePicker(
	session: SessionInfo,
	placement: "center" | "sheet",
	returnFocus?: () => HTMLElement | null,
) {
	snoozePicker.now = Date.now();
	snoozePicker.placement = placement;
	snoozePicker.returnFocus = returnFocus;
	snoozePicker.session = session;
}
