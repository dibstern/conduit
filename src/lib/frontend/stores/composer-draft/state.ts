export interface DraftState {
	text: string;
	sessionId: string | null | undefined;
	drafts: ReadonlyMap<string, string>;
	reloadRestored: ReadonlySet<string>;
	lastLocalEditAt: number;
	lastSyncApplied: number;
}

export type DraftEvent =
	| { _tag: "TextChanged"; text: string }
	| { _tag: "LocalEdited"; now: number }
	| {
			_tag: "ServerTextReceived";
			text: string;
			updatedAt: number;
			now: number;
			reloadPending: boolean;
	  }
	| {
			_tag: "SessionSwitched";
			sessionId: string | null;
			newSessionText: string;
			now: number;
	  }
	| { _tag: "SyncDue"; sessionId: string | null; serverOnly?: boolean }
	| { _tag: "Cleared"; sessionId: string | null }
	| { _tag: "SendStarted"; sessionId: string | null; clear: boolean }
	| {
			_tag: "SendFailed";
			text: string;
			restore: boolean;
			sentTo: string | null;
			sessionId: string | null;
			sameProject: boolean;
			hasAttachments: boolean;
	  }
	| {
			_tag: "SendSucceeded";
			sentTo: string | null;
			sessionId: string | null;
			steer: boolean;
			clear: boolean;
	  }
	| { _tag: "SessionCreated" }
	| {
			_tag: "SideThreadSent";
			parentSessionId: string;
			text: string;
			attachmentsUnchanged: boolean;
	  }
	| { _tag: "ReloadRestored"; entries: readonly (readonly [string, string])[] }
	| {
			_tag: "PersistBeforeReload";
			sessionId: string | null;
			hasAttachments: boolean;
	  };

export type DraftCommand =
	| { _tag: "ScheduleSync"; delay: number }
	| { _tag: "CancelSync" }
	| { _tag: "SyncDraft"; sessionId: string; text: string }
	| { _tag: "WriteNewSessionDraft"; text: string }
	| { _tag: "ClearNewSessionDraft" }
	| {
			_tag: "SaveReloadBackup";
			entries: readonly (readonly [string, string])[];
	  };

export function initialState(): DraftState {
	return {
		text: "",
		sessionId: undefined,
		drafts: new Map(),
		reloadRestored: new Set(),
		lastLocalEditAt: 0,
		lastSyncApplied: 0,
	};
}

function clear(
	state: DraftState,
	sessionId: string | null,
): [DraftState, DraftCommand[]] {
	const drafts = new Map(state.drafts);
	if (sessionId) drafts.delete(sessionId);
	return [
		{ ...state, text: "", drafts },
		[
			{ _tag: "CancelSync" },
			...(sessionId
				? [{ _tag: "SyncDraft" as const, sessionId, text: "" }]
				: []),
		],
	];
}

/** Today's draft rules, including deliberately dropping syncs inside the 1 s grace window. */
export function step(
	state: DraftState,
	event: DraftEvent,
): [DraftState, DraftCommand[]] {
	switch (event._tag) {
		case "TextChanged":
			return [{ ...state, text: event.text }, []];
		case "LocalEdited":
			return [
				{ ...state, lastLocalEditAt: event.now },
				[{ _tag: "ScheduleSync", delay: 300 }],
			];
		case "ServerTextReceived": {
			if (event.updatedAt <= state.lastSyncApplied) return [state, []];
			const next = { ...state, lastSyncApplied: event.updatedAt };
			if (event.reloadPending || event.now - state.lastLocalEditAt < 1_000)
				return [next, []];
			return [{ ...next, text: event.text }, []];
		}
		case "SessionSwitched": {
			if (event.sessionId === state.sessionId) return [state, []];
			const drafts = new Map(state.drafts);
			if (state.sessionId) drafts.set(state.sessionId, state.text);
			const reloadRestored = new Set(state.reloadRestored);
			const restored = reloadRestored.delete(event.sessionId ?? "");
			return [
				{
					...state,
					drafts,
					reloadRestored,
					sessionId: event.sessionId,
					text: event.sessionId
						? (drafts.get(event.sessionId) ?? "")
						: event.newSessionText,
					lastLocalEditAt: restored ? event.now : 0,
				},
				[{ _tag: "CancelSync" }],
			];
		}
		case "SyncDue":
			return [
				state,
				event.sessionId
					? [
							{
								_tag: "SyncDraft",
								sessionId: event.sessionId,
								text: state.text,
							},
						]
					: event.serverOnly
						? []
						: [{ _tag: "WriteNewSessionDraft", text: state.text }],
			];
		case "Cleared":
			return clear(state, event.sessionId);
		case "SendStarted":
			return event.clear ? clear(state, event.sessionId) : [state, []];
		case "SendFailed": {
			const sameScope = event.sentTo
				? event.sessionId === event.sentTo
				: !event.sessionId && event.sameProject;
			return event.restore && sameScope && !state.text && !event.hasAttachments
				? [{ ...state, text: event.text }, []]
				: [state, []];
		}
		case "SendSucceeded": {
			if (!event.steer) return [state, []];
			if (event.sessionId === event.sentTo)
				return event.clear ? clear(state, event.sessionId) : [state, []];
			const drafts = new Map(state.drafts);
			if (event.sentTo) drafts.delete(event.sentTo);
			return [{ ...state, drafts }, []];
		}
		case "SessionCreated":
			return [state, [{ _tag: "ClearNewSessionDraft" }]];
		case "SideThreadSent": {
			const active = state.sessionId === event.parentSessionId;
			const text = active
				? state.text
				: state.drafts.get(event.parentSessionId);
			if (text !== event.text || !event.attachmentsUnchanged)
				return [state, []];
			const drafts = new Map(state.drafts);
			drafts.delete(event.parentSessionId);
			return [
				{ ...state, drafts, text: active ? "" : state.text },
				[
					...(active ? [{ _tag: "CancelSync" as const }] : []),
					{ _tag: "SyncDraft", sessionId: event.parentSessionId, text: "" },
				],
			];
		}
		case "ReloadRestored": {
			const drafts = new Map(state.drafts);
			const reloadRestored = new Set(state.reloadRestored);
			for (const [id, text] of event.entries) {
				drafts.set(id, text);
				reloadRestored.add(id);
			}
			return [{ ...state, drafts, reloadRestored }, []];
		}
		case "PersistBeforeReload": {
			const commands: DraftCommand[] = event.sessionId
				? []
				: [{ _tag: "WriteNewSessionDraft", text: state.text }];
			if (event.hasAttachments) return [state, commands];
			const drafts = new Map(state.drafts);
			drafts.set(event.sessionId ?? "", state.text);
			commands.push({ _tag: "SaveReloadBackup", entries: [...drafts] });
			return [{ ...state, drafts }, commands];
		}
		default:
			event satisfies never;
			return [state, []];
	}
}
