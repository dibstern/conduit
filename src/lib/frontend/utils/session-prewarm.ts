import {
	type PreWarmDraftRpcInput,
	preWarmDraftRpc,
	preWarmSessionRpc,
} from "../transport/ws-rpc-client.js";

let pending: ReturnType<typeof setTimeout> | undefined;
let pendingKey: string | undefined;
let lastKey: string | undefined;
let lastRequestedAt = 0;

/** Session-open and focus hints share a debounce and never wait on startup. */
export function requestSessionPreWarm(sessionId: string | null): void {
	const key = sessionId ?? undefined;
	if (key && key === pendingKey) return;
	clearTimeout(pending);
	pending = undefined;
	pendingKey = undefined;
	if (!sessionId) return;
	if (key === lastKey && Date.now() - lastRequestedAt < 1000) return;
	pendingKey = key;
	pending = setTimeout(() => {
		pending = undefined;
		pendingKey = undefined;
		lastKey = key;
		lastRequestedAt = Date.now();
		void preWarmSessionRpc({ sessionId }).catch(() => undefined);
	}, 100);
}

let draftPending: ReturnType<typeof setTimeout> | undefined;
let draftPendingKey: string | undefined;
let draftLastKey: string | undefined;
let draftLastRequestedAt = 0;

/** Draft hints follow the displayed creation payload without delaying send. */
export function requestDraftPreWarm(input?: PreWarmDraftRpcInput): void {
	const key = input ? JSON.stringify(input) : undefined;
	if (key && key === draftPendingKey) return;
	clearTimeout(draftPending);
	draftPending = undefined;
	draftPendingKey = undefined;
	if (!key || !input) return;
	if (key === draftLastKey && Date.now() - draftLastRequestedAt < 1000) return;
	draftPendingKey = key;
	draftPending = setTimeout(() => {
		draftPending = undefined;
		draftPendingKey = undefined;
		draftLastKey = key;
		draftLastRequestedAt = Date.now();
		void preWarmDraftRpc(input).catch(() => undefined);
	}, 100);
}
