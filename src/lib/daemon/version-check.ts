// ─── Version Check (Ticket 3.4) ────────────────────────────────────────────────
// Periodically checks npm for newer versions and notifies browsers via events.

import { getVersion } from "../version.js";
import type { ServiceRegistry } from "./service-registry.js";
import { TrackedService } from "./tracked-service.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_PACKAGE_NAME = "conduit-code";
const DEFAULT_CHECK_INTERVAL = 14_400_000; // 4 hours
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface VersionCheckOptions {
	/** npm package name (default: "conduit-code") */
	packageName?: string;
	/** Current version string (default: from package.json) */
	currentVersion?: string;
	/** Check interval in ms (default: 4 hours / 14_400_000) */
	checkInterval?: number;
	/** npm registry URL (default: "https://registry.npmjs.org") */
	registryUrl?: string;
	/** Set to false to disable checking entirely (e.g. --no-update) */
	enabled?: boolean;
	/** Injectable fetch for testing */
	_fetch?: typeof globalThis.fetch;
}

export interface VersionCheckResult {
	current: string;
	latest: string;
	updateAvailable: boolean;
}

export type VersionCheckEvents = {
	update_available: [{ current: string; latest: string }];
	check_error: [{ error: Error }];
};

// ─── Semver comparison ─────────────────────────────────────────────────────────

/**
 * Returns true if `latest` is a newer semver than `current`.
 *
 * Handles:
 * - major.minor.patch comparison
 * - Leading 'v' prefix (stripped)
 * - Pre-release tags: 1.0.0-beta < 1.0.0 (release wins over pre-release)
 */
export function isNewer(current: string, latest: string): boolean {
	const parsedCurrent = parseSemver(current);
	const parsedLatest = parseSemver(latest);

	if (!parsedCurrent || !parsedLatest) return false;

	// Compare major.minor.patch
	for (let i = 0; i < 3; i++) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		if (parsedLatest.parts[i]! > parsedCurrent.parts[i]!) return true;
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		if (parsedLatest.parts[i]! < parsedCurrent.parts[i]!) return false;
	}

	// Same major.minor.patch — check pre-release
	// A release (no pre-release) is newer than a pre-release
	if (parsedCurrent.prerelease && !parsedLatest.prerelease) return true;
	if (!parsedCurrent.prerelease && parsedLatest.prerelease) return false;

	// Both have pre-release or both lack it — compare pre-release lexically
	if (parsedCurrent.prerelease && parsedLatest.prerelease) {
		return (
			comparePrereleases(parsedCurrent.prerelease, parsedLatest.prerelease) > 0
		);
	}

	return false;
}

interface ParsedSemver {
	parts: [number, number, number];
	prerelease: string | null;
}

function parseSemver(version: string): ParsedSemver | null {
	// Strip leading 'v'
	const cleaned = version.startsWith("v") ? version.slice(1) : version;

	// Split on '-' for pre-release
	const [core, ...prereleaseParts] = cleaned.split("-");
	const prerelease =
		prereleaseParts.length > 0 ? prereleaseParts.join("-") : null;

	if (!core) return null;
	const segments = core.split(".");
	if (segments.length !== 3) return null;

	const nums = segments.map(Number);
	if (nums.some((n) => Number.isNaN(n) || n < 0)) return null;

	return {
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		parts: [nums[0]!, nums[1]!, nums[2]!],
		prerelease,
	};
}

/**
 * Compare two pre-release strings.
 * Returns > 0 if `b` is newer (latest wins), < 0 if `a` is newer, 0 if equal.
 *
 * Pre-release identifiers are compared segment-by-segment:
 * - Numeric segments are compared as integers
 * - String segments are compared lexicographically
 * - Numeric < String
 * - Fewer segments < more segments when all preceding segments are equal
 */
function comparePrereleases(a: string, b: string): number {
	const aParts = a.split(".");
	const bParts = b.split(".");

	const len = Math.max(aParts.length, bParts.length);
	for (let i = 0; i < len; i++) {
		// Fewer segments = lower precedence
		if (i >= aParts.length) return 1; // b has more segments, b is newer
		if (i >= bParts.length) return -1; // a has more segments, a is newer

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior null check
		const aPart = aParts[i]!;
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior null check
		const bPart = bParts[i]!;
		const aIsNum = /^\d+$/.test(aPart);
		const bIsNum = /^\d+$/.test(bPart);

		if (aIsNum && bIsNum) {
			const diff = Number(bPart) - Number(aPart);
			if (diff !== 0) return diff;
		} else if (aIsNum && !bIsNum) {
			// Numeric < string
			return 1; // b (string) is newer
		} else if (!aIsNum && bIsNum) {
			return -1; // a (string) is newer
		} else {
			// Both strings — lexicographic
			if (aPart < bPart) return 1; // b is newer
			if (aPart > bPart) return -1;
		}
	}

	return 0;
}

// ─── Registry fetch ────────────────────────────────────────────────────────────

/**
 * Fetch the latest version of a package from the npm registry.
 * Throws on network errors or unexpected responses.
 */
export async function fetchLatestVersion(
	packageName: string,
	registryUrl: string,
	_fetch?: typeof globalThis.fetch,
	signal?: AbortSignal,
): Promise<string> {
	const fetchFn = _fetch ?? globalThis.fetch;
	const url = `${registryUrl}/${encodeURIComponent(packageName)}/latest`;

	const response = await fetchFn(url, {
		headers: { Accept: "application/json" },
		...(signal ? { signal } : {}),
	});

	if (!response.ok) {
		throw new Error(
			`npm registry returned ${response.status} for ${packageName}`,
		);
	}

	const data = (await response.json()) as { version?: string };

	if (!data.version || typeof data.version !== "string") {
		throw new Error(
			`npm registry returned no version field for ${packageName}`,
		);
	}

	return data.version;
}

// ─── VersionChecker ────────────────────────────────────────────────────────────

export class VersionChecker extends TrackedService<VersionCheckEvents> {
	private readonly packageName: string;
	private readonly currentVersion: string;
	private readonly checkInterval: number;
	private readonly registryUrl: string;
	private readonly enabled: boolean;
	private readonly fetchFn: typeof globalThis.fetch | undefined;

	private intervalHandle: ReturnType<typeof setInterval> | null = null;
	private latestVersion: string | null = null;
	private updateAvailable = false;

	constructor(registry: ServiceRegistry, options?: VersionCheckOptions) {
		super(registry);
		this.packageName = options?.packageName ?? DEFAULT_PACKAGE_NAME;
		this.currentVersion = options?.currentVersion ?? getVersion();
		this.checkInterval = options?.checkInterval ?? DEFAULT_CHECK_INTERVAL;
		this.registryUrl = options?.registryUrl ?? DEFAULT_REGISTRY_URL;
		this.enabled = options?.enabled ?? true;
		this.fetchFn = options?._fetch;
	}

	/** Start periodic checking. Performs an immediate check, then checks on interval. */
	start(): void {
		if (!this.enabled) return;

		// Perform initial check (non-blocking — errors emitted, not thrown)
		this.runCheck();

		// Schedule periodic checks (tracked — cleared automatically on drain)
		this.intervalHandle = this.repeating(() => {
			this.runCheck();
		}, this.checkInterval);
	}

	/** Stop periodic checking. */
	stop(): void {
		if (this.intervalHandle !== null) {
			this.clearTrackedTimer(this.intervalHandle);
			this.intervalHandle = null;
		}
	}

	/** Perform a single version check now. */
	async check(): Promise<VersionCheckResult> {
		const latest = await fetchLatestVersion(
			this.packageName,
			this.registryUrl,
			this.fetchFn,
			this.abortSignal,
		);

		this.latestVersion = latest;
		const hasUpdate = isNewer(this.currentVersion, latest);
		this.updateAvailable = hasUpdate;

		if (hasUpdate) {
			this.emit("update_available", {
				current: this.currentVersion,
				latest,
			});
		}

		return {
			current: this.currentVersion,
			latest,
			updateAvailable: hasUpdate,
		};
	}

	/** Whether an update is available (based on last check). */
	isUpdateAvailable(): boolean {
		return this.updateAvailable;
	}

	/** Get the latest known version from the last check, or null if never checked. */
	getLatestVersion(): string | null {
		return this.latestVersion;
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	/** Run a check, catching errors and emitting check_error. Tracked for drain. */
	private runCheck(): void {
		this.tracked(
			this.check().catch((err: unknown) => {
				const error = err instanceof Error ? err : new Error(String(err));
				this.emit("check_error", { error });
			}),
		);
	}
}
