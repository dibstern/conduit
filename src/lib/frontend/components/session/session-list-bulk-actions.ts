import { getBrowserClientId } from "../../stores/client-identity.js";
import { getCurrentSlug } from "../../stores/router.svelte.js";
import { isSessionSnoozed } from "../../stores/session.svelte.js";
import { refreshListedSessions } from "../../stores/session-list.svelte.js";
import { showToast } from "../../stores/ui.svelte.js";
import {
	setSessionPinnedRpc,
	setSessionSettledRpc,
	snoozeSessionRpc,
	unsnoozeSessionRpc,
} from "../../transport/ws-rpc-client.js";
import type { SessionInfo } from "../../types.js";
import { formatSnoozeTime } from "../../utils/format.js";

type BulkSelection = {
	eligible: SessionInfo[];
	selectedCount: number;
	oncomplete: () => void;
};

export async function runBulkChange(
	kind: "settle" | "pin",
	{ eligible, selectedCount, oncomplete }: BulkSelection,
	unpinSelected: boolean,
): Promise<void> {
	const pinned = !unpinSelected;
	const skipped = selectedCount - eligible.length;
	const input = eligible.map((session) => ({
		projectSlug: session.projectSlug ?? getCurrentSlug() ?? "",
		sessionId: session.id,
		originId: getBrowserClientId(),
	}));
	const results = await Promise.allSettled(
		input.map((session) =>
			kind === "settle"
				? setSessionSettledRpc({ ...session, settled: true })
				: setSessionPinnedRpc({ ...session, pinned }),
		),
	);
	const changed = input.filter(
		(_, index) => results[index]?.status === "fulfilled",
	);
	void refreshListedSessions();
	oncomplete();
	const count = changed.length;
	let verb = "Unpinned";
	if (kind === "settle") verb = "Settled";
	else if (pinned) verb = "Pinned";
	const completedSessionLabel = count === 1 ? "session" : "sessions";
	const inputSessionLabel = input.length === 1 ? "session" : "sessions";
	const message =
		(count === input.length
			? `${verb} ${count} ${completedSessionLabel}`
			: `${verb} ${count} of ${input.length} ${inputSessionLabel}`) +
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
									kind === "settle"
										? setSessionSettledRpc({ ...session, settled: false })
										: setSessionPinnedRpc({ ...session, pinned: !pinned }),
								),
							).then((undoResults) => {
								void refreshListedSessions();
								if (undoResults.some((result) => result.status === "rejected"))
									showToast("Couldn't undo", { variant: "error" });
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
		projectSlug: session.projectSlug ?? getCurrentSlug() ?? "",
		sessionId: session.id,
		originId: getBrowserClientId(),
		wasSnoozed: isSessionSnoozed(session, now),
		previousUntil: session.snoozedUntil ?? null,
	}));
	const results = await Promise.allSettled(
		input.map((session) =>
			snoozeSessionRpc({
				projectSlug: session.projectSlug,
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
										? snoozeSessionRpc({
												projectSlug: session.projectSlug,
												sessionId: session.sessionId,
												originId: session.originId,
												until: session.previousUntil,
											})
										: unsnoozeSessionRpc({
												projectSlug: session.projectSlug,
												sessionId: session.sessionId,
												originId: session.originId,
											}),
								),
							).then((undoResults) => {
								void refreshListedSessions();
								if (undoResults.some((result) => result.status === "rejected"))
									showToast("Couldn't undo", { variant: "error" });
							});
						},
					},
				}
			: {}),
	});
}
