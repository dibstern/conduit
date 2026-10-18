import type { SessionInfo } from "../types.js";

export const snoozePicker = $state<{
	session: SessionInfo | null;
	placement: "center" | "sheet";
	now: number;
	returnFocus: (() => HTMLElement | null) | undefined;
	/** Open with the date and time field already showing. */
	picking: boolean;
}>({
	session: null,
	placement: "center",
	now: 0,
	returnFocus: undefined,
	picking: false,
});

export function openSnoozePicker(
	session: SessionInfo,
	placement: "center" | "sheet",
	returnFocus?: () => HTMLElement | null,
	picking = false,
) {
	snoozePicker.now = Date.now();
	snoozePicker.placement = placement;
	snoozePicker.returnFocus = returnFocus;
	snoozePicker.picking = picking;
	snoozePicker.session = session;
}
