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
}
export interface DraftState {
	key: InputDraftKey | null | undefined;
	text: string;
	acked: string;
	projectSlug: string | null;
	projectChanged: boolean;
	drafts: ReadonlyMap<string, Draft>;
	reloadBases: ReadonlyMap<string, string>;
	legacy: { key: InputDraftKey; text: string } | null;
	throttled: boolean;
	pending: boolean;
	snapshot: "waiting" | "overlapped" | "ready";
}
export type DraftEvent =
	| { _tag: "TextChanged"; text: string }
	| { _tag: "LocalEdited" }
	| {
			_tag: "ServerTextReceived";
			key: InputDraftKey;
			text?: string;
			projectId?: string;
			initial?: boolean;
	  }
	| { _tag: "SubscriptionStarted"; key: InputDraftKey }
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
	| { _tag: "SendStarted"; clear: boolean }
	| {
			_tag: "SendFailed";
			key: InputDraftKey | null;
			text: string;
			restore: boolean;
			sentTo: string | null;
			hasAttachments: boolean;
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
	| { _tag: "NavigateDraft"; key: InputDraftKey }
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
			...(state.key
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
/** Unknown reads preserve text; unsent edits reject live text. Reload snapshots
 * compare their saved base once, before writes. Failed syncs keep acked; late
 * replies name their key/text. Explicit project moves and sends supersede reads. */
export function step(
	state: DraftState,
	event: DraftEvent,
): [DraftState, DraftCommand[]] {
	const id = state.key ? draftKeyId(state.key) : null;
	switch (event._tag) {
		case "TextChanged":
			return [{ ...state, text: event.text }, []];
		case "LocalEdited":
			if (!state.key)
				return [state, state.text ? [{ _tag: "StartDraft" }] : []];
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
			if (draftKeyId(event.key) !== id) return [state, []];
			// A missing draft row is empty; a missing session row remains unknown.
			const incoming =
				"draft" in event.key && event.initial ? (event.text ?? "") : event.text;
			const base = event.initial && id ? state.reloadBases.get(id) : undefined;
			let next = state;
			if (base !== undefined) {
				const reloadBases = new Map(state.reloadBases);
				reloadBases.delete(draftKeyId(event.key));
				next = { ...state, reloadBases };
				if (incoming !== undefined && incoming !== base)
					next = { ...next, text: incoming, acked: incoming };
			} else if (
				!(event.initial && state.snapshot === "overlapped") &&
				incoming !== undefined &&
				(state.text === state.acked || !state.text)
			)
				next = { ...state, text: incoming, acked: incoming };
			const commands: DraftCommand[] = [];
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
			if (id && state.key)
				drafts.set(id, {
					key: state.key,
					text: state.text,
					acked: state.acked,
					projectSlug: state.projectSlug,
					projectChanged: state.projectChanged,
				});
			const saved = nextId ? drafts.get(nextId) : undefined;
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
					drafts,
					throttled: false,
					pending: false,
					snapshot: "waiting",
				},
				[
					{ _tag: "CancelSync" },
					...(state.key &&
					id &&
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
			if (!state.key || state.snapshot !== "ready")
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
					...(state.key && (state.text !== state.acked || state.projectChanged)
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
		case "SendStarted":
			return event.clear ? clear(state) : [state, []];
		case "SendFailed": {
			const sameScope = event.sentTo
				? state.key &&
					"session" in state.key &&
					state.key.session === event.sentTo
				: event.key && draftKeyId(event.key) === id;
			if (!event.restore || !sameScope || state.text || event.hasAttachments)
				return [state, []];
			return step({ ...state, text: event.text }, { _tag: "LocalEdited" });
		}
		case "SendSucceeded": {
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
			if (state.key && id)
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
