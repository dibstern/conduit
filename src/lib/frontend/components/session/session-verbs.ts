import { getBrowserClientId } from "../../stores/client-identity.js";
import { getCurrentSlug } from "../../stores/router.svelte.js";
import {
	isSessionSnoozed,
	sessionState,
	switchToSession,
} from "../../stores/session.svelte.js";
import { openSnoozePicker } from "../../stores/snooze-picker.svelte.js";
import { confirm, showToast } from "../../stores/ui.svelte.js";
import { WsRpcError } from "../../transport/ws-rpc.js";
import {
	deleteSessionRpc,
	forkSessionRpc,
	renameSessionRpc,
	setSessionAutoSettleRpc,
	setSessionPinnedRpc,
	setSessionSettledRpc,
	snoozeSessionRpc,
	unsnoozeSessionRpc,
} from "../../transport/ws-rpc-client.js";
import type { SessionInfo } from "../../types.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { formatSnoozeTime } from "../../utils/format.js";
import { toggleSessionRead } from "../../utils/session-read.js";
import { getSnoozePresets } from "../../utils/snooze.js";
import { getSessionActionState } from "../../utils/swipe.js";

export type SessionVerbHost = {
	rename(): void;
	select?(): void;
};

export type SessionVerb = {
	testId: string;
	label: string;
	icon?:
		| "undo"
		| "check"
		| "moon"
		| "star-off"
		| "star"
		| "circle"
		| "circle-dot"
		| "circle-check"
		| "pencil"
		| "git-fork"
		| "copy"
		| "share"
		| "settings"
		| "bug";
	hint?: string;
	disabledReason?: string | null;
	checked?: boolean;
	danger?: boolean;
	run(): void;
};
export type SessionVerbEntry = SessionVerb | { divider: true };

export function isForeignSession(session: SessionInfo): boolean {
	return (
		session.projectSlug != null && session.projectSlug !== getCurrentSlug()
	);
}

function rpcInput(session: SessionInfo) {
	const projectSlug = session.projectSlug ?? getCurrentSlug();
	return projectSlug && !isForeignSession(session)
		? { projectSlug, sessionId: session.id, originId: getBrowserClientId() }
		: null;
}

async function settle(session: SessionInfo, settled: boolean) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await setSessionSettledRpc({ ...input, settled });
		if (settled)
			showToast(`Moved “${session.title || "New Session"}” to Settled`, {
				duration: 5000,
				action: {
					label: "Undo",
					run: () => {
						void setSessionSettledRpc({ ...input, settled: false }).catch(() =>
							showToast("Couldn't undo", { variant: "error" }),
						);
					},
				},
			});
	} catch {
		showToast("Couldn't settle session", { variant: "error" });
	}
}

async function pin(session: SessionInfo, pinned: boolean) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await setSessionPinnedRpc({ ...input, pinned });
		if (pinned)
			showToast(`Pinned “${session.title || "New Session"}” to the top`, {
				duration: 5000,
				action: {
					label: "Undo",
					run: () => {
						void setSessionPinnedRpc({ ...input, pinned: false }).catch(() =>
							showToast("Couldn't undo", { variant: "error" }),
						);
					},
				},
			});
	} catch {
		showToast("Couldn't pin session", { variant: "error" });
	}
}

async function autoSettle(session: SessionInfo, disabled: boolean) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await setSessionAutoSettleRpc({ ...input, disabled });
	} catch {
		showToast("Couldn't change auto-settle", { variant: "error" });
	}
}

async function rename(session: SessionInfo, title: string) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await renameSessionRpc({
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			title,
		});
	} catch {
		showToast("Couldn't rename session", { variant: "error" });
	}
}

async function snooze(session: SessionInfo, until: number | null, now: number) {
	const input = rpcInput(session);
	if (!input) return;
	const wasSnoozed = isSessionSnoozed(session, now);
	const previousUntil = session.snoozedUntil ?? null;
	try {
		await snoozeSessionRpc({ ...input, until });
		showToast(
			until === null
				? `Snoozed “${session.title || "New Session"}” until something happens`
				: `Snoozed “${session.title || "New Session"}” until ${formatSnoozeTime(until, now)}`,
			{
				duration: 5000,
				action: {
					label: "Undo",
					run: () => {
						const undo = wasSnoozed
							? snoozeSessionRpc({ ...input, until: previousUntil })
							: unsnoozeSessionRpc(input);
						void undo.catch(() =>
							showToast("Couldn't undo", { variant: "error" }),
						);
					},
				},
			},
		);
	} catch (error) {
		showToast(
			error instanceof WsRpcError ? error.message : "Couldn't snooze session",
			{ variant: "error" },
		);
	}
}

async function unsnooze(session: SessionInfo) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await unsnoozeSessionRpc(input);
	} catch (error) {
		showToast(
			error instanceof WsRpcError ? error.message : "Couldn't unsnooze session",
			{ variant: "error" },
		);
	}
}

async function remove(session: SessionInfo) {
	const title = session.title || "New Session";
	const confirmed = await confirm(
		`Delete "${title}"? This session and its history will be permanently removed.`,
		"Delete",
	);
	if (!confirmed) return;
	const input = rpcInput(session);
	if (!input) return;
	void deleteSessionRpc(input).catch(() =>
		showToast(`Couldn't delete "${title}"`, { variant: "warn" }),
	);
}

function fork(session: SessionInfo) {
	const input = rpcInput(session);
	if (!input) return;
	void forkSessionRpc(input)
		.then((response) => {
			// The relay's switch to a fork of a session that is not open is
			// uncorrelated, so the session_switched guard ignores it. Open the
			// fork here unless that switch already did.
			if (sessionState.currentId !== response.sessionId)
				switchToSession(response.sessionId, response.projectSlug);
		})
		.catch(() => showToast("Failed to fork session", { variant: "error" }));
}

async function copyResume(session: SessionInfo) {
	const ok = await copyToClipboard(`opencode --session ${session.id}`);
	if (ok) showToast("Copied resume command");
	else
		showToast("Failed to copy — clipboard unavailable", { variant: "error" });
}

function commitTomorrow(session: SessionInfo) {
	const now = Date.now();
	const tomorrow = getSnoozePresets(now).find(
		(preset) => preset.id === "tomorrow",
	);
	if (tomorrow) void snooze(session, tomorrow.until, now);
}

export const sessionVerbActions = {
	settle,
	pin,
	autoSettle,
	rename,
	snooze,
	unsnooze,
	commitTomorrow,
	markRead: toggleSessionRead,
};

export function getSessionVerbs(
	session: SessionInfo,
	now: number,
	host: SessionVerbHost,
	snoozePlacement: "center" | "sheet",
): SessionVerbEntry[] {
	const actions = getSessionActionState(session, now);
	const markOnly = isForeignSession(session);
	const items: SessionVerbEntry[] = [];
	if (!markOnly) {
		items.push(
			{
				testId:
					session.settledAt != null
						? "session-ctx-unsettle"
						: "session-ctx-settle",
				label: session.settledAt != null ? "Un-settle" : "Settle",
				icon: session.settledAt != null ? "undo" : "check",
				hint: "s",
				disabledReason: actions.settleDisabledReason,
				run: () => {
					void settle(session, !actions.settled);
				},
			},
			{
				testId: "session-ctx-auto-settle",
				label: "Auto-settle when idle",
				checked: session.autoSettleDisabled !== true,
				run: () => {
					void autoSettle(session, session.autoSettleDisabled !== true);
				},
			},
		);
		if (actions.snoozeVisible) {
			items.push({
				testId: "session-ctx-snooze",
				label: actions.snoozed ? "Change snooze…" : "Snooze…",
				icon: "moon",
				hint: "z",
				disabledReason: actions.snoozeDisabledReason,
				run: () => openSnoozePicker(session, snoozePlacement),
			});
			if (actions.snoozed)
				items.push({
					testId: "session-ctx-unsnooze",
					label: "Unsnooze",
					icon: "undo",
					hint: "z",
					run: () => {
						void unsnooze(session);
					},
				});
		}
		items.push({
			testId:
				session.pinnedAt != null ? "session-ctx-unpin" : "session-ctx-pin",
			label: session.pinnedAt != null ? "Unpin" : "Pin to top",
			icon: session.pinnedAt != null ? "star-off" : "star",
			hint: "p",
			run: () => {
				void pin(session, !actions.pinned);
			},
		});
	}
	if (!actions.settled && !actions.snoozed)
		items.push({
			testId: session.unread
				? "session-ctx-mark-read"
				: "session-ctx-mark-unread",
			label: session.unread ? "Mark read" : "Mark unread",
			icon: session.unread ? "circle" : "circle-dot",
			hint: "u · ⌘⇧U",
			run: () => {
				void toggleSessionRead(session);
			},
		});
	if (!markOnly)
		items.push(
			{ divider: true },
			...(host.select
				? [
						{
							testId: "session-ctx-select",
							label: "Select",
							icon: "circle-check" as const,
							run: host.select,
						},
					]
				: []),
			{
				testId: "session-ctx-rename",
				label: "Rename",
				icon: "pencil",
				hint: "r",
				run: host.rename,
			},
			{
				testId: "session-ctx-fork",
				label: "Fork",
				icon: "git-fork",
				run: () => fork(session),
			},
			{
				testId: "session-ctx-copy-resume",
				label: "Copy resume command",
				icon: "copy",
				run: () => {
					void copyResume(session);
				},
			},
			{ divider: true },
			{
				testId: "session-ctx-delete",
				label: "Delete",
				danger: true,
				run: () => {
					void remove(session);
				},
			},
		);
	return items;
}
