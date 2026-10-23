import { getBrowserClientId } from "../../stores/client-identity.js";
import { isSessionSnoozed } from "../../stores/session.svelte.js";
import { refreshListedSessions } from "../../stores/session-list.svelte.js";
import { showToast } from "../../stores/ui.svelte.js";
import { toastFailure } from "../../transport/rpc-errors.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import type { SessionInfo } from "../../types.js";
import { formatSnoozeTime } from "../../utils/format.js";

type BulkSelection = {
	eligible: SessionInfo[];
	selectedCount: number;
	oncomplete: () => void;
};

const writeBulkChange = (
	kind: "settle" | "pin" | "unread",
	session: { sessionId: string; originId: string },
	on: boolean,
) => {
	if (kind === "settle")
		return rpc("SetSessionSettled", { ...session, settled: on });
	if (kind === "pin")
		return rpc("SetSessionPinned", { ...session, pinned: on });
	return on
		? rpc("MarkSessionUnread", session)
		: rpc("MarkSessionRead", session);
};

/** Sets `kind` to `on` for each eligible session, with an Undo that sets it back. */
export async function runBulkChange(
	kind: "settle" | "pin" | "unread",
	{ eligible, selectedCount, oncomplete }: BulkSelection,
	on: boolean,
): Promise<void> {
	const skipped = selectedCount - eligible.length;
	const input = eligible.map((session) => ({
		sessionId: session.id,
		originId: getBrowserClientId(),
	}));
	const results = await Promise.allSettled(
		input.map((session) => writeBulkChange(kind, session, on)),
	);
	const changed = input.filter(
		(_, index) => results[index]?.status === "fulfilled",
	);
	void refreshListedSessions();
	oncomplete();
	const count = changed.length;
	const verb = {
		settle: "Settled",
		pin: on ? "Pinned" : "Unpinned",
		unread: "Marked",
	}[kind];
	const completedSessionLabel = count === 1 ? "session" : "sessions";
	const inputSessionLabel = input.length === 1 ? "session" : "sessions";
	const message =
		(count === input.length
			? `${verb} ${count} ${completedSessionLabel}`
			: `${verb} ${count} of ${input.length} ${inputSessionLabel}`) +
		(kind === "unread" ? (on ? " unread" : " read") : "") +
		(skipped ? `, ${skipped} skipped` : "");
	showToast(message, {
		duration: 5000,
		...(count > 0
			? {
					action: {
						label: "Undo",
						run: () => {
							void Promise.allSettled(
								changed.map((session) => writeBulkChange(kind, session, !on)),
							).then((undoResults) => {
								void refreshListedSessions();
								const failed = undoResults.find(
									(result) => result.status === "rejected",
								);
								if (failed) toastFailure("Couldn't undo")(failed.reason);
							});
						},
					},
				}
			: {}),
	});
}

export async function runBulkSnooze(
	{ eligible, selectedCount, oncomplete }: BulkSelection,
	until: number | null,
	now: number,
): Promise<void> {
	const skipped = selectedCount - eligible.length;
	const input = eligible.map((session) => ({
		projectSlug: session.projectSlug,
		sessionId: session.id,
		originId: getBrowserClientId(),
		wasSnoozed: isSessionSnoozed(session, now),
		previousUntil: session.snoozedUntil ?? null,
	}));
	const results = await Promise.allSettled(
		input.map((session) =>
			rpc("SnoozeSession", {
				sessionId: session.sessionId,
				originId: session.originId,
				until,
			}),
		),
	);
	const changed = input.filter(
		(_, index) => results[index]?.status === "fulfilled",
	);
	void refreshListedSessions();
	oncomplete();
	const count = changed.length;
	const completedSessionLabel = count === 1 ? "session" : "sessions";
	const inputSessionLabel = input.length === 1 ? "session" : "sessions";
	let untilMessage = "";
	if (count > 0) {
		untilMessage =
			until === null
				? " until something happens"
				: ` until ${formatSnoozeTime(until, now)}`;
	}
	const message =
		(count === input.length
			? `Snoozed ${count} ${completedSessionLabel}`
			: `Snoozed ${count} of ${input.length} ${inputSessionLabel}`) +
		untilMessage +
		(skipped ? `, ${skipped} skipped` : "");
	showToast(message, {
		duration: 5000,
		...(count > 0
			? {
					action: {
						label: "Undo",
						run: () => {
							void Promise.allSettled(
								changed.map((session) =>
									session.wasSnoozed
										? rpc("SnoozeSession", {
												sessionId: session.sessionId,
												originId: session.originId,
												until: session.previousUntil,
											})
										: rpc("UnsnoozeSession", {
												sessionId: session.sessionId,
												originId: session.originId,
											}),
								),
							).then((undoResults) => {
								void refreshListedSessions();
								const failed = undoResults.find(
									(result) => result.status === "rejected",
								);
								if (failed) toastFailure("Couldn't undo")(failed.reason);
							});
						},
					},
				}
			: {}),
	});
}
