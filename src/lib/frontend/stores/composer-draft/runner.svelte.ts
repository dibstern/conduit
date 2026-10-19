import { untrack } from "svelte";
import { connectionState } from "../../transport/connection-status.svelte.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import { getBrowserClientId } from "../client-identity.js";
import {
	type DraftCommand,
	type DraftEvent,
	initialState,
	step,
} from "./state.js";

const NEW_SESSION_DRAFT_KEY = "conduit:new-session-draft";
const RELOAD_DRAFT_KEY = "conduit-reload-drafts";

export const inputSyncState = $state({
	text: "",
	lastFrom: "",
	lastUpdated: 0,
	reloadPending: false,
});

let persistInputDraftHook: (() => Promise<boolean>) | undefined;

export function registerInputDraftPersistence(
	persist: () => Promise<boolean>,
): () => void {
	persistInputDraftHook = persist;
	return () => {
		if (persistInputDraftHook === persist) persistInputDraftHook = undefined;
	};
}

/** False defers reload to keep pending attachments in the mounted composer. */
export async function persistInputDraft(): Promise<boolean> {
	return (await persistInputDraftHook?.()) ?? true;
}

export function handleInputSyncReceived(msg: {
	text?: string | undefined;
	from?: string | undefined;
}): void {
	inputSyncState.text = msg.text ?? "";
	inputSyncState.lastFrom = msg.from ?? "";
	inputSyncState.lastUpdated = Date.now();
}

export function createComposerDraft(options: {
	sessionId: () => string | null;
	projectSlug: () => string | null;
	hasAttachments: () => boolean;
}) {
	let state = initialState();
	let text = $state("");
	let syncTimer: ReturnType<typeof setTimeout> | null = null;

	function cancelSync() {
		if (syncTimer) clearTimeout(syncTimer);
		syncTimer = null;
	}

	function execute(commands: DraftCommand[]): Promise<void>[] {
		const pending: Promise<void>[] = [];
		for (const command of commands) {
			switch (command._tag) {
				case "CancelSync":
					cancelSync();
					break;
				case "ScheduleSync":
					cancelSync();
					syncTimer = setTimeout(() => {
						syncTimer = null;
						dispatch({ _tag: "SyncDue", sessionId: options.sessionId() });
					}, command.delay);
					break;
				case "SyncDraft": {
					const sent = rpc("SyncInputDraft", {
						sessionId: command.sessionId,
						text: command.text,
						originId: getBrowserClientId(),
					}).then(() => undefined);
					void sent.catch(() => undefined);
					pending.push(sent);
					break;
				}
				case "WriteNewSessionDraft":
				case "ClearNewSessionDraft":
					try {
						if (command._tag === "WriteNewSessionDraft" && command.text)
							localStorage.setItem(NEW_SESSION_DRAFT_KEY, command.text);
						else localStorage.removeItem(NEW_SESSION_DRAFT_KEY);
					} catch {
						// Storage can be unavailable; typing still works.
					}
					break;
				case "SaveReloadBackup":
					sessionStorage.setItem(
						RELOAD_DRAFT_KEY,
						JSON.stringify(command.entries),
					);
					break;
				default:
					command satisfies never;
			}
		}
		return pending;
	}

	function dispatch(event: DraftEvent) {
		const [next, commands] = step(state, event);
		state = next;
		text = state.text;
		return { commands, pending: execute(commands) };
	}

	function readNewSessionDraft(): string {
		try {
			return localStorage.getItem(NEW_SESSION_DRAFT_KEY) ?? "";
		} catch {
			return "";
		}
	}

	try {
		const saved = sessionStorage.getItem(RELOAD_DRAFT_KEY);
		if (saved) {
			for (const entry of JSON.parse(saved) as [string, string][]) {
				dispatch({ _tag: "ReloadRestored", entries: [entry] });
			}
			sessionStorage.removeItem(RELOAD_DRAFT_KEY);
		}
	} catch {
		// A restricted browser can still use server draft sync.
	}

	$effect(() => {
		const sessionId = options.sessionId();
		untrack(() =>
			dispatch({
				_tag: "SessionSwitched",
				sessionId,
				newSessionText: sessionId ? "" : readNewSessionDraft(),
				now: Date.now(),
			}),
		);
	});

	$effect(() => {
		if (inputSyncState.lastUpdated <= state.lastSyncApplied) return;
		dispatch({
			_tag: "ServerTextReceived",
			text: inputSyncState.text,
			updatedAt: inputSyncState.lastUpdated,
			reloadPending: inputSyncState.reloadPending,
			now: Date.now(),
		});
	});

	$effect(() =>
		registerInputDraftPersistence(async () => {
			cancelSync();
			let savedText: string;
			let savedSessionId: string | null;
			do {
				savedText = state.text;
				savedSessionId = options.sessionId();
				// Offline reloads use the backup without calling an incompatible daemon.
				if (connectionState.status === "connected") {
					await Promise.all(
						dispatch({
							_tag: "SyncDue",
							sessionId: savedSessionId,
							serverOnly: true,
						}).pending,
					);
				}
			} while (
				state.text !== savedText ||
				options.sessionId() !== savedSessionId
			);
			const hasAttachments = options.hasAttachments();
			dispatch({
				_tag: "PersistBeforeReload",
				sessionId: options.sessionId(),
				hasAttachments,
			});
			return !hasAttachments;
		}),
	);

	return {
		get text() {
			return text;
		},
		set text(value: string) {
			dispatch({ _tag: "TextChanged", text: value });
		},
		edited() {
			dispatch({ _tag: "LocalEdited", now: Date.now() });
		},
		clear() {
			dispatch({ _tag: "Cleared", sessionId: options.sessionId() });
		},
		sendStarted(clear: boolean): string {
			const unsent = state.text;
			dispatch({ _tag: "SendStarted", sessionId: options.sessionId(), clear });
			return unsent;
		},
		sendFailed(
			unsent: string,
			sentTo: string | null,
			projectSlug: string | null,
			restore: boolean,
		): boolean {
			const before = state;
			dispatch({
				_tag: "SendFailed",
				text: unsent,
				sentTo,
				sessionId: options.sessionId(),
				sameProject: options.projectSlug() === projectSlug,
				hasAttachments: options.hasAttachments(),
				restore,
			});
			return state !== before;
		},
		sendSucceeded(
			sentTo: string | null,
			steer: boolean,
			clear: boolean,
		): boolean {
			const { commands } = dispatch({
				_tag: "SendSucceeded",
				sentTo,
				sessionId: options.sessionId(),
				steer,
				clear,
			});
			return commands.some((command) => command._tag === "CancelSync");
		},
		sessionCreated() {
			dispatch({ _tag: "SessionCreated" });
		},
		sideThreadSent(
			parentSessionId: string,
			sentText: string,
			attachmentsUnchanged: boolean,
		) {
			const active = state.sessionId === parentSessionId;
			const { commands } = dispatch({
				_tag: "SideThreadSent",
				parentSessionId,
				text: sentText,
				attachmentsUnchanged,
			});
			return { cleared: commands.length > 0, active };
		},
	};
}
