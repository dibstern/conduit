import { isSessionSnoozed, isSessionWoken } from "../stores/session.svelte.js";
import type { SessionInfo } from "../types.js";
import { formatSnoozeTime } from "./format.js";

export function getWokenSessionText(session: SessionInfo): string {
	const reason =
		session.wokenAt != null ? (session.wokeBecause ?? "time") : "time";
	return reason === "time"
		? "Woke"
		: reason === "error"
			? "Woke · failed"
			: reason === "turn"
				? "Woke · done"
				: `Woke · ${reason}`;
}

export function getSessionBarState(
	session: SessionInfo | undefined,
	now: number,
) {
	if (!session) return null;
	if (session.settledAt != null) {
		return session.settledAutomatically === true
			? { kind: "auto-settled" as const, label: "Auto-settled", icon: "check" }
			: { kind: "settled" as const, label: "Settled", icon: "check" };
	}
	if (isSessionSnoozed(session, now)) {
		return {
			kind: "snoozed" as const,
			label: formatSnoozeTime(session.snoozedUntil ?? null, now),
			icon: "moon",
		};
	}
	if (isSessionWoken(session, now)) {
		return {
			kind: "woke" as const,
			label: getWokenSessionText(session),
			icon: "clock",
		};
	}
	return null;
}
