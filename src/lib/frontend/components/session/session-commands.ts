import { getBrowserClientId } from "../../stores/client-identity.js";
import { getCurrentSlug } from "../../stores/router.svelte.js";
import { selection } from "../../stores/selection.svelte.js";
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
	label: string;
	icon?:
		| "undo"
		| "check"
		| "archive"
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
	keys?: SessionCommandKeys;
	disabledReason?: string | null;
	checked?: boolean;
	danger?: boolean;
	run(returnFocus?: () => HTMLElement | null): void;
};
export type SessionCommandEntry = SessionCommand | { divider: true };

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
	entries: readonly SessionCommandEntry[],
	event: ShortcutEvent,
): SessionCommand | undefined {
	if (event.repeat || event.altKey) return undefined;
	const command = event.metaKey || event.ctrlKey;
	const global = command && event.shiftKey;
	if (!global && (command || event.shiftKey)) return undefined;
	const key = event.key.toLowerCase();
	return entries.find(
		(entry): entry is SessionCommand =>
			"keys" in entry &&
			(global ? entry.keys?.global : entry.keys?.key) === key,
	);
}

/**
 * Runs the command `event` triggers, or shows why it is unavailable. A dialog the
 * command opens returns focus to where the key was pressed.
 */
export function runSessionCommandShortcut(
	event: ShortcutEvent & Pick<KeyboardEvent, "preventDefault" | "target">,
	entries: readonly SessionCommandEntry[],
): void {
	const command = findSessionCommandForKey(entries, event);
	if (!command) return;
	event.preventDefault();
	const origin = event.target;
	if (command.disabledReason)
		showToast(command.disabledReason, { variant: "warn" });
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

async function archive(
	session: SessionInfo,
	archived: boolean,
): Promise<boolean> {
	const input = rpcInput(session);
	if (!input) return false;
	try {
		await rpc("SetSessionArchived", { ...input, archived });
		await refreshIfForeign(session);
		return true;
	} catch (error) {
		toastFailure(
			archived ? "Couldn't archive session" : "Couldn't unarchive session",
		)(error);
		return false;
	}
}

async function autoSettle(session: SessionInfo, disabled: boolean) {
	const input = rpcInput(session);
	if (!input) return;
	try {
		await rpc("SetSessionAutoSettle", { ...input, disabled });
		await refreshIfForeign(session);
	} catch (error) {
		toastFailure("Couldn't change auto-settle")(error);
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
): Promise<boolean> {
	const title = session.title || "New Session";
	const input = rpcInput(session);
	if (!input) return false;
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
		return false;
	}
	const target = targets?.[0];
	if (!target) return false;
	let result: Awaited<ReturnType<typeof rpc<"DeleteSession">>>;
	try {
		result = await rpc("DeleteSession", target);
	} catch (error) {
		toastFailure(`Couldn't delete "${title}"`, "warn")(error);
		return false;
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
	return true;
}

function fork(session: SessionInfo) {
	const input = rpcInput(session);
	if (!input) return;
	const from = selection.scope;
	void rpc("ForkSession", input)
		.then((response) => followFork(from, response))
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
	archive,
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
		icon: session.settledAt != null ? "undo" : "check",
		keys: sessionCommandKeys.settle,
		disabledReason: actions.settleDisabledReason,
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
		icon: pinned ? "star-off" : "star",
		keys: sessionCommandKeys.pin,
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
): SessionCommandEntry[] {
	const actions = getSessionActionState(session, now);
	const items: SessionCommandEntry[] = [];
	items.push(
		getSettleCommand(session, now),
		{
			testId: "session-ctx-archive",
			label: session.archivedAt != null ? "Unarchive" : "Archive",
			icon: "archive",
			run: () => {
				void archive(session, session.archivedAt == null);
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
			...(actions.snoozed ? {} : { keys: sessionCommandKeys.snooze }),
			disabledReason: actions.snoozeDisabledReason,
			run: (returnFocus) =>
				openSnoozePicker(session, snoozePlacement, returnFocus),
		});
		if (actions.snoozed)
			items.push({
				testId: "session-ctx-unsnooze",
				label: "Unsnooze",
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
			icon: session.unread ? "circle" : "circle-dot",
			keys: sessionCommandKeys.read,
			run: () => {
				void toggleSessionRead(session);
			},
		});
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
			keys: sessionCommandKeys.rename,
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
			run: (returnFocus) => {
				void remove(session, returnFocus);
			},
		},
	);
	return items;
}
