import { Schema } from "effect";
import { untrack } from "svelte";
import {
	DraftAttachmentRejected,
	type InputDraftKey,
} from "../../../contracts/ws-rpc.js";
import { connectionState } from "../../transport/connection-status.svelte.js";
import { failureLine, toastFailure } from "../../transport/rpc-errors.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import { getBrowserClientId } from "../client-identity.js";
import {
	DRAFT_PROJECT_PARAM,
	getCurrentRoute,
	getCurrentSearchParams,
	replaceRoute,
} from "../router.svelte.js";
import {
	attachmentsReady,
	type DraftAttachmentItem,
	type DraftCommand,
	type DraftEvent,
	type DraftState,
	draftKeyId,
	hasContent,
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
	attachments?: readonly {
		id: string;
		name: string;
		mime: string;
		size: number;
		hash: string;
	}[];
}): void {
	if (msg.attachments)
		inputSyncEvents.push({
			_tag: "AttachmentsReceived",
			key: msg.key,
			attachments: msg.attachments,
		});
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
}) {
	let state = initialState();
	let text = $state("");
	let sendPick = $state<DraftState["sendPick"]>();
	let sending = $state(false);
	let content = $state(false);
	let ready = $state(true);
	let attachments = $state<readonly DraftAttachmentItem[]>([]);
	let syncTimer: ReturnType<typeof setTimeout> | null = null;
	function cancelSync() {
		if (syncTimer) clearTimeout(syncTimer);
		syncTimer = null;
	}
	function execute(commands: DraftCommand[]): Promise<void>[] {
		const pending: Promise<void>[] = [];
		for (const command of commands) {
			switch (command._tag) {
				case "AddAttachment": {
					const { key, attachment } = command;
					if (connectionState.status !== "connected") {
						dispatch({
							_tag: "AttachmentAddFailed",
							key,
							id: attachment.id,
							error: "Connection lost",
						});
						break;
					}
					const sent = rpc("AddDraftAttachment", { key, ...attachment }).then(
						(result) => {
							dispatch({
								_tag: "AttachmentAddAcknowledged",
								key,
								id: attachment.id,
								result,
							});
						},
						(error: unknown) => {
							dispatch({
								_tag: "AttachmentAddFailed",
								key,
								id: attachment.id,
								error: failureLine(
									error,
									error instanceof Error
										? error.message
										: "Attachment save failed",
								),
								...(Schema.is(DraftAttachmentRejected)(error)
									? { retryOnReconnect: false as const }
									: {}),
							});
						},
					);
					pending.push(sent);
					break;
				}
				case "RemoveAttachment": {
					const { key, id } = command;
					const projectSlug = options.projectSlug();
					const sent = rpc("RemoveDraftAttachment", {
						key,
						id,
						...(projectSlug ? { projectSlug } : {}),
					}).then(
						() => {
							dispatch({ _tag: "AttachmentRemoveAcknowledged", key, id });
						},
						(error: unknown) => {
							dispatch({
								_tag: "AttachmentRemoveFailed",
								key,
								id,
								error: failureLine(
									error,
									error instanceof Error
										? error.message
										: "Attachment removal failed",
								),
							});
						},
					);
					pending.push(sent);
					break;
				}
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
		content = state.key ? hasContent(state, state.key) : false;
		ready = state.key ? attachmentsReady(state, state.key) : true;
		text = state.text;
		sendPick = state.sendPick;
		sending =
			state.key !== null &&
			state.key !== undefined &&
			state.inFlight.has(draftKeyId(state.key));
		attachments = state.key
			? (state.attachments.get(draftKeyId(state.key)) ?? [])
			: [];
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
		const connected = connectionState.status === "connected";
		untrack(() => {
			dispatch({ _tag: connected ? "Reconnected" : "ConnectionLost" });
			if (!connected) {
				if (state.key)
					dispatch({ _tag: "SubscriptionStarted", key: state.key });
			}
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
			const deferReload =
				state.inFlight.size > 0 ||
				[...state.attachments.values()].some((items) =>
					items.some(
						(item) => item.status === "saving" || item.status === "failed",
					),
				);
			dispatch({ _tag: "PersistBeforeReload", hasAttachments: deferReload });
			return !deferReload;
		}),
	);
	return {
		get key() {
			return state.key ?? null;
		},
		get sending() {
			return sending;
		},
		get attachments() {
			return attachments.filter((item) => item.status !== "removing");
		},
		get attachmentsReady() {
			return ready;
		},
		get hasContent() {
			return content;
		},
		hasContentFor(key: InputDraftKey) {
			return hasContent(state, key);
		},
		addAttachment(
			key: InputDraftKey,
			attachment: {
				id: string;
				name: string;
				mime: string;
				size: number;
				dataUrl: string;
				projectSlug?: string;
			},
		) {
			dispatch({ _tag: "AttachmentAdded", key, attachment });
		},
		removeAttachment(id: string) {
			if (state.key)
				dispatch({ _tag: "AttachmentRemoved", key: state.key, id });
		},
		retryAttachment(id: string) {
			if (state.key)
				dispatch({ _tag: "AttachmentRetryRequested", key: state.key, id });
		},
		attachmentsAccepted(key: InputDraftKey, ids: readonly string[]) {
			dispatch({ _tag: "SendAttachmentsAccepted", key, ids });
		},
		get sendPick() {
			return sendPick;
		},
		set sendPick(pick: DraftState["sendPick"]) {
			dispatch({ _tag: "SendPickChanged", pick });
		},
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
			if (state.key)
				for (const item of attachments)
					if (item.status !== "removing")
						dispatch({
							_tag: "AttachmentRemoved",
							key: state.key,
							id: item.id,
						});
			dispatch({ _tag: "Cleared" });
		},
		async flush() {
			try {
				await Promise.all(dispatch({ _tag: "Flush" }).pending);
				return true;
			} catch (error) {
				toastFailure("Could not save draft")(error);
				return false;
			}
		},
		sendStarted(clear: boolean) {
			const unsent = {
				text: state.text,
				key: state.key ?? null,
				attachmentIds: attachments.map(({ id }) => id),
			};
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
			unsent: {
				text: string;
				key: InputDraftKey | null;
				attachmentIds?: readonly string[];
			},
			sentTo: string | null,
			restore: boolean,
			alreadySent = false,
		): boolean {
			const before = state;
			const hasNewAttachments = attachments.some(
				(item) =>
					item.status !== "removing" &&
					!unsent.attachmentIds?.includes(item.id),
			);
			const key = unsent.key ? draftKeyId(unsent.key) : null;
			const sameScope = sentTo
				? before.key && "session" in before.key && before.key.session === sentTo
				: key !== null &&
					before.key &&
					draftKeyId(before.key) === key &&
					!before.promoted.has(key);
			const restoreAttachments =
				restore &&
				!alreadySent &&
				sameScope &&
				!before.text &&
				!hasNewAttachments;
			dispatch({
				_tag: "SendFailed",
				...unsent,
				sentTo,
				hasAttachments: hasNewAttachments,
				restore,
				alreadySent,
			});
			return state.text !== before.text || Boolean(restoreAttachments);
		},
		sendSucceeded(
			sentTo: string | null,
			steer: boolean,
			clear: boolean,
			unsent: { key: InputDraftKey | null; text: string },
		): boolean {
			const { commands } = dispatch({
				_tag: "SendSucceeded",
				sentTo,
				steer,
				clear,
				key: unsent.key,
				text: unsent.text,
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
			const before = active
				? state.text
				: state.drafts.get(draftKeyId({ session: parentSessionId }))?.text;
			dispatch({
				_tag: "SideThreadSent",
				parentSessionId,
				text: sentText,
				attachmentsUnchanged,
			});
			return {
				cleared: before === sentText && attachmentsUnchanged,
				active: Boolean(active),
			};
		},
	};
}
