import type { InputDraftKey } from "../../../contracts/ws-rpc.js";

export const draftKeyId = (key: InputDraftKey): string =>
	"session" in key ? `session:${key.session}` : `draft:${key.draft}`;

export interface DraftAttachmentItem {
	id: string;
	name: string;
	mime: string;
	size: number;
	hash?: string;
	dataUrl?: string;
	projectSlug?: string;
	status: "saving" | "saved" | "failed" | "removing";
	previousStatus?: "saving" | "saved" | "failed";
	error?: string;
	/** Validation refusals need an explicit Retry, even after reconnecting. */
	retryOnReconnect?: false;
}
type LocalAttachment = Required<
	Pick<DraftAttachmentItem, "id" | "name" | "mime" | "size" | "dataUrl">
> & { projectSlug?: string };
type SavedAttachment = Required<
	Pick<DraftAttachmentItem, "id" | "name" | "mime" | "size" | "hash">
>;

export interface ReloadDraft {
	key: InputDraftKey;
	text: string;
	acked: string;
}
interface Draft extends ReloadDraft {
	projectSlug: string | null;
	projectChanged: boolean;
	sendPick?: DraftState["sendPick"];
}
export interface DraftState {
	attachments: ReadonlyMap<string, readonly DraftAttachmentItem[]>;
	key: InputDraftKey | null | undefined;
	text: string;
	acked: string;
	projectSlug: string | null;
	projectChanged: boolean;
	sendPick?: { mode: "at-reset" | "switch"; accountId: string } | undefined;
	drafts: ReadonlyMap<string, Draft>;
	reloadBases: ReadonlyMap<string, string>;
	legacy: { key: InputDraftKey; text: string } | null;
	inFlight: ReadonlyMap<string, readonly string[]>;
	promoted: ReadonlyMap<string, string>;
	throttled: boolean;
	pending: boolean;
	snapshot: "waiting" | "overlapped" | "ready";
}
export type DraftEvent =
	| { _tag: "AttachmentAdded"; key: InputDraftKey; attachment: LocalAttachment }
	| {
			_tag: "AttachmentAddAcknowledged";
			key: InputDraftKey;
			id: string;
			result: { attachment: SavedAttachment } | { ended: "removed" | "sent" };
	  }
	| {
			_tag: "AttachmentAddFailed";
			key: InputDraftKey;
			id: string;
			error: string;
			retryOnReconnect?: false;
	  }
	| { _tag: "AttachmentRetryRequested"; key: InputDraftKey; id: string }
	| {
			_tag: "AttachmentsReceived";
			key: InputDraftKey;
			attachments: readonly SavedAttachment[];
	  }
	| { _tag: "AttachmentRemoved"; key: InputDraftKey; id: string }
	| { _tag: "AttachmentRemoveAcknowledged"; key: InputDraftKey; id: string }
	| {
			_tag: "AttachmentRemoveFailed";
			key: InputDraftKey;
			id: string;
			error: string;
	  }
	| { _tag: "ConnectionLost" }
	| { _tag: "Reconnected" }
	| {
			_tag: "SendAttachmentsAccepted";
			key: InputDraftKey;
			ids: readonly string[];
	  }
	| { _tag: "TextChanged"; text: string }
	| { _tag: "SendPickChanged"; pick: DraftState["sendPick"] }
	| { _tag: "LocalEdited" }
	| {
			_tag: "ServerTextReceived";
			key: InputDraftKey;
			text?: string;
			restored?: string;
			projectId?: string;
			initial?: boolean;
	  }
	| { _tag: "SubscriptionStarted"; key: InputDraftKey }
	| {
			_tag: "Promoted";
			key: InputDraftKey;
			sessionId: string;
			text: string;
			freshDraftId: string;
	  }
	| {
			_tag: "Retired";
			key: InputDraftKey;
			sessionId: string;
			freshDraftId: string;
	  }
	| {
			_tag: "SyncSucceeded";
			key: InputDraftKey;
			text: string;
			projectSlug: string | null;
	  }
	| { _tag: "SyncFailed" }
	| { _tag: "Hidden" }
	| {
			_tag: "KeySwitched";
			key: InputDraftKey | null;
			projectSlug: string | null;
			projectChosen: boolean;
	  }
	| { _tag: "SyncDue" }
	| { _tag: "Flush" }
	| { _tag: "Cleared" }
	| { _tag: "Discarded"; key: InputDraftKey }
	| { _tag: "SendStarted"; clear: boolean }
	| {
			_tag: "SendFailed";
			key: InputDraftKey | null;
			text: string;
			restore: boolean;
			sentTo: string | null;
			hasAttachments: boolean;
			alreadySent: boolean;
	  }
	| {
			_tag: "SendSucceeded";
			key: InputDraftKey | null;
			text: string;
			sentTo: string | null;
			steer: boolean;
			clear: boolean;
	  }
	| {
			_tag: "SideThreadSent";
			parentSessionId: string;
			text: string;
			attachmentsUnchanged: boolean;
	  }
	| { _tag: "ReloadRestored"; entries: readonly ReloadDraft[] }
	| { _tag: "LegacyDraftFound"; key: InputDraftKey; text: string }
	| { _tag: "PersistBeforeReload"; hasAttachments: boolean };
export type DraftCommand =
	| { _tag: "AddAttachment"; key: InputDraftKey; attachment: LocalAttachment }
	| { _tag: "RemoveAttachment"; key: InputDraftKey; id: string }
	| { _tag: "ScheduleSync"; delay: number }
	| { _tag: "CancelSync" }
	| { _tag: "StartDraft" }
	| {
			_tag: "SyncDraft";
			key: InputDraftKey;
			text: string;
			projectSlug: string | null;
	  }
	| { _tag: "NavigateDraft"; key: InputDraftKey; projectSlug?: string | null }
	| { _tag: "NavigateSession"; sessionId: string }
	| { _tag: "ApplyProject"; projectSlug: string }
	| { _tag: "RemoveLegacyDraft"; text: string }
	| { _tag: "SaveReloadBackup"; entries: readonly ReloadDraft[] };
export function initialState(): DraftState {
	return {
		attachments: new Map(),
		key: undefined,
		text: "",
		acked: "",
		projectSlug: null,
		projectChanged: false,
		drafts: new Map(),
		reloadBases: new Map(),
		legacy: null,
		inFlight: new Map(),
		promoted: new Map(),
		throttled: false,
		pending: false,
		snapshot: "waiting",
	};
}
export function hasContent(state: DraftState, key: InputDraftKey): boolean {
	const id = draftKeyId(key);
	const text =
		state.key && draftKeyId(state.key) === id
			? state.text
			: state.drafts.get(id)?.text;
	return (
		Boolean(text) ||
		(state.attachments.get(id) ?? []).some((item) => item.status !== "removing")
	);
}
export function attachmentsReady(
	state: DraftState,
	key: InputDraftKey,
): boolean {
	return !(state.attachments.get(draftKeyId(key)) ?? []).some(
		(item) => item.status === "saving" || item.status === "failed",
	);
}
function settleSend(
	state: DraftState,
	key: InputDraftKey | null,
	text: string,
): DraftState {
	if (!key) return state;
	const source = draftKeyId(key);
	const id = state.promoted.get(source) ?? source;
	const pending = [...(state.inFlight.get(id) ?? [])];
	const index = pending.indexOf(text);
	if (index < 0) return state;
	pending.splice(index, 1);
	const inFlight = new Map(state.inFlight);
	if (pending.length) inFlight.set(id, pending);
	else inFlight.delete(id);
	return { ...state, inFlight };
}

function flushUnsentText(
	state: DraftState,
	key: InputDraftKey | null,
): [DraftState, DraftCommand[]] {
	if (!key) return [state, []];
	const id = draftKeyId(key);
	if (state.inFlight.has(id) || state.promoted.has(id)) return [state, []];
	if (state.key && draftKeyId(state.key) === id)
		return step(state, { _tag: "Flush" });
	const cached = state.drafts.get(id);
	return cached && (cached.text !== cached.acked || cached.projectChanged)
		? [
				state,
				[
					{
						_tag: "SyncDraft",
						key,
						text: cached.text,
						projectSlug: cached.projectSlug,
					},
				],
			]
		: [state, []];
}

function clear(state: DraftState): [DraftState, DraftCommand[]] {
	const reloadBases = new Map(state.reloadBases);
	if (state.key) reloadBases.delete(draftKeyId(state.key));
	return [
		{
			...state,
			reloadBases,
			text: "",
			throttled: false,
			pending: false,
			snapshot:
				state.snapshot === "waiting" && state.key
					? "overlapped"
					: state.snapshot,
		},
		[
			{ _tag: "CancelSync" },
			...(state.key &&
			!state.promoted.has(draftKeyId(state.key)) &&
			!state.inFlight.has(draftKeyId(state.key))
				? [
						{
							_tag: "SyncDraft" as const,
							key: state.key,
							text: "",
							projectSlug: state.projectSlug,
						},
					]
				: []),
		],
	];
}
/** Unknown reads preserve text; unsent edits reject ordinary live text. Reload snapshots
 * compare their saved base once, before writes. Failed syncs keep acked; late
 * replies name their key/text. Explicit project moves and sends supersede reads. */
export function step(
	state: DraftState,
	event: DraftEvent,
): [DraftState, DraftCommand[]] {
	const id = state.key ? draftKeyId(state.key) : null;
	const writable =
		id !== null && !state.promoted.has(id) && !state.inFlight.has(id);
	switch (event._tag) {
		case "ConnectionLost":
		case "Reconnected":
		case "AttachmentRetryRequested": {
			const attachments = new Map(state.attachments);
			const commands: DraftCommand[] = [];
			for (const [keyId, items] of attachments) {
				const key = keyId.startsWith("session:")
					? { session: keyId.slice(8) }
					: { draft: keyId.slice(6) };
				attachments.set(
					keyId,
					items.map((item) => {
						if (event._tag === "ConnectionLost" && item.status === "saving")
							return { ...item, status: "failed", error: "Connection lost" };
						if (
							event._tag === "ConnectionLost" &&
							item.status === "removing" &&
							item.previousStatus === "saving"
						)
							return {
								...item,
								previousStatus: "failed",
								error: "Connection lost",
							};
						if (
							(event._tag === "Reconnected"
								? item.retryOnReconnect !== false
								: event._tag === "AttachmentRetryRequested" &&
									keyId === draftKeyId(event.key) &&
									item.id === event.id) &&
							item.status === "failed" &&
							item.dataUrl
						) {
							const {
								error: _error,
								previousStatus: _previousStatus,
								retryOnReconnect: _retryOnReconnect,
								...retry
							} = item;
							commands.push({
								_tag: "AddAttachment",
								key,
								attachment: {
									id: item.id,
									name: item.name,
									mime: item.mime,
									size: item.size,
									dataUrl: item.dataUrl,
									...(item.projectSlug
										? { projectSlug: item.projectSlug }
										: {}),
								},
							});
							return { ...retry, status: "saving" };
						}
						return item;
					}),
				);
			}
			return [{ ...state, attachments }, commands];
		}
		case "AttachmentAdded":
		case "AttachmentAddAcknowledged":
		case "AttachmentAddFailed":
		case "AttachmentsReceived":
		case "AttachmentRemoved":
		case "AttachmentRemoveAcknowledged":
		case "AttachmentRemoveFailed":
		case "SendAttachmentsAccepted": {
			const keyId = draftKeyId(event.key);
			const attachments = new Map(state.attachments);
			let items = attachments.get(keyId) ?? [];
			const commands: DraftCommand[] = [];
			if (event._tag === "AttachmentAdded") {
				if (items.some((item) => item.id === event.attachment.id))
					return [state, []];
				items = [...items, { ...event.attachment, status: "saving" }];
				commands.push({
					_tag: "AddAttachment",
					key: event.key,
					attachment: event.attachment,
				});
			} else if (event._tag === "AttachmentsReceived") {
				const savedIds = new Set(event.attachments.map((item) => item.id));
				items = [
					...event.attachments.map((item): DraftAttachmentItem => {
						const existing = items.find((local) => local.id === item.id);
						return existing?.status === "removing"
							? { ...item, status: "removing", previousStatus: "saved" }
							: { ...item, status: "saved" };
					}),
					...items.filter(
						(item) =>
							!savedIds.has(item.id) &&
							(item.status === "saving" || item.status === "failed"),
					),
				];
			} else if (event._tag === "SendAttachmentsAccepted") {
				items = items.filter((item) => !event.ids.includes(item.id));
			} else if (event._tag === "AttachmentRemoved") {
				items = items.map((item) =>
					item.id !== event.id || item.status === "removing"
						? item
						: { ...item, status: "removing", previousStatus: item.status },
				);
				commands.push({
					_tag: "RemoveAttachment",
					key: event.key,
					id: event.id,
				});
			} else if (event._tag === "AttachmentAddAcknowledged") {
				const result = event.result;
				items =
					"ended" in result
						? items.filter((item) => item.id !== event.id)
						: items.map((item) =>
								item.id !== event.id
									? item
									: item.status === "removing"
										? {
												...result.attachment,
												status: "removing",
												previousStatus: "saved",
											}
										: { ...result.attachment, status: "saved" },
							);
			} else if (event._tag === "AttachmentRemoveAcknowledged") {
				items = items.filter(
					(item) => item.id !== event.id || item.status !== "removing",
				);
			} else if (event._tag === "AttachmentRemoveFailed") {
				items = items.map((item) =>
					item.id !== event.id || item.status !== "removing"
						? item
						: {
								...item,
								status: item.previousStatus ?? "saved",
								error: event.error,
							},
				);
			} else {
				items = items.map((item) =>
					item.id !== event.id
						? item
						: item.status === "saving" || item.status === "failed"
							? {
									...item,
									status: "failed",
									error: event.error,
									...(event.retryOnReconnect === false
										? { retryOnReconnect: false as const }
										: {}),
								}
							: item.status === "removing" &&
									(item.previousStatus === "saving" ||
										item.previousStatus === "failed")
								? {
										...item,
										previousStatus: "failed",
										error: event.error,
										...(event.retryOnReconnect === false
											? { retryOnReconnect: false as const }
											: {}),
									}
								: item,
				);
			}
			attachments.set(keyId, items);
			return [{ ...state, attachments }, commands];
		}
		case "SendPickChanged":
			return [{ ...state, sendPick: event.pick }, []];
		case "TextChanged":
			return [{ ...state, text: event.text }, []];
		case "LocalEdited":
			if (!state.key)
				return [state, state.text ? [{ _tag: "StartDraft" }] : []];
			if (!writable) return [state, []];
			if (state.snapshot !== "ready" || state.throttled)
				return [{ ...state, pending: true }, []];
			return [
				{ ...state, throttled: true, pending: false },
				[
					{
						_tag: "SyncDraft",
						key: state.key,
						text: state.text,
						projectSlug: state.projectSlug,
					},
					{ _tag: "ScheduleSync", delay: 300 },
				],
			];
		case "SubscriptionStarted":
			return draftKeyId(event.key) === id
				? [
						{ ...state, snapshot: "waiting", throttled: false },
						[{ _tag: "CancelSync" }],
					]
				: [state, []];
		case "ServerTextReceived": {
			if (
				draftKeyId(event.key) !== id ||
				state.promoted.has(draftKeyId(event.key))
			)
				return [state, []];
			if (!writable && "draft" in event.key)
				return [
					{ ...state, snapshot: event.initial ? "ready" : state.snapshot },
					[],
				];
			// A missing draft row is empty; a missing session row remains unknown.
			const incoming =
				"draft" in event.key && event.initial ? (event.text ?? "") : event.text;
			const base = event.initial && id ? state.reloadBases.get(id) : undefined;
			let next = state;
			const commands: DraftCommand[] = [];
			if (base !== undefined) {
				const reloadBases = new Map(state.reloadBases);
				reloadBases.delete(draftKeyId(event.key));
				next = { ...state, reloadBases };
				if (incoming !== undefined && incoming !== base)
					next = { ...next, text: incoming, acked: incoming };
			} else if (
				event.restored !== undefined &&
				incoming !== undefined &&
				state.text !== state.acked
			) {
				next = {
					...state,
					text: state.text
						? `${event.restored}\n\n${state.text}`
						: event.restored,
					acked: incoming,
					pending: true,
					throttled: true,
				};
				commands.push({ _tag: "ScheduleSync", delay: 300 });
			} else if (
				!(event.initial && state.snapshot === "overlapped") &&
				incoming !== undefined &&
				(state.text === state.acked || !state.text)
			)
				next = { ...state, text: incoming, acked: incoming };
			if (
				"draft" in event.key &&
				event.projectId &&
				!(event.initial && state.snapshot === "overlapped") &&
				!state.projectChanged
			) {
				next = { ...next, projectSlug: event.projectId };
				commands.push({ _tag: "ApplyProject", projectSlug: event.projectId });
			}
			if (event.initial) {
				const [ready, flush] = step(
					{ ...next, snapshot: "ready" },
					{ _tag: "Flush" },
				);
				return [ready, [...commands, ...flush]];
			}
			return [next, commands];
		}
		case "SyncSucceeded": {
			const syncedId = draftKeyId(event.key);
			if (state.promoted.has(syncedId)) return [state, []];
			let next = state;
			const commands: DraftCommand[] = [];
			if (syncedId === id)
				next = {
					...state,
					acked: event.text,
					projectChanged:
						state.projectSlug === event.projectSlug
							? false
							: state.projectChanged,
				};
			else {
				const draft = state.drafts.get(syncedId);
				if (draft) {
					const drafts = new Map(state.drafts);
					drafts.set(syncedId, {
						...draft,
						acked: event.text,
						projectChanged:
							draft.projectSlug === event.projectSlug
								? false
								: draft.projectChanged,
					});
					next = { ...state, drafts };
				}
			}
			if (state.legacy && draftKeyId(state.legacy.key) === syncedId) {
				commands.push({ _tag: "RemoveLegacyDraft", text: state.legacy.text });
				next = { ...next, legacy: null };
			}
			return [next, commands];
		}
		case "Promoted":
		case "Retired": {
			if (!("draft" in event.key)) return [state, []];
			const promotedId = draftKeyId(event.key);
			const drafts = new Map(state.drafts);
			const reloadBases = new Map(state.reloadBases);
			const inFlight = new Map(state.inFlight);
			const promoted = new Map(state.promoted);
			const destination = draftKeyId({ session: event.sessionId });
			const pending = inFlight.get(promotedId);
			const sentText = inFlight.get(promotedId)?.at(-1);
			const sending =
				sentText !== undefined &&
				(event._tag === "Retired" || sentText === event.text);
			drafts.delete(promotedId);
			reloadBases.delete(promotedId);
			inFlight.delete(promotedId);
			if (pending)
				inFlight.set(destination, [
					...(inFlight.get(destination) ?? []),
					...pending,
				]);
			promoted.set(promotedId, destination);
			const next = { ...state, drafts, reloadBases, inFlight, promoted };
			if (promotedId !== id) return [next, []];
			const localText = state.text || sentText || "";
			// A reconnect knows the destination but the tombstone holds no sent text.
			// Clean cached text can follow; dirty text keeps its own fresh draft.
			const follow =
				event._tag === "Retired"
					? sending || state.text === state.acked || !state.text
					: sending ||
						localText === event.text ||
						(!state.text && state.acked === event.text);
			const key = follow
				? { session: event.sessionId }
				: { draft: event.freshDraftId };
			return [
				{
					...next,
					key,
					text: follow
						? sending && state.text !== sentText
							? state.text
							: ""
						: localText,
					acked: "",
					projectChanged: false,
					pending: false,
					throttled: false,
					snapshot: "waiting",
				},
				[
					{ _tag: "CancelSync" },
					follow
						? {
								_tag: "NavigateSession",
								sessionId: event.sessionId,
							}
						: { _tag: "NavigateDraft", key, projectSlug: state.projectSlug },
				],
			];
		}
		case "SyncFailed":
			return [state, []];
		case "KeySwitched": {
			const nextId = event.key ? draftKeyId(event.key) : null;
			if (nextId === id && state.key !== undefined) {
				if (state.projectSlug === event.projectSlug) return [state, []];
				const moved = {
					...state,
					projectSlug: event.projectSlug,
					projectChanged:
						state.projectChanged ||
						Boolean(event.projectChosen && event.key && "draft" in event.key),
				};
				return state.snapshot === "ready"
					? step(moved, { _tag: "Flush" })
					: [moved, []];
			}
			const drafts = new Map(state.drafts);
			if (id && state.key && !state.promoted.has(id))
				drafts.set(id, {
					key: state.key,
					text: state.text,
					acked: state.acked,
					projectSlug: state.projectSlug,
					projectChanged: state.projectChanged,
					sendPick: state.sendPick,
				});
			const saved =
				nextId && !state.promoted.has(nextId) ? drafts.get(nextId) : undefined;
			return [
				{
					...state,
					key: event.key,
					text:
						saved?.text ??
						(!state.key && event.key && "draft" in event.key ? state.text : ""),
					acked: saved?.acked ?? "",
					projectSlug: event.projectSlug,
					projectChanged: saved?.projectChanged ?? false,
					sendPick: saved?.sendPick,
					drafts,
					throttled: false,
					pending: false,
					snapshot: "waiting",
				},
				[
					{ _tag: "CancelSync" },
					...(state.key &&
					id &&
					writable &&
					!state.reloadBases.has(id) &&
					(state.text !== state.acked || state.projectChanged)
						? [
								{
									_tag: "SyncDraft" as const,
									key: state.key,
									text: state.text,
									projectSlug: state.projectSlug,
								},
							]
						: []),
				],
			];
		}
		case "SyncDue":
			if (!state.key || !writable || state.snapshot !== "ready")
				return [{ ...state, throttled: false }, []];
			return [
				{ ...state, throttled: state.pending, pending: false },
				state.pending
					? [
							{
								_tag: "SyncDraft",
								key: state.key,
								text: state.text,
								projectSlug: state.projectSlug,
							},
							{ _tag: "ScheduleSync", delay: 300 },
						]
					: [],
			];
		case "Hidden":
		case "Flush":
			if (id && state.reloadBases.has(id)) return [state, []];
			return [
				{
					...state,
					throttled: false,
					pending: false,
					snapshot:
						state.snapshot === "waiting" &&
						state.key &&
						state.text !== state.acked
							? "overlapped"
							: state.snapshot,
				},
				[
					{ _tag: "CancelSync" },
					...(state.key &&
					writable &&
					(state.text !== state.acked || state.projectChanged)
						? [
								{
									_tag: "SyncDraft" as const,
									key: state.key,
									text: state.text,
									projectSlug: state.projectSlug,
								},
							]
						: []),
				],
			];
		case "Cleared":
			return clear(state);
		case "Discarded": {
			const discardedId = draftKeyId(event.key);
			const drafts = new Map(state.drafts);
			const reloadBases = new Map(state.reloadBases);
			drafts.delete(discardedId);
			reloadBases.delete(discardedId);
			if (discardedId !== id) return [{ ...state, drafts, reloadBases }, []];
			return [
				{
					...state,
					drafts,
					reloadBases,
					text: "",
					acked: "",
					sendPick: undefined,
					pending: false,
					throttled: false,
					snapshot:
						state.snapshot === "waiting" ? "overlapped" : state.snapshot,
				},
				[{ _tag: "CancelSync" }],
			];
		}
		case "SendStarted": {
			const inFlight = new Map(state.inFlight);
			if (id) inFlight.set(id, [...(inFlight.get(id) ?? []), state.text]);
			return [
				{
					...state,
					inFlight,
					...(event.clear && state.key && "draft" in state.key
						? { text: "" }
						: {}),
					pending: false,
					throttled: false,
				},
				[{ _tag: "CancelSync" }],
			];
		}
		case "SendFailed": {
			let next = settleSend(state, event.key, event.text);
			// The failed attempt has settled; the acknowledged text can still follow
			// the winning tab's promotion without keeping this composer busy.
			if (event.alreadySent) return [next, []];
			const restore =
				event.restore && event.key !== null && "draft" in event.key;
			const key =
				event.key && !next.promoted.has(draftKeyId(event.key))
					? event.key
					: event.sentTo
						? { session: event.sentTo }
						: null;
			if (restore && event.key && draftKeyId(event.key) !== id) {
				const keyId = draftKeyId(event.key);
				const cached = next.drafts.get(keyId);
				if (cached && !cached.text) {
					const drafts = new Map(next.drafts);
					drafts.set(keyId, { ...cached, text: event.text });
					next = { ...next, drafts };
				}
			}
			if (
				!event.sentTo &&
				event.key &&
				state.promoted.has(draftKeyId(event.key))
			)
				return [next, []];
			const sameScope = event.sentTo
				? state.key &&
					"session" in state.key &&
					state.key.session === event.sentTo
				: event.key && draftKeyId(event.key) === id;
			if (!restore || !sameScope || state.text)
				return flushUnsentText(next, key);
			return step({ ...next, text: event.text }, { _tag: "LocalEdited" });
		}
		case "SendSucceeded": {
			state = settleSend(state, event.key, event.text);
			const key =
				event.key && !state.promoted.has(draftKeyId(event.key))
					? event.key
					: event.sentTo
						? { session: event.sentTo }
						: null;
			if (!key) return [state, []];
			const sentId = draftKeyId(key);
			const drafts = new Map(state.drafts);
			const reloadBases = new Map(state.reloadBases);
			reloadBases.delete(sentId);
			const active = sentId === id;
			const draft = drafts.get(sentId);
			const currentText = active ? state.text : draft?.text;
			const cleared =
				event.clear && (currentText === "" || currentText === event.text);
			if (draft)
				drafts.set(sentId, {
					...draft,
					sendPick: undefined,
					...(cleared ? { acked: "", text: "" } : {}),
				});
			state = {
				...state,
				drafts,
				reloadBases,
				...(active
					? {
							sendPick: undefined,
							...(cleared
								? {
										acked: "",
										text: "",
										pending: false,
										throttled: false,
									}
								: {}),
						}
					: {}),
			};
			// Only dirty local edits need a write. The inbox cleared the sent text.
			const [next, commands] = flushUnsentText(state, key);
			if (commands.length) return [next, commands];
			return [state, active && cleared ? [{ _tag: "CancelSync" }] : []];
		}
		case "SideThreadSent": {
			const key = { session: event.parentSessionId };
			state = settleSend(state, key, event.text);
			const parentId = draftKeyId(key);
			const active = id === parentId;
			if (
				(active ? state.text : state.drafts.get(parentId)?.text) !==
					event.text ||
				!event.attachmentsUnchanged
			)
				return flushUnsentText(state, key);
			const drafts = new Map(state.drafts);
			drafts.set(parentId, {
				key,
				text: "",
				acked: "",
				projectSlug: null,
				projectChanged: false,
			});
			const reloadBases = new Map(state.reloadBases);
			reloadBases.delete(parentId);
			return [
				{
					...state,
					drafts,
					reloadBases,
					...(active
						? {
								text: "",
								acked: "",
								sendPick: undefined,
								throttled: false,
								pending: false,
								snapshot:
									state.snapshot === "waiting"
										? ("overlapped" as const)
										: state.snapshot,
							}
						: {}),
				},
				[...(active ? [{ _tag: "CancelSync" as const }] : [])],
			];
		}
		case "ReloadRestored": {
			const drafts = new Map(state.drafts);
			const reloadBases = new Map(state.reloadBases);
			for (const entry of event.entries) {
				const entryId = draftKeyId(entry.key);
				if (state.promoted.has(entryId)) continue;
				drafts.set(entryId, {
					...entry,
					projectSlug: null,
					projectChanged: false,
				});
				reloadBases.set(entryId, entry.acked);
			}
			return [{ ...state, drafts, reloadBases }, []];
		}
		case "LegacyDraftFound": {
			const drafts = new Map(state.drafts);
			drafts.set(draftKeyId(event.key), {
				key: event.key,
				text: event.text,
				acked: "",
				projectSlug: null,
				projectChanged: false,
			});
			return [
				{ ...state, drafts, legacy: { key: event.key, text: event.text } },
				[{ _tag: "NavigateDraft", key: event.key }],
			];
		}
		case "PersistBeforeReload": {
			if (event.hasAttachments) return [state, []];
			const drafts = new Map(state.drafts);
			if (state.key && id && !state.promoted.has(id))
				drafts.set(id, {
					key: state.key,
					text: state.text,
					acked: state.acked,
					projectSlug: state.projectSlug,
					projectChanged: state.projectChanged,
				});
			return [
				{ ...state, drafts },
				[
					{
						_tag: "SaveReloadBackup",
						entries: [...drafts.values()].map(({ key, text, acked }) => ({
							key,
							text,
							acked,
						})),
					},
				],
			];
		}
		default:
			event satisfies never;
			return [state, []];
	}
}
