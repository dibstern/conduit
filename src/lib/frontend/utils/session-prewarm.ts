import { preWarmSessionRpc } from "../transport/ws-rpc-client.js";

let pending: ReturnType<typeof setTimeout> | undefined;
let pendingKey: string | undefined;
let lastKey: string | undefined;
let lastRequestedAt = 0;

/** Session-open and focus hints share a debounce and never wait on startup. */
export function requestSessionPreWarm(
	projectSlug: string | null,
	sessionId: string | null,
): void {
	const key =
		projectSlug && sessionId ? `${projectSlug}/${sessionId}` : undefined;
	if (key && key === pendingKey) return;
	clearTimeout(pending);
	pending = undefined;
	pendingKey = undefined;
	if (!key || !projectSlug || !sessionId) return;
	if (key === lastKey && Date.now() - lastRequestedAt < 1000) return;
	pendingKey = key;
	pending = setTimeout(() => {
		pending = undefined;
		pendingKey = undefined;
		lastKey = key;
		lastRequestedAt = Date.now();
		void preWarmSessionRpc({ projectSlug, sessionId }).catch(() => undefined);
	}, 100);
}
