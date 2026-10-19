import { untrack } from "svelte";
import type { InputDraftKey } from "../../../contracts/ws-rpc.js";
import { connectionState } from "../../transport/connection-status.svelte.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import { getBrowserClientId } from "../client-identity.js";
import {
	DRAFT_PROJECT_PARAM,
	getCurrentRoute,
	getCurrentSearchParams,
	noteDraftNavigation,
	replaceRoute,
} from "../router.svelte.js";
import {
	type DraftCommand,
	type DraftEvent,
	draftKeyId,
	initialState,
	type ReloadDraft,
	step,
} from "./state.js";

const LEGACY_DRAFT_KEY = "conduit:new-session-draft";
const RELOAD_DRAFT_KEY = "conduit-reload-drafts";
export const inputSyncState = $state({
	received: null as Extract<
		DraftEvent,
		{
			_tag:
				| "ServerTextReceived"
				| "SubscriptionStarted"
				| "Promoted"
				| "Retired"
				| "Discarded";
		}
	> | null,
});
// Preserve initial and live transitions when Svelte batches a notification.
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
	key: InputDraftKey;
	text?: string | undefined;
	projectId?: string | undefined;
	initial?: boolean;
}): void {
	inputSyncState.received = {
		_tag: "ServerTextReceived",
		key: msg.key,
		...(msg.text === undefined ? {} : { text: msg.text }),
		...(msg.projectId === undefined ? {} : { projectId: msg.projectId }),
		...(msg.initial ? { initial: true } : {}),
	};
	inputSyncEvents.push(inputSyncState.received);
}
export function handleInputDraftStarted(key: InputDraftKey): void {
	inputSyncState.received = { _tag: "SubscriptionStarted", key };
	inputSyncEvents.push(inputSyncState.received);
}
export function handleDraftPromoted(
	key: InputDraftKey,
	sessionId: string,
	text: string,
): void {
	inputSyncState.received = {
		_tag: "Promoted",
		key,
		sessionId,
		text,
		freshDraftId: crypto.randomUUID(),
	};
	inputSyncEvents.push(inputSyncState.received);
}
export function handleDraftRetired(
	key: InputDraftKey,
	sessionId: string,
): void {
	inputSyncState.received = {
		_tag: "Retired",
		key,
		sessionId,
		freshDraftId: crypto.randomUUID(),
	};
	inputSyncEvents.push(inputSyncState.received);
}
/** Explicit sidebar discard also clears pending local edits for this key. */
export function handleDraftDiscarded(key: InputDraftKey): void {
	inputSyncState.received = { _tag: "Discarded", key };
	inputSyncEvents.push(inputSyncState.received);
}

export function createComposerDraft(options: {
	key: () => InputDraftKey | null;
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
					if (
						connectionState.status !== "connected" ||
						("draft" in command.key && !command.projectSlug)
					) {
						dispatch({ _tag: "SyncFailed" });
						break;
					}
					const sent = rpc("SyncInputDraft", {
						key: command.key,
						text: command.text,
						...(command.projectSlug
							? { projectSlug: command.projectSlug }
							: {}),
						originId: getBrowserClientId(),
					}).then(
						() => {
							dispatch({
								_tag: "SyncSucceeded",
								key: command.key,
								text: command.text,
								projectSlug: command.projectSlug,
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
				case "NavigateDraft": {
					if (!("draft" in command.key)) break;
					const params = getCurrentSearchParams();
					const project = command.projectSlug ?? options.projectSlug();
					if (project) params.set(DRAFT_PROJECT_PARAM, project);
					replaceRoute(
						`/draft/${command.key.draft}${params.size ? `?${params}` : ""}`,
					);
					break;
				}
				case "NavigateSession": {
					// The sender is already there via selection.follow; a same-path
					// replace would drop the scope params.
					const route = getCurrentRoute();
					if (route.page !== "chat" || route.sessionId !== command.sessionId)
						replaceRoute(`/s/${command.sessionId}`);
					break;
				}
				case "StartDraft": {
					const params = getCurrentSearchParams();
					const project = options.projectSlug();
					if (project) params.set(DRAFT_PROJECT_PARAM, project);
					replaceRoute(`/new${params.size ? `?${params}` : "?"}`);
					break;
				}
				case "ApplyProject": {
					const route = getCurrentRoute();
					if (
						!state.key ||
						!("draft" in state.key) ||
						route.page !== "chat" ||
						route.draftId !== state.key.draft
					)
						break;
					const params = getCurrentSearchParams();
					if (params.get(DRAFT_PROJECT_PARAM) === command.projectSlug) break;
					params.set(DRAFT_PROJECT_PARAM, command.projectSlug);
					replaceRoute(`/draft/${state.key.draft}?${params}`);
					break;
				}
				case "RemoveLegacyDraft":
					try {
						if (localStorage.getItem(LEGACY_DRAFT_KEY) === command.text)
							localStorage.removeItem(LEGACY_DRAFT_KEY);
					} catch {
						/* Storage restrictions must not interrupt typing. */
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
		// No key (the phone list) keeps the last draft; a session key ends it.
		if (state.key)
			noteDraftNavigation(
				"draft" in state.key ? { id: state.key.draft, text: state.text } : null,
			);
		return { commands, pending: execute(commands) };
	}
	try {
		const saved = sessionStorage.getItem(RELOAD_DRAFT_KEY);
		if (saved) {
			const entries: unknown = JSON.parse(saved);
			if (Array.isArray(entries)) {
				const restored: ReloadDraft[] = [];
				for (const entry of entries as unknown[]) {
					if (
						typeof entry !== "object" ||
						entry === null ||
						!("key" in entry) ||
						!("text" in entry) ||
						typeof entry.text !== "string" ||
						!("acked" in entry) ||
						typeof entry.acked !== "string"
					)
						continue;
					// Backups from .4 contained session ids only. Tuple backups predate acked.
					const key: unknown =
						typeof entry.key === "string" && entry.key
							? { session: entry.key }
							: entry.key;
					if (typeof key !== "object" || key === null) continue;
					if (
						"session" in key &&
						typeof key.session === "string" &&
						key.session
					)
						restored.push({
							key: { session: key.session },
							text: entry.text,
							acked: entry.acked,
						});
					else if ("draft" in key && typeof key.draft === "string" && key.draft)
						restored.push({
							key: { draft: key.draft },
							text: entry.text,
							acked: entry.acked,
						});
				}
				dispatch({ _tag: "ReloadRestored", entries: restored });
			}
			sessionStorage.removeItem(RELOAD_DRAFT_KEY);
		}
	} catch {
		/* A restricted browser can still use server draft sync. */
	}
	try {
		const legacy = localStorage.getItem(LEGACY_DRAFT_KEY);
		if (legacy)
			dispatch({
				_tag: "LegacyDraftFound",
				key: { draft: crypto.randomUUID() },
				text: legacy,
			});
		else if (legacy === "") localStorage.removeItem(LEGACY_DRAFT_KEY);
	} catch {
		/* Migration waits until storage is accessible. */
	}
	$effect(() => {
		const key = options.key();
		const projectSlug = options.projectSlug();
		const projectChosen = getCurrentSearchParams().has(DRAFT_PROJECT_PARAM);
		untrack(() =>
			dispatch({ _tag: "KeySwitched", key, projectSlug, projectChosen }),
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
				if (state.key)
					dispatch({ _tag: "SubscriptionStarted", key: state.key });
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
			dispatch({
				_tag: "KeySwitched",
				key: null,
				projectSlug: null,
				projectChosen: false,
			});
			cancelSync();
		};
	});
	$effect(() =>
		registerInputDraftPersistence(async () => {
			cancelSync();
			let savedText: string;
			let savedKey: string | null;
			let savedProject: string | null;
			do {
				savedText = state.text;
				savedKey = state.key ? draftKeyId(state.key) : null;
				savedProject = state.projectSlug;
				if (connectionState.status === "connected")
					await Promise.all(dispatch({ _tag: "Flush" }).pending);
			} while (
				state.text !== savedText ||
				(state.key ? draftKeyId(state.key) : null) !== savedKey ||
				state.projectSlug !== savedProject
			);
			const hasAttachments = options.hasAttachments();
			dispatch({ _tag: "PersistBeforeReload", hasAttachments });
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
			if (value !== undefined) dispatch({ _tag: "TextChanged", text: value });
			dispatch({ _tag: "LocalEdited" });
		},
		clear() {
			dispatch({ _tag: "Cleared" });
		},
		sendStarted(clear: boolean) {
			const unsent = { text: state.text, key: state.key ?? null };
			dispatch({ _tag: "SendStarted", clear });
			return unsent;
		},
		created(
			unsent: { key: InputDraftKey | null; text: string },
			sessionId: string,
		) {
			if (unsent.key)
				dispatch({
					_tag: "Promoted",
					key: unsent.key,
					text: unsent.text,
					sessionId,
					freshDraftId: crypto.randomUUID(),
				});
		},
		sendFailed(
			unsent: { text: string; key: InputDraftKey | null },
			sentTo: string | null,
			restore: boolean,
			alreadySent = false,
		): boolean {
			const before = state;
			dispatch({
				_tag: "SendFailed",
				...unsent,
				sentTo,
				hasAttachments: options.hasAttachments(),
				restore,
				alreadySent,
			});
			return state.text !== before.text;
		},
		sendSucceeded(
			sentTo: string | null,
			steer: boolean,
			clear: boolean,
		): boolean {
			const { commands } = dispatch({
				_tag: "SendSucceeded",
				sentTo,
				steer,
				clear,
			});
			return commands.some((command) => command._tag === "CancelSync");
		},
		sideThreadSent(
			parentSessionId: string,
			sentText: string,
			attachmentsUnchanged: boolean,
		) {
			const active =
				state.key &&
				"session" in state.key &&
				state.key.session === parentSessionId;
			const { commands } = dispatch({
				_tag: "SideThreadSent",
				parentSessionId,
				text: sentText,
				attachmentsUnchanged,
			});
			return { cleared: commands.length > 0, active: Boolean(active) };
		},
	};
}
