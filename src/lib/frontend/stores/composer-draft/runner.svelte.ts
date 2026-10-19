import { untrack } from "svelte";
import { connectionState } from "../../transport/connection-status.svelte.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import { getBrowserClientId } from "../client-identity.js";
import {
	type DraftCommand,
	type DraftEvent,
	initialState,
	type ReloadDraft,
	step,
} from "./state.js";

const NEW_SESSION_DRAFT_KEY = "conduit:new-session-draft";
const RELOAD_DRAFT_KEY = "conduit-reload-drafts";

export const inputSyncState = $state({
	received: null as Extract<
		DraftEvent,
		{ _tag: "ServerTextReceived" | "SubscriptionStarted" }
	> | null,
});

// An initial snapshot and buffered live changes can arrive in one browser task.
// Keep every transition even when Svelte batches the reactive notification.
const inputSyncEvents: DraftEvent[] = [];

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
	sessionId: string;
	text?: string | undefined;
	initial?: boolean;
}): void {
	inputSyncState.received = {
		_tag: "ServerTextReceived",
		sessionId: msg.sessionId,
		...(msg.text === undefined ? {} : { text: msg.text }),
		...(msg.initial ? { initial: true } : {}),
	};
	inputSyncEvents.push(inputSyncState.received);
}

export function handleInputDraftStarted(sessionId: string): void {
	inputSyncState.received = { _tag: "SubscriptionStarted", sessionId };
	inputSyncEvents.push(inputSyncState.received);
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
						dispatch({ _tag: "SyncDue" });
					}, command.delay);
					break;
				case "SyncDraft": {
					if (connectionState.status !== "connected") {
						dispatch({ _tag: "SyncFailed" });
						break;
					}
					const sent = rpc("SyncInputDraft", {
						sessionId: command.sessionId,
						text: command.text,
						originId: getBrowserClientId(),
					}).then(
						() => {
							dispatch({
								_tag: "SyncSucceeded",
								sessionId: command.sessionId,
								text: command.text,
							});
						},
						(error: unknown) => {
							dispatch({ _tag: "SyncFailed" });
							throw error;
						},
					);
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
			const entries: unknown = JSON.parse(saved);
			if (Array.isArray(entries))
				dispatch({
					_tag: "ReloadRestored",
					entries: entries.filter(
						(entry: unknown): entry is ReloadDraft =>
							typeof entry === "object" &&
							entry !== null &&
							"key" in entry &&
							typeof entry.key === "string" &&
							"text" in entry &&
							typeof entry.text === "string" &&
							"acked" in entry &&
							typeof entry.acked === "string",
					),
				});
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
			}),
		);
	});

	$effect(() => {
		const received = inputSyncState.received;
		untrack(() => {
			const events = inputSyncEvents.splice(0);
			if (received) for (const event of events) dispatch(event);
		});
	});

	$effect(() => {
		if (connectionState.status !== "connected")
			untrack(() => {
				if (state.sessionId)
					dispatch({ _tag: "SubscriptionStarted", sessionId: state.sessionId });
			});
	});

	$effect(() => {
		const hidden = () => {
			dispatch({ _tag: "Hidden" });
		};
		const visibilityChanged = () => {
			if (document.visibilityState === "hidden") hidden();
		};
		window.addEventListener("pagehide", hidden);
		document.addEventListener("visibilitychange", visibilityChanged);
		return () => {
			window.removeEventListener("pagehide", hidden);
			document.removeEventListener("visibilitychange", visibilityChanged);
			cancelSync();
		};
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
							_tag: "Flush",
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
		edited(value?: string) {
			// The input listener runs before Svelte updates bind:value.
			if (value !== undefined) dispatch({ _tag: "TextChanged", text: value });
			dispatch({ _tag: "LocalEdited" });
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
