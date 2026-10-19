interface Draft {
	text: string;
	acked: string;
}

export interface DraftState extends Draft {
	sessionId: string | null | undefined;
	drafts: ReadonlyMap<string, Draft>;
	throttled: boolean;
	pending: boolean;
	snapshot: "waiting" | "overlapped" | "ready";
}

export type DraftEvent =
	| { _tag: "TextChanged"; text: string }
	| { _tag: "LocalEdited" }
	| {
			_tag: "ServerTextReceived";
			sessionId: string;
			text?: string;
			initial?: boolean;
	  }
	| { _tag: "SubscriptionStarted"; sessionId: string }
	| { _tag: "SyncSucceeded"; sessionId: string; text: string }
	| { _tag: "SyncFailed" }
	| { _tag: "Hidden" }
	| {
			_tag: "SessionSwitched";
			sessionId: string | null;
			newSessionText: string;
	  }
	| { _tag: "SyncDue" }
	| { _tag: "Flush"; serverOnly?: boolean }
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
		acked: "",
		sessionId: undefined,
		drafts: new Map(),
		throttled: false,
		pending: false,
		snapshot: "waiting",
	};
}

function clear(
	state: DraftState,
	sessionId: string | null,
): [DraftState, DraftCommand[]] {
	return [
		{
			...state,
			text: "",
			throttled: false,
			pending: false,
			snapshot:
				state.snapshot === "waiting" && sessionId
					? "overlapped"
					: state.snapshot,
		},
		[
			{ _tag: "CancelSync" },
			...(sessionId
				? [{ _tag: "SyncDraft" as const, sessionId, text: "" }]
				: []),
		],
	];
}

/**
 * Failure rules: unknown snapshots do nothing; dirty text rejects server text;
 * failed writes keep acked; late acknowledgements name their session and text;
 * switching flushes the outgoing tail; send failures restore only an empty box.
 * Reload backups deliberately retain the existing [sessionId, text][] format.
 */
export function step(
	state: DraftState,
	event: DraftEvent,
): [DraftState, DraftCommand[]] {
	switch (event._tag) {
		case "TextChanged":
			return [{ ...state, text: event.text }, []];
		case "LocalEdited":
			// New-session storage keeps its existing trailing debounce until ticket .5.
			if (!state.sessionId)
				return [state, [{ _tag: "ScheduleSync", delay: 300 }]];
			if (state.snapshot !== "ready") return [{ ...state, pending: true }, []];
			if (state.throttled) return [{ ...state, pending: true }, []];
			return [
				{ ...state, throttled: true, pending: false },
				[
					{ _tag: "SyncDraft", sessionId: state.sessionId, text: state.text },
					{ _tag: "ScheduleSync", delay: 300 },
				],
			];
		case "SubscriptionStarted":
			return event.sessionId === state.sessionId
				? [
						{ ...state, snapshot: "waiting", throttled: false },
						[{ _tag: "CancelSync" }],
					]
				: [state, []];
		case "ServerTextReceived": {
			if (event.sessionId !== state.sessionId) return [state, []];
			const next =
				!(event.initial && state.snapshot === "overlapped") &&
				event.text !== undefined &&
				(state.text === state.acked || state.text === "")
					? { ...state, text: event.text, acked: event.text }
					: state;
			// Consume the initial read before resending offline edits. Otherwise a
			// fast ack could make an older, delayed snapshot look safe to apply.
			// A forced hide/send flush also supersedes an initial read already in flight.
			return event.initial
				? step(
						{ ...next, snapshot: "ready" },
						{ _tag: "Flush", serverOnly: true },
					)
				: [next, []];
		}
		case "SyncSucceeded": {
			if (event.sessionId === state.sessionId)
				return [{ ...state, acked: event.text }, []];
			const draft = state.drafts.get(event.sessionId);
			if (!draft) return [state, []];
			const drafts = new Map(state.drafts);
			drafts.set(event.sessionId, { ...draft, acked: event.text });
			return [{ ...state, drafts }, []];
		}
		case "SyncFailed":
			return [state, []];
		case "SessionSwitched": {
			if (event.sessionId === state.sessionId) return [state, []];
			const drafts = new Map(state.drafts);
			if (state.sessionId)
				drafts.set(state.sessionId, { text: state.text, acked: state.acked });
			return [
				{
					...state,
					drafts,
					sessionId: event.sessionId,
					...(event.sessionId
						? (drafts.get(event.sessionId) ?? { text: "", acked: "" })
						: { text: event.newSessionText, acked: "" }),
					throttled: false,
					pending: false,
					snapshot: "waiting",
				},
				[
					{ _tag: "CancelSync" },
					...(state.sessionId && state.text !== state.acked
						? [
								{
									_tag: "SyncDraft" as const,
									sessionId: state.sessionId,
									text: state.text,
								},
							]
						: []),
				],
			];
		}
		case "SyncDue":
			if (!state.sessionId)
				return [state, [{ _tag: "WriteNewSessionDraft", text: state.text }]];
			if (state.snapshot !== "ready")
				return [{ ...state, throttled: false }, []];
			return [
				{ ...state, throttled: state.pending, pending: false },
				state.pending
					? [
							{
								_tag: "SyncDraft",
								sessionId: state.sessionId,
								text: state.text,
							},
							{ _tag: "ScheduleSync", delay: 300 },
						]
					: [],
			];
		case "Hidden":
		case "Flush":
			if (!state.sessionId && event._tag === "Hidden") return [state, []];
			return [
				{
					...state,
					throttled: false,
					pending: false,
					snapshot:
						state.snapshot === "waiting" &&
						state.sessionId &&
						state.text !== state.acked
							? "overlapped"
							: state.snapshot,
				},
				[
					{ _tag: "CancelSync" },
					...(state.sessionId
						? state.text !== state.acked
							? [
									{
										_tag: "SyncDraft" as const,
										sessionId: state.sessionId,
										text: state.text,
									},
								]
							: []
						: event._tag === "Flush" && event.serverOnly
							? []
							: [{ _tag: "WriteNewSessionDraft" as const, text: state.text }]),
				],
			];
		case "Cleared":
			return clear(state, event.sessionId);
		case "SendStarted":
			return event.clear ? clear(state, event.sessionId) : [state, []];
		case "SendFailed": {
			const sameScope = event.sentTo
				? event.sessionId === event.sentTo
				: !event.sessionId && event.sameProject;
			if (!event.restore || !sameScope || state.text || event.hasAttachments)
				return [state, []];
			const restored = { ...state, text: event.text };
			return state.sessionId
				? step(restored, { _tag: "LocalEdited" })
				: [restored, []];
		}
		case "SendSucceeded": {
			if (!event.steer) return [state, []];
			if (event.sessionId === event.sentTo)
				return event.clear ? clear(state, event.sessionId) : [state, []];
			const drafts = new Map(state.drafts);
			if (event.sentTo) drafts.set(event.sentTo, { text: "", acked: "" });
			return [{ ...state, drafts }, []];
		}
		case "SessionCreated":
			return [state, [{ _tag: "ClearNewSessionDraft" }]];
		case "SideThreadSent": {
			const active = state.sessionId === event.parentSessionId;
			const text = active
				? state.text
				: state.drafts.get(event.parentSessionId)?.text;
			if (text !== event.text || !event.attachmentsUnchanged)
				return [state, []];
			const drafts = new Map(state.drafts);
			drafts.set(event.parentSessionId, { text: "", acked: "" });
			return [
				{
					...state,
					drafts,
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
					{ _tag: "SyncDraft", sessionId: event.parentSessionId, text: "" },
				],
			];
		}
		case "ReloadRestored": {
			const drafts = new Map(state.drafts);
			for (const [id, text] of event.entries)
				drafts.set(id, { text, acked: "" });
			return [{ ...state, drafts }, []];
		}
		case "PersistBeforeReload": {
			const commands: DraftCommand[] = event.sessionId
				? []
				: [{ _tag: "WriteNewSessionDraft", text: state.text }];
			if (event.hasAttachments) return [state, commands];
			const drafts = new Map(state.drafts);
			drafts.set(event.sessionId ?? "", {
				text: state.text,
				acked: state.acked,
			});
			commands.push({
				_tag: "SaveReloadBackup",
				entries: [...drafts].map(([id, draft]) => [id, draft.text]),
			});
			return [{ ...state, drafts }, commands];
		}
		default:
			event satisfies never;
			return [state, []];
	}
}
