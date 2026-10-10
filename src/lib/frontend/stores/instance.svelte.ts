// Manages the list of OpenCode instances and their statuses.
//
// Two layers of state:
// - `instanceState.instances` — live data, cleared on WS disconnect
// - `cachedInstances` — last-known data, survives WS disconnect
//
// Components that need data while disconnected (SettingsPanel, ConnectOverlay)
// should use `getCachedInstances()` or `getCachedInstanceById()`.

import type { ProviderSessionCapabilities } from "../../contracts/provider-instance.js";
import type {
	DetectProxyResponse,
	InstanceListResponse,
	ScanNowResponse,
} from "../transport/ws-rpc.js";
import type { InstanceStatus, OpenCodeInstance } from "../types.js";

// This store has no client half: every field is an instance row, a cached copy
// of one, or the result of a probe the server answered.

export const instanceState = $state({
	instances: [] as OpenCodeInstance[],
	providerCapabilities: {} as Record<
		string,
		ProviderSessionCapabilities | undefined
	>,
});

/**
 * Cached copy of the last-known instance list. Survives WS disconnect
 * so the SettingsPanel and ConnectOverlay can still show instance data.
 * Updated whenever a fresh instance list arrives.
 *
 * Must be $state() so that $derived(getCachedInstances()) in SettingsPanel
 * and ConnectOverlay re-renders when the cache is updated.
 */
let cachedInstances: OpenCodeInstance[] = $state([]);

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

export function getProxyDetection(): { found: boolean; port: number } | null {
	return proxyDetection;
}

export function applyDetectProxyResponse(response: DetectProxyResponse): void {
	if (proxyDetectTimer) {
		clearTimeout(proxyDetectTimer);
		proxyDetectTimer = null;
	}
	proxyDetection = { found: response.found, port: response.port };
}

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

export function applyScanNowResponse(response: ScanNowResponse): void {
	lastScanResult = {
		discovered: [...response.discovered],
		lost: [...response.lost],
		active: [...response.active],
	};
	scanInFlight = false;
}

/** Apply a full instance list: the subscription's, or a mutation's reply. */
export function applyInstanceListResponse(
	response: Pick<InstanceListResponse, "instances" | "providerCapabilities">,
): void {
	const instances: OpenCodeInstance[] = response.instances.map((instance) => ({
		id: instance.id,
		name: instance.name,
		port: instance.port,
		managed: instance.managed,
		status: instance.status,
		restartCount: instance.restartCount,
		createdAt: instance.createdAt,
		...(instance.driver != null ? { driver: instance.driver } : {}),
		...(instance.capabilities != null
			? { capabilities: instance.capabilities }
			: {}),
		...(instance.configDir != null ? { configDir: instance.configDir } : {}),
		...(instance.url != null ? { url: instance.url } : {}),
		...(instance.pid != null ? { pid: instance.pid } : {}),
		...(instance.env != null ? { env: { ...instance.env } } : {}),
		...(instance.needsRestart != null
			? { needsRestart: instance.needsRestart }
			: {}),
		...(instance.exitCode != null ? { exitCode: instance.exitCode } : {}),
		...(instance.lastHealthCheck != null
			? { lastHealthCheck: instance.lastHealthCheck }
			: {}),
	}));
	instanceState.instances = instances;
	if (response.providerCapabilities) {
		instanceState.providerCapabilities = { ...response.providerCapabilities };
	}
	// Keep a cached copy that survives disconnect
	cachedInstances = [...instances];
}

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

export function clearInstanceState(): void {
	instanceState.instances = [];
	instanceState.providerCapabilities = {};
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
