// ─── Instance Store ─────────────────────────────────────────────────────────
// Manages the list of OpenCode instances and their statuses.
//
// Two layers of state:
// - `instanceState.instances` — live data, cleared on WS disconnect
// - `cachedInstances` — last-known data, survives WS disconnect
//
// Components that need data while disconnected (SettingsPanel, ConnectOverlay)
// should use `getCachedInstances()` or `getCachedInstanceById()`.

import type {
	DetectProxyResponse,
	InstanceListResponse,
	ScanNowResponse,
} from "../transport/ws-rpc.js";
import type {
	InstanceStatus,
	OpenCodeInstance,
	RelayMessage,
} from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const instanceState = $state({
	instances: [] as OpenCodeInstance[],
});

/**
 * Cached copy of the last-known instance list. Survives WS disconnect
 * so the SettingsPanel and ConnectOverlay can still show instance data.
 * Updated whenever a fresh instance_list arrives.
 *
 * Must be $state() so that $derived(getCachedInstances()) in SettingsPanel
 * and ConnectOverlay re-renders when the cache is updated.
 */
let cachedInstances: OpenCodeInstance[] = $state([]);

// ─── Proxy detection state ──────────────────────────────────────────────────

let proxyDetection: { found: boolean; port: number } | null = $state(null);

/**
 * Initiate proxy detection with a timeout. If no response arrives within
 * the timeout, set proxyDetection to { found: false, port: 8317 }.
 */
let proxyDetectTimer: ReturnType<typeof setTimeout> | null = null;

export function beginProxyDetection(): void {
	if (proxyDetectTimer) clearTimeout(proxyDetectTimer);
	proxyDetection = null;
	proxyDetectTimer = setTimeout(() => {
		if (proxyDetection === null) {
			proxyDetection = { found: false, port: 8317 };
		}
		proxyDetectTimer = null;
	}, 5_000);
}

export function handleProxyDetected(
	msg: Extract<RelayMessage, { type: "proxy_detected" }>,
): void {
	if (proxyDetectTimer) {
		clearTimeout(proxyDetectTimer);
		proxyDetectTimer = null;
	}
	proxyDetection = { found: msg.found, port: msg.port };
}

export function getProxyDetection(): { found: boolean; port: number } | null {
	return proxyDetection;
}

export function applyDetectProxyResponse(response: DetectProxyResponse): void {
	handleProxyDetected({
		type: "proxy_detected",
		found: response.found,
		port: response.port,
	});
}

// ─── Scan state ─────────────────────────────────────────────────────────────

interface ScanResult {
	discovered: number[];
	lost: number[];
	active: number[];
}

let lastScanResult: ScanResult | null = $state(null);
let scanInFlight = $state(false);

export function getScanResult(): ScanResult | null {
	return lastScanResult;
}

export function isScanInFlight(): boolean {
	return scanInFlight;
}

export function beginScan(): void {
	scanInFlight = true;
}

/** Clear the scan-in-flight flag (e.g. when the server returns an error). */
export function clearScanInFlight(): void {
	scanInFlight = false;
}

export function handleScanResult(
	msg: Extract<RelayMessage, { type: "scan_result" }>,
): void {
	lastScanResult = {
		discovered: msg.discovered,
		lost: msg.lost,
		active: msg.active,
	};
	scanInFlight = false;
}

export function applyScanNowResponse(response: ScanNowResponse): void {
	handleScanResult({
		type: "scan_result",
		discovered: [...response.discovered],
		lost: [...response.lost],
		active: [...response.active],
	});
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleInstanceList(
	msg: Extract<RelayMessage, { type: "instance_list" }>,
): void {
	if (Array.isArray(msg.instances)) {
		instanceState.instances = msg.instances;
		// Keep a cached copy that survives disconnect
		cachedInstances = [...msg.instances];
	}
}

export function applyInstanceListResponse(
	response: InstanceListResponse,
): void {
	handleInstanceList({
		type: "instance_list",
		instances: response.instances.map((instance) => ({
			id: instance.id,
			name: instance.name,
			port: instance.port,
			managed: instance.managed,
			status: instance.status,
			restartCount: instance.restartCount,
			createdAt: instance.createdAt,
			...(instance.pid != null ? { pid: instance.pid } : {}),
			...(instance.env != null ? { env: { ...instance.env } } : {}),
			...(instance.needsRestart != null
				? { needsRestart: instance.needsRestart }
				: {}),
			...(instance.exitCode != null ? { exitCode: instance.exitCode } : {}),
			...(instance.lastHealthCheck != null
				? { lastHealthCheck: instance.lastHealthCheck }
				: {}),
		})),
	});
}

export function handleInstanceStatus(
	msg: Extract<RelayMessage, { type: "instance_status" }>,
): void {
	const idx = instanceState.instances.findIndex((i) => i.id === msg.instanceId);
	if (idx !== -1) {
		instanceState.instances[idx] = {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior null check
			...instanceState.instances[idx]!,
			status: msg.status,
		};
	}
	// Also update the cache
	const cacheIdx = cachedInstances.findIndex((i) => i.id === msg.instanceId);
	if (cacheIdx !== -1) {
		cachedInstances[cacheIdx] = {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior null check
			...cachedInstances[cacheIdx]!,
			status: msg.status,
		};
	}
}

// ─── Getters ────────────────────────────────────────────────────────────────

export function getInstanceById(id: string): OpenCodeInstance | undefined {
	return instanceState.instances.find((i) => i.id === id);
}

/** Returns only healthy instances. Used by InstanceSelector UI (deferred). */
export function getHealthyInstances(): OpenCodeInstance[] {
	return instanceState.instances.filter((i) => i.status === "healthy");
}

/**
 * Returns the cached instance list (survives WS disconnect).
 * Use this in UI that must show instance data while disconnected
 * (e.g. SettingsPanel opened from ConnectOverlay).
 */
export function getCachedInstances(): OpenCodeInstance[] {
	return cachedInstances;
}

/**
 * Look up an instance by ID from the cache (survives WS disconnect).
 */
export function getCachedInstanceById(
	id: string,
): OpenCodeInstance | undefined {
	return cachedInstances.find((i) => i.id === id);
}

/** Returns a Tailwind bg color class for the given instance status. */
export function instanceStatusColor(
	status: InstanceStatus | undefined,
): string {
	switch (status) {
		case "healthy":
			return "bg-green-500";
		case "starting":
			return "bg-yellow-500";
		case "unhealthy":
			return "bg-red-500";
		case "stopped":
		case undefined:
			return "bg-zinc-500";
	}
}

// ─── Reset ──────────────────────────────────────────────────────────────────

export function clearInstanceState(): void {
	instanceState.instances = [];
	proxyDetection = null;
	scanInFlight = false;
	if (proxyDetectTimer) {
		clearTimeout(proxyDetectTimer);
		proxyDetectTimer = null;
	}
	// NOTE: cachedInstances is intentionally NOT cleared here.
	// It preserves the last-known instance data so disconnected UI
	// (SettingsPanel, ConnectOverlay) can still show instance info.
}
