import { getBrowserClientId } from "../../stores/client-identity.js";
import { getCurrentSlug } from "../../stores/router.svelte.js";
import { followFork, isSessionSnoozed } from "../../stores/session.svelte.js";
import { refreshListedSessions } from "../../stores/session-list.svelte.js";
import { openSnoozePicker } from "../../stores/snooze-picker.svelte.js";
import { showToast } from "../../stores/ui.svelte.js";
import { toastFailure } from "../../transport/rpc-errors.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import type { SessionInfo } from "../../types.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { formatSnoozeTime } from "../../utils/format.js";
import { toggleSessionRead } from "../../utils/session-read.js";
import { getSnoozePresets } from "../../utils/snooze.js";
import { getSessionActionState } from "../../utils/swipe.js";
import { confirmSessionDeletion } from "./session-deletion.js";

export type SessionCommandHost = {
	rename(): void;
	select?(): void;
};

export type SessionCommand = {
	testId: string;
	section: "triage" | "manage" | "danger";
	label: string;
	shortLabel?: string;
	tag?: string;
	detail?: string | null;
	emphasis?: "primary" | undefined;
	icon:
		| "undo"
		| "check"
		| "moon"
		| "pin-off"
		| "pin"
		| "circle"
		| "circle-dot"
		| "circle-check"
		| "pencil"
		| "git-fork"
		| "copy"
		| "zap"
		| "trash-2"
		| "share"
		| "settings"
		| "bug";
	keys?: SessionCommandKeys;
	disabledReason?: string | null;
	checked?: boolean;
	danger?: boolean;
	run(returnFocus?: () => HTMLElement | null): void;
};
export type SessionCommandEntry = Omit<SessionCommand, "section"> & {
	section: SessionCommand["section"] | "extras";
};

/**
 * Each command's keys, defined once. `key` acts on the focused list row, or on the
 * open session from the transcript; `global` works anywhere with ⌘⇧ (Ctrl+Shift).
 */
export type SessionCommandKeys = { key: string; global?: string };
export const sessionCommandKeys = {
	settle: { key: "s", global: "e" },
	snooze: { key: "z" },
	pin: { key: "p" },
	read: { key: "u", global: "u" },
	rename: { key: "r" },
} as const satisfies Record<string, SessionCommandKeys>;

export function globalKeyHint(global: string): string {
	return `⌘⇧${global.toUpperCase()}`;
}

export function sessionCommandKeysHint({
	key,
	global,
}: SessionCommandKeys): string {
	return global ? `${key} · ${globalKeyHint(global)}` : key;
}

type ShortcutEvent = Pick<
	KeyboardEvent,
	"key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat"
>;

/** The command among `entries` that `event` triggers, if any. */
export function findSessionCommandForKey(
	entries: readonly SessionCommand[],
	event: ShortcutEvent,
): SessionCommand | undefined {
	if (event.repeat || event.altKey) return undefined;
	const command = event.metaKey || event.ctrlKey;
	const global = command && event.shiftKey;
	if (!global && (command || event.shiftKey)) return undefined;
	const key = event.key.toLowerCase();
	return entries.find(
		(entry) => (global ? entry.keys?.global : entry.keys?.key) === key,
	);
}

/**
 * Runs the command `event` triggers, or shows why it is unavailable. A dialog the
 * command opens returns focus to where the key was pressed.
 */
export function runSessionCommandShortcut(
	event: ShortcutEvent & Pick<KeyboardEvent, "preventDefault" | "target">,
	entries: readonly SessionCommand[],
): void {
	const command = findSessionCommandForKey(entries, event);
	if (!command) return;
	event.preventDefault();
	const origin = event.target;
	if (command.disabledReason)
		showToast(command.disabledReason, { variant: "pinned" });
	else command.run(() => (origin instanceof HTMLElement ? origin : null));
}

function isForeignSession(session: SessionInfo): boolean {
	return (
		session.projectSlug != null && session.projectSlug !== getCurrentSlug()
	);
}

// The server routes each call to the session's project.
function rpcInput(session: SessionInfo) {
	return { sessionId: session.id, originId: getBrowserClientId() };
}

// This socket only hears live updates for its own project.
function refreshIfForeign(session: SessionInfo): Promise<void> {
	return isForeignSession(session)
		? refreshListedSessions()
		: Promise.resolve();
}

async function settle(session: SessionInfo, settled: boolean) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await rpc("SetSessionSettled", { ...input, settled });
		await refreshIfForeign(session);
		if (settled)
			showToast(`Moved “${session.title || "New Session"}” to Settled`, {
				duration: 5000,
				action: {
					label: "Undo",
					run: () => {
						void rpc("SetSessionSettled", { ...input, settled: false })
							.then(() => refreshIfForeign(session))
							.catch(toastFailure("Couldn't undo"));
					},
				},
			});
	} catch (error) {
		toastFailure("Couldn't settle session")(error);
	}
}

async function pin(session: SessionInfo, pinned: boolean) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await rpc("SetSessionPinned", { ...input, pinned });
		await refreshIfForeign(session);
		if (pinned)
			showToast(`Pinned “${session.title || "New Session"}” to the top`, {
				duration: 5000,
				action: {
					label: "Undo",
					run: () => {
						void rpc("SetSessionPinned", { ...input, pinned: false })
							.then(() => refreshIfForeign(session))
							.catch(toastFailure("Couldn't undo"));
					},
				},
			});
	} catch (error) {
		toastFailure("Couldn't pin session")(error);
	}
}

async function autoSettle(session: SessionInfo, disabled: boolean) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		const outlook = await rpc("SetSessionAutoSettle", { ...input, disabled });
		// The switch settles from the write reply, without waiting for the list.
		void refreshIfForeign(session).catch(
			toastFailure("Couldn't change auto-settle"),
		);
		return outlook;
	} catch (error) {
		toastFailure("Couldn't change auto-settle")(error);
		return undefined;
	}
}

async function rename(session: SessionInfo, title: string) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await rpc("RenameSession", {
			sessionId: input.sessionId,
			title,
		});
		await refreshIfForeign(session);
	} catch (error) {
		toastFailure("Couldn't rename session")(error);
	}
}

async function snooze(session: SessionInfo, until: number | null, now: number) {
	const input = rpcInput(session);
	if (!input) return;
	const wasSnoozed = isSessionSnoozed(session, now);
	const previousUntil = session.snoozedUntil ?? null;
	try {
		await rpc("SnoozeSession", { ...input, until });
		await refreshIfForeign(session);
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
							? rpc("SnoozeSession", { ...input, until: previousUntil })
							: rpc("UnsnoozeSession", input);
						void undo
							.then(() => refreshIfForeign(session))
							.catch(toastFailure("Couldn't undo"));
					},
				},
			},
		);
	} catch (error) {
		toastFailure("Couldn't snooze session")(error);
	}
}

async function unsnooze(session: SessionInfo) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await rpc("UnsnoozeSession", input);
		await refreshIfForeign(session);
	} catch (error) {
		toastFailure("Couldn't unsnooze session")(error);
	}
}

async function remove(
	session: SessionInfo,
	returnFocus?: () => HTMLElement | null,
) {
	const title = session.title || "New Session";
	const input = rpcInput(session);
	if (!input) return;
	let targets: Awaited<ReturnType<typeof confirmSessionDeletion>>;
	try {
		targets = await confirmSessionDeletion(
			[input],
			`Delete "${title}"? This session and its history will be permanently removed.`,
			returnFocus,
		);
	} catch {
		showToast("Couldn't inspect worktrees. The session was kept.", {
			variant: "warn",
		});
		return;
	}
	const target = targets?.[0];
	if (!target) return;
	let result: Awaited<ReturnType<typeof rpc<"DeleteSession">>>;
	try {
		result = await rpc("DeleteSession", target);
	} catch (error) {
		toastFailure(`Couldn't delete "${title}"`, "warn")(error);
		return;
	}
	void refreshIfForeign(session).catch(() =>
		showToast("Session deleted. Couldn't refresh the session list.", {
			variant: "warn",
		}),
	);
	if (result.worktreeWarnings?.length)
		showToast(`Session deleted. ${result.worktreeWarnings.join("; ")}`, {
			variant: "warn",
		});
}

function fork(session: SessionInfo) {
	const input = rpcInput(session);
	if (!input) return;
	void rpc("ForkSession", input)
		.then(followFork)
		.catch(toastFailure("Failed to fork session"));
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

export const sessionCommandActions = {
	settle,
	remove,
	pin,
	autoSettle,
	rename,
	snooze,
	unsnooze,
	commitTomorrow,
	markRead: toggleSessionRead,
};

export function getSettleCommand(
	session: SessionInfo,
	now: number,
): SessionCommand {
	const actions = getSessionActionState(session, now);
	return {
		testId:
			session.settledAt != null ? "session-ctx-unsettle" : "session-ctx-settle",
		label: session.settledAt != null ? "Un-settle" : "Settle",
		section: "triage",
		icon: session.settledAt != null ? "undo" : "check",
		keys: sessionCommandKeys.settle,
		disabledReason: actions.settleDisabledReason,
		detail: actions.settleDisabledReason,
		emphasis: !actions.pinned && !actions.settled ? "primary" : undefined,
		run: () => {
			void settle(session, !actions.settled);
		},
	};
}

export function getPinCommand(session: SessionInfo): SessionCommand {
	const pinned = session.pinnedAt != null;
	return {
		testId: pinned ? "session-ctx-unpin" : "session-ctx-pin",
		label: pinned ? "Unpin" : "Pin to top",
		shortLabel: pinned ? "Unpin" : "Pin",
		section: "triage",
		icon: pinned ? "pin-off" : "pin",
		keys: sessionCommandKeys.pin,
		emphasis: pinned ? "primary" : undefined,
		run: () => {
			void pin(session, !pinned);
		},
	};
}

/**
 * The one command that moves this session along: Unpin while it is pinned (a
 * pinned session can't be settled), otherwise Settle or Un-settle.
 */
export function getPrimaryCommand(
	session: SessionInfo,
	now: number,
): SessionCommand {
	return session.pinnedAt != null
		? getPinCommand(session)
		: getSettleCommand(session, now);
}

export function getSessionCommands(
	session: SessionInfo,
	now: number,
	host: SessionCommandHost,
	snoozePlacement: "center" | "sheet",
): SessionCommand[] {
	const actions = getSessionActionState(session, now);
	const items: SessionCommand[] = [];
	items.push(getSettleCommand(session, now), {
		testId: "session-ctx-auto-settle",
		label: "Auto-settle when idle",
		shortLabel: "Auto-settle",
		section: "triage",
		icon: "zap",
		checked: session.autoSettleDisabled !== true,
		run: () => {
			void autoSettle(session, session.autoSettleDisabled !== true);
		},
	});
	if (actions.snoozeVisible) {
		items.push({
			testId: "session-ctx-snooze",
			label: actions.snoozed ? "Change snooze…" : "Snooze…",
			shortLabel: "Snooze",
			section: "triage",
			icon: "moon",
			...(actions.snoozed ? {} : { keys: sessionCommandKeys.snooze }),
			disabledReason: actions.snoozeDisabledReason,
			detail:
				actions.snoozeDisabledReason ??
				(actions.snoozed
					? session.snoozedUntil == null
						? "No timer"
						: `until ${formatSnoozeTime(session.snoozedUntil, now)}`
					: null),
			run: (returnFocus) =>
				openSnoozePicker(session, snoozePlacement, returnFocus),
		});
		if (actions.snoozed)
			items.push({
				testId: "session-ctx-unsnooze",
				label: "Unsnooze",
				section: "triage",
				icon: "undo",
				keys: sessionCommandKeys.snooze,
				run: () => {
					void unsnooze(session);
				},
			});
	}
	items.push(getPinCommand(session));
	if (!actions.settled && !actions.snoozed)
		items.push({
			testId: session.unread
				? "session-ctx-mark-read"
				: "session-ctx-mark-unread",
			label: session.unread ? "Mark read" : "Mark unread",
			shortLabel: session.unread ? "Read" : "Unread",
			section: "triage",
			icon: session.unread ? "circle" : "circle-dot",
			keys: sessionCommandKeys.read,
			run: () => {
				void toggleSessionRead(session);
			},
		});
	items.push(
		...(host.select
			? [
					{
						testId: "session-ctx-select",
						label: "Select",
						section: "manage" as const,
						icon: "circle-check" as const,
						run: host.select,
					},
				]
			: []),
		{
			testId: "session-ctx-rename",
			label: "Rename",
			section: "manage",
			icon: "pencil",
			keys: sessionCommandKeys.rename,
			run: host.rename,
		},
		{
			testId: "session-ctx-fork",
			label: "Fork",
			section: "manage",
			icon: "git-fork",
			run: () => fork(session),
		},
		{
			testId: "session-ctx-copy-resume",
			label: "Copy resume command",
			shortLabel: "Copy resume",
			section: "manage",
			icon: "copy",
			run: () => {
				void copyResume(session);
			},
		},
		{
			testId: "session-ctx-delete",
			label: "Delete",
			shortLabel: "Delete…",
			section: "danger",
			icon: "trash-2",
			danger: true,
			run: (returnFocus) => {
				void remove(session, returnFocus);
			},
		},
	);
	return items;
}
