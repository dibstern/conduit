import type { AutoSettleOutlook } from "../../contracts/ws-rpc.js";
import { formatSnoozeTime } from "./format.js";

/**
 * What the server will do next, after the switch's On / Off: never guessed from session flags.
 * No default: the `string` return type makes a new outlook kind or pause reason a compile error.
 */
export function describeAutoSettle(
	outlook: AutoSettleOutlook,
	now: number,
): string {
	switch (outlook.kind) {
		case "off":
			return "stays until you settle it";
		case "never":
			return "turned off for all sessions in Settings";
		case "settled":
			return "session is settled";
		case "due":
			return "settles shortly";
		case "scheduled":
			return `settles ${formatSnoozeTime(outlook.at, now)} if left idle`;
		case "paused":
			switch (outlook.reason) {
				case "pinned":
				case "snoozed":
				case "unread":
				case "working":
					return `paused while ${outlook.reason}`;
				case "awaiting-activity":
					return "waits for new activity";
			}
	}
}
