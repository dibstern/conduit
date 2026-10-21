// The daemon's protocol, build and restart state (SubscribeServerStatus) drives
// four banners: stale daemon, stale page, build mismatch and server update.
// The feed re-sends the whole status on every change, so each part acts only
// when its own value moves; that keeps a dismissed banner dismissed.

import { Stream } from "effect";
import { BUILD_ID } from "../../build-id.js";
import type {
	GetStatusResponse,
	ServerStatus,
} from "../../contracts/ws-rpc.js";
import * as Failure from "../../effect/failure-classification.js";
import { WS_PROTOCOL_VERSION } from "../../shared-types.js";
import { failureLine, toastFailure } from "../transport/rpc-errors.js";
import {
	setRedialBuildCheck,
	type WsRpcSubscriptions,
} from "../transport/shared-client.js";
import type { WsRpcError } from "../transport/ws-rpc.js";
import { rpc } from "../transport/ws-rpc-client.js";
import {
	claimBuildReload,
	refreshAppShell,
	releaseBuildReload,
} from "../utils/build-id.js";
import { persistInputDraft } from "./chat.svelte.js";
import { refreshListedSessions } from "./session-list.svelte.js";
import { removeBanner, showBanner, showToast } from "./ui.svelte.js";

const STALE_DAEMON_BANNER_ID = "stale-daemon";
const STALE_PAGE_BANNER_ID = "stale-page";
const BUILD_MISMATCH_BANNER_ID = "build-mismatch";
const SERVER_UPDATE_BANNER_ID = "server-update";

let last: ServerStatus | null = null;
// Set while a build reload is in flight; never settles once the tab navigates.
let buildReload: Promise<void> | null = null;
let buildMismatchWarning = false;
let serverUpdateAvailable = false;
export const serverStatus = $state<{
	status: GetStatusResponse | null;
	loading: boolean;
	error: string | null;
	restartInFlight: boolean;
	restartAccepted: boolean;
	shutdownInFlight: boolean;
}>({
	status: null,
	loading: false,
	error: null,
	restartInFlight: false,
	restartAccepted: false,
	shutdownInFlight: false,
});

let statusRequest = 0;

export async function loadServerStatus(): Promise<void> {
	const { status, loading } = serverStatus;
	if (status === null && !loading) await refreshServerStatus();
}

/** Only the latest read can replace the snapshot after a mutation or reconnect. */
export async function refreshServerStatus(): Promise<void> {
	const request = ++statusRequest;
	serverStatus.loading = true;
	serverStatus.error = null;
	try {
		const status = await rpc("GetStatus", {});
		if (request !== statusRequest) return;
		serverStatus.status = status;
		serverStatus.loading = false;
	} catch (error: unknown) {
		if (request !== statusRequest) return;
		serverStatus.loading = false;
		serverStatus.error = failureLine(error, "Could not load server status.");
	}
}

export async function restartServer(): Promise<void> {
	if (
		serverStatus.restartInFlight ||
		serverStatus.restartAccepted ||
		serverStatus.shutdownInFlight
	)
		return;
	serverStatus.restartInFlight = true;
	try {
		await rpc("RestartWithConfig", {});
		serverStatus.restartAccepted = true;
		removeBanner(SERVER_UPDATE_BANNER_ID);
		showToast("Restarting conduit…");
	} catch (error: unknown) {
		toastFailure("Failed to restart conduit")(error);
		if (serverUpdateAvailable) showServerUpdateBanner();
	} finally {
		serverStatus.restartInFlight = false;
	}
}

export async function shutdownServer(): Promise<void> {
	serverStatus.shutdownInFlight = true;
	try {
		await rpc("Shutdown", {});
	} finally {
		serverStatus.shutdownInFlight = false;
	}
}

export function applyServerStatus(status: ServerStatus): void {
	const previous = last;
	last = status;
	if (previous === null) {
		serverStatus.restartAccepted = false;
		if (serverStatus.status !== null) void refreshServerStatus();
	}
	if (
		previous === null ||
		previous.protocolVersion !== status.protocolVersion ||
		previous.buildId !== status.buildId
	) {
		handleProtocolVersion(status.protocolVersion);
		void handleBuildId(status.buildId);
	}
	if (previous?.restartAvailable !== status.restartAvailable) {
		handleServerUpdate(status.restartAvailable);
	}
	if (
		previous !== null &&
		previous.sessionsRevision !== status.sessionsRevision
	)
		void refreshListedSessions();
}

/**
 * The status feed for one connection. Each connection starts from a blank
 * slate, so a reconnect re-checks the build like the old on-connect handshake
 * did; that retry is what releases a reload deferred by an unsaved draft.
 *
 * A daemon older than SubscribeServerStatus answers it with an unknown-tag
 * defect, and @effect/rpc fails every open request on that socket with it.
 * Show the stale-daemon banner and stop asking, or each retry would knock the
 * other feeds over again.
 */
export const serverStatusFeed = (
	subscriptions: Pick<WsRpcSubscriptions, "serverStatus">,
): Stream.Stream<ServerStatus, WsRpcError> =>
	Stream.suspend(() => {
		last = null;
		return subscriptions.serverStatus({
			onTransportDrop: () => {
				last = null;
			},
		});
	}).pipe(
		Stream.catchCause((cause) => {
			if (!Failure.renderCause(cause).includes("Unknown request tag"))
				return Stream.failCause(cause);
			showStaleDaemonBanner();
			return Stream.never;
		}),
	);

/** Attaching a project resets per-project state, banners included; put the
 *  server-update banner back if a restart is still on offer. */
export function restoreServerUpdateBanner(): void {
	handleServerUpdate(serverUpdateAvailable);
}

function showBuildMismatchBanner(): void {
	buildMismatchWarning = true;
	if (serverUpdateAvailable) return;
	showBanner({
		id: BUILD_MISMATCH_BANNER_ID,
		variant: "warning",
		icon: "refresh-cw",
		text: "This page and the server have different builds. Restart the server, then reload this tab. Your draft is still here.",
		summary: "Restart the server",
		dismissible: false,
	});
}

function showServerUpdateBanner(): void {
	showBanner({
		id: SERVER_UPDATE_BANNER_ID,
		variant: "update",
		icon: "refresh-cw",
		text: "A new conduit build is ready. Restart the server to load it. Sessions and terminals keep running.",
		summary: "New build ready",
		dismissible: true,
		action: {
			label: "Restart",
			run: restartServer,
		},
	});
}

function handleServerUpdate(restartAvailable: boolean): void {
	serverUpdateAvailable = restartAvailable;
	if (restartAvailable) {
		removeBanner(BUILD_MISMATCH_BANNER_ID);
		if (!serverStatus.restartInFlight && !serverStatus.restartAccepted)
			showServerUpdateBanner();
	} else {
		removeBanner(SERVER_UPDATE_BANNER_ID);
		if (buildMismatchWarning) showBuildMismatchBanner();
	}
}

function handleBuildId(serverBuildId: string): Promise<void> {
	if (buildReload) return buildReload;
	const action = claimBuildReload(BUILD_ID, serverBuildId);
	if (action === "current") {
		buildMismatchWarning = false;
		removeBanner(BUILD_MISMATCH_BANNER_ID);
		return Promise.resolve();
	}
	if (action === "warn") {
		showBuildMismatchBanner();
		return Promise.resolve();
	}
	showToast({
		title: "Conduit was updated",
		body: "Saving your draft and reloading…",
		duration: 1_000,
	});
	buildReload = (async () => {
		try {
			await refreshAppShell();
			// Leave the notice visible briefly; save after any last keystrokes.
			await new Promise((resolve) => setTimeout(resolve, 750));
			if (await persistInputDraft()) {
				location.reload();
				// Hold a waiting redial until the page unloads.
				return new Promise<void>(() => {});
			}
		} catch {
			// Failed worker updates and draft saves also keep this tab open.
		}
		releaseBuildReload(serverBuildId);
		buildReload = null;
		showBuildMismatchBanner();
	})();
	return buildReload;
}

// Redials ask the build over plain HTTP before any RPC: a daemon from another
// build may speak an RPC wire this tab cannot decode, so a mismatch reloads the
// tab without sending it a frame. Until the server answers, the socket could
// not reach it either, so the check waits rather than letting a dial race the
// restart. An answer without a buildId (an older server) lets the dial go.
setRedialBuildCheck(async () => {
	for (;;) {
		// Only an ok JSON object answers; errors, HTML and timeouts mean retry.
		const info: unknown = await fetch("/info", {
			cache: "no-store",
			signal: AbortSignal.timeout(5_000),
		})
			.then((response) => (response.ok ? response.json() : null))
			.catch(() => null);
		if (typeof info === "object" && info !== null && !Array.isArray(info)) {
			// The warn and abandoned-reload paths return here: banner, then dial.
			if ("buildId" in info && typeof info.buildId === "string")
				await handleBuildId(info.buildId);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
});

function showStaleDaemonBanner(): void {
	showBanner({
		id: STALE_DAEMON_BANNER_ID,
		variant: "warning",
		icon: "alert-triangle",
		text: "The conduit daemon is running an older version than this page — restart the daemon to avoid inconsistent behavior.",
		summary: "Restart the daemon",
		dismissible: true,
	});
}

function handleProtocolVersion(version: number): void {
	if (version === WS_PROTOCOL_VERSION) {
		removeBanner(STALE_DAEMON_BANNER_ID);
		removeBanner(STALE_PAGE_BANNER_ID);
	} else if (version < WS_PROTOCOL_VERSION) {
		removeBanner(STALE_PAGE_BANNER_ID);
		showStaleDaemonBanner();
	} else {
		removeBanner(STALE_DAEMON_BANNER_ID);
		showBanner({
			id: STALE_PAGE_BANNER_ID,
			variant: "update",
			icon: "refresh-cw",
			text: "Conduit was updated. Reload this tab to keep things working.",
			summary: "Reload this tab",
			dismissible: true,
			action: { label: "Reload", run: () => location.reload() },
		});
	}
}
