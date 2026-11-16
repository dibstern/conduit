import { replaceRoute } from "../stores/router.svelte.js";
import { wsDebugLog } from "../stores/ws-debug.svelte.js";
import type { ConnectionStatus } from "../types.js";

export const connectionState = $state({
	status: "" as ConnectionStatus,
	statusText: "",
	attempts: 0,
	projectStatus: undefined as "registering" | "ready" | "error" | undefined,
	projectError: undefined as string | undefined,
});

let controlSocket: WebSocket | null = null;
let lastMessageAt = 0;
let projectStatusGeneration = 0;
/** The shown session's or draft's project, whose relay readiness the overlay shows. */
let statusProject: string | null = null;
// Advances on proof of authentication, so a slower probe sent before it
// cannot send the user back to the PIN page.
let authGeneration = 0;

export function getIsConnected(): boolean {
	return connectionState.status === "connected";
}

/** Non-blocking relay readiness for the current dial. */
function fetchProjectStatus(slug: string): void {
	const generation = ++projectStatusGeneration;
	const isCurrent = () =>
		statusProject === slug && projectStatusGeneration === generation;
	connectionState.projectStatus = undefined;
	connectionState.projectError = undefined;
	fetch(`/p/${slug}/api/status`)
		.then((res) => (isCurrent() && res.ok ? res.json() : null))
		.then((data: { status?: string; error?: string } | null) => {
			if (!data || !isCurrent()) return;
			if (data.status === "registering" || data.status === "ready") {
				connectionState.projectStatus = data.status;
			} else if (data.status === "error") {
				connectionState.projectStatus = "error";
				connectionState.projectError = data.error;
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

/** Follow the readiness of the shown session's or draft's project relay. */
export function viewProjectStatus(project: string | null): void {
	if (project === statusProject) return;
	statusProject = project;
	if (project) fetchProjectStatus(project);
}

/**
 * A rejected upgrade only surfaces as a close before open, and RPC redials
 * forever. Ask the public auth endpoint so an expired PIN session shows the
 * PIN page even when no project is attached.
 */
function redirectIfPinRequired(): void {
	const generation = authGeneration;
	fetch("/api/auth/status")
		.then((res) => (res.ok ? res.json() : null))
		.then((auth: { hasPin?: boolean; authenticated?: boolean } | null) => {
			if (auth?.hasPin && !auth.authenticated && generation === authGeneration)
				replaceRoute("/auth");
		})
		.catch(() => {
			// Daemon unreachable: keep redialing.
		});
}

/** Called once the PIN is accepted. */
export function markAuthenticated(): void {
	authGeneration++;
}

/** Called by the control constructor on every dial, including RPC retries. */
export function trackControlSocket(socket: WebSocket): void {
	controlSocket = socket;
	lastMessageAt = Date.now();
	connectionState.status = "connecting";
	connectionState.statusText = "Connecting";
	connectionState.attempts++;
	connectionState.projectStatus = undefined;
	connectionState.projectError = undefined;
	wsDebugLog("rpc:connect", connectionState.status);
	let opened = false;

	socket.addEventListener("open", () => {
		opened = true;
	});
	socket.addEventListener("close", () => {
		if (controlSocket !== socket) return;
		controlSocket = null;
		connectionState.status = "disconnected";
		connectionState.statusText = "Disconnected";
		wsDebugLog("rpc:close", connectionState.status);
		if (!opened) redirectIfPinRequired();
	});
	socket.addEventListener("message", () => {
		if (controlSocket === socket) lastMessageAt = Date.now();
	});

	if (statusProject) fetchProjectStatus(statusProject);
}

/**
 * Called by the RPC protocol once it accepts the open control socket. The raw
 * "open" event is too early: requests placed then still fail with the previous
 * drop's error.
 */
export function markControlSocketOpen(): void {
	// A socket that closed before the protocol got here has already reported it.
	if (!controlSocket) return;
	authGeneration++;
	lastMessageAt = Date.now();
	connectionState.status = "connected";
	connectionState.statusText = "Connected";
	connectionState.attempts = 0;
	connectionState.projectStatus = undefined;
	connectionState.projectError = undefined;
	wsDebugLog("rpc:open", connectionState.status);
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
