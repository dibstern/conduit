import type { InputDraftKey } from "../../../contracts/ws-rpc.js";

export const draftKeyId = (key: InputDraftKey): string =>
	"session" in key ? `session:${key.session}` : `draft:${key.draft}`;

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
	key: InputDraftKey | null | undefined;
	text: string;
	acked: string;
	projectSlug: string | null;
	projectChanged: boolean;
	sendPick?: { mode: "at-reset" | "switch"; accountId: string } | undefined;
	drafts: ReadonlyMap<string, Draft>;
	reloadBases: ReadonlyMap<string, string>;
	legacy: { key: InputDraftKey; text: string } | null;
	inFlight: ReadonlyMap<string, string>;
	promoted: ReadonlySet<string>;
	throttled: boolean;
	pending: boolean;
	snapshot: "waiting" | "overlapped" | "ready";
}
export type DraftEvent =
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
		key: undefined,
		text: "",
		acked: "",
		projectSlug: null,
		projectChanged: false,
		drafts: new Map(),
		reloadBases: new Map(),
		legacy: null,
		inFlight: new Map(),
		promoted: new Set(),
		throttled: false,
		pending: false,
		snapshot: "waiting",
	};
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
			if (!writable)
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
			const promoted = new Set(state.promoted);
			const sentText = inFlight.get(promotedId);
			const sending =
				sentText !== undefined &&
				(event._tag === "Retired" || sentText === event.text);
			drafts.delete(promotedId);
			reloadBases.delete(promotedId);
			inFlight.delete(promotedId);
			promoted.add(promotedId);
			const next = { ...state, drafts, reloadBases, inFlight, promoted };
			if (promotedId !== id) return [next, []];
			const localText = state.text || sentText || "";
			// A reconnect knows the destination but the tombstone holds no sent text.
			// Clean cached text can follow; dirty text keeps its own fresh draft.
			const follow =
				event._tag === "Retired"
					? sending || state.text === state.acked || !state.text
					: sending || localText === event.text;
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
			if (!state.key || !("draft" in state.key) || !id)
				return event.clear ? clear(state) : [state, []];
			const inFlight = new Map(state.inFlight);
			inFlight.set(id, state.text);
			return [
				{
					...state,
					inFlight,
					...(event.clear ? { text: "" } : {}),
					pending: false,
					throttled: false,
				},
				[{ _tag: "CancelSync" }],
			];
		}
		case "SendFailed": {
			if (event.alreadySent) return [state, []];
			const inFlight = new Map(state.inFlight);
			if (event.key) inFlight.delete(draftKeyId(event.key));
			const next = { ...state, inFlight };
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
			if (!event.restore || !sameScope || state.text || event.hasAttachments)
				return [next, []];
			return step({ ...next, text: event.text }, { _tag: "LocalEdited" });
		}
		case "SendSucceeded": {
			if (event.sentTo) {
				if (id === draftKeyId({ session: event.sentTo })) {
					state = { ...state, sendPick: undefined };
				} else {
					const drafts = new Map(state.drafts);
					const sentId = draftKeyId({ session: event.sentTo });
					const draft = drafts.get(sentId);
					if (draft) drafts.set(sentId, { ...draft, sendPick: undefined });
					state = { ...state, drafts };
				}
			}
			if (!event.steer) return [state, []];
			if (
				state.key &&
				"session" in state.key &&
				state.key.session === event.sentTo
			)
				return event.clear ? clear(state) : [state, []];
			const drafts = new Map(state.drafts);
			const reloadBases = new Map(state.reloadBases);
			if (event.sentTo) {
				const key = { session: event.sentTo };
				drafts.set(draftKeyId(key), {
					key,
					text: "",
					acked: "",
					projectSlug: null,
					projectChanged: false,
				});
				reloadBases.delete(draftKeyId(key));
			}
			return [{ ...state, drafts, reloadBases }, []];
		}
		case "SideThreadSent": {
			const key = { session: event.parentSessionId };
			const parentId = draftKeyId(key);
			const active = id === parentId;
			if (
				(active ? state.text : state.drafts.get(parentId)?.text) !==
					event.text ||
				!event.attachmentsUnchanged
			)
				return [state, []];
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
				[
					...(active ? [{ _tag: "CancelSync" as const }] : []),
					{ _tag: "SyncDraft", key, text: "", projectSlug: null },
				],
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
