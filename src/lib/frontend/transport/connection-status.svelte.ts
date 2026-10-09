import { attachedProjectState, replaceRoute } from "../stores/router.svelte.js";
import { wsDebugLog } from "../stores/ws-debug.svelte.js";
import { onProjectAttached } from "../stores/ws-listeners.js";
import type { ConnectionStatus } from "../types.js";

export const connectionState = $state({
	status: "" as ConnectionStatus,
	statusText: "",
	attempts: 0,
	relayStatus: undefined as "registering" | "ready" | "error" | undefined,
	relayError: undefined as string | undefined,
});

let controlSocket: WebSocket | null = null;
let lastMessageAt = 0;
let relayStatusGeneration = 0;

export function getIsConnected(): boolean {
	return connectionState.status === "connected";
}

/** Non-blocking relay readiness and PIN-session recovery for the current dial. */
function fetchRelayStatus(slug: string): void {
	const generation = ++relayStatusGeneration;
	// Every attach/dial starts a new probe. A close alone must still allow the
	// current probe's 401 to recover from a rejected WebSocket upgrade.
	const isCurrent = () =>
		attachedProjectState.slug === slug && relayStatusGeneration === generation;
	connectionState.relayStatus = undefined;
	connectionState.relayError = undefined;
	fetch(`/p/${slug}/api/status`)
		.then((res) => {
			if (!isCurrent()) return null;
			if (res.status === 401) {
				replaceRoute("/auth");
				return null;
			}
			if (!res.ok) return null;
			return res.json();
		})
		.then((data: { status?: string; error?: string } | null) => {
			if (!data || !isCurrent()) return;
			if (data.status === "registering" || data.status === "ready") {
				connectionState.relayStatus = data.status;
			} else if (data.status === "error") {
				connectionState.relayStatus = "error";
				connectionState.relayError = data.error;
			}
			wsDebugLog(
				"relay:status",
				connectionState.status,
				`status=${data.status}`,
			);
		})
		.catch(() => {
			// Readiness only enriches the UI; a failed probe does not block RPC.
		});
}

onProjectAttached(fetchRelayStatus);

/** Called by the control constructor on every dial, including RPC retries. */
export function trackControlSocket(socket: WebSocket): void {
	controlSocket = socket;
	lastMessageAt = Date.now();
	connectionState.status = "connecting";
	connectionState.statusText = "Connecting";
	connectionState.attempts++;
	connectionState.relayStatus = undefined;
	connectionState.relayError = undefined;
	wsDebugLog("rpc:connect", connectionState.status);

	socket.addEventListener("open", () => {
		if (controlSocket !== socket) return;
		lastMessageAt = Date.now();
		connectionState.status = "connected";
		connectionState.statusText = "Connected";
		connectionState.attempts = 0;
		connectionState.relayStatus = undefined;
		connectionState.relayError = undefined;
		wsDebugLog("rpc:open", connectionState.status);
	});
	socket.addEventListener("close", () => {
		if (controlSocket !== socket) return;
		controlSocket = null;
		connectionState.status = "disconnected";
		connectionState.statusText = "Disconnected";
		wsDebugLog("rpc:close", connectionState.status);
	});
	socket.addEventListener("message", () => {
		if (controlSocket === socket) lastMessageAt = Date.now();
	});

	if (attachedProjectState.slug) fetchRelayStatus(attachedProjectState.slug);
}

function reconnectIfStale(): void {
	if (controlSocket && Date.now() - lastMessageAt > 15_000) {
		wsDebugLog("rpc:resume", connectionState.status);
		// RPC retries even a clean close; closing skips the next ping timeout.
		controlSocket.close();
	}
}

if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") reconnectIfStale();
	});
	window.addEventListener("pageshow", reconnectIfStale);
}
