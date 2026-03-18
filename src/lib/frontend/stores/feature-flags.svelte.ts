// ─── Feature Flags ──────────────────────────────────────────────────────────
// Typed, extensible feature flag system with URL, localStorage, and UI activation.
// URL: ?feats=debug,foo (comma-separated, validated, persisted to localStorage)
// localStorage: key "feature-flags" (JSON array of flag names)
// UI: Settings dialog toggle calls toggleFeature("debug")

/** All known feature flags. Add new ones here and in the featureFlags $state. */
export type FeatureFlag = "debug";

/** All valid flag names for runtime validation. */
const VALID_FLAGS: readonly FeatureFlag[] = ["debug"] as const;

const STORAGE_KEY = "feature-flags";

// ─── State ──────────────────────────────────────────────────────────────────

export const featureFlags = $state({
	debug: false,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse ?feats=debug,foo URL param. Returns only valid FeatureFlag values. */
export function parseFeatsParam(value: string): FeatureFlag[] {
	return value
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s): s is FeatureFlag => VALID_FLAGS.includes(s as FeatureFlag))
		.filter((v, i, a) => a.indexOf(v) === i); // dedupe
}

/** Read enabled flags from localStorage. */
function readStorage(): FeatureFlag[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(s: unknown): s is FeatureFlag =>
				typeof s === "string" && VALID_FLAGS.includes(s as FeatureFlag),
		);
	} catch {
		return [];
	}
}

/** Write enabled flags to localStorage. */
function writeStorage(flags: FeatureFlag[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
	} catch {
		/* ignore */
	}
}

/** Apply a list of flags to the reactive state. */
function applyFlags(flags: FeatureFlag[]): void {
	for (const flag of VALID_FLAGS) {
		featureFlags[flag] = flags.includes(flag);
	}
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize feature flags from URL params and localStorage.
 * URL params take precedence and are persisted to localStorage.
 * Call once on app mount.
 */
export function initFeatureFlags(): void {
	const stored = readStorage();
	applyFlags(stored);

	// Check URL — ?feats=debug,foo
	try {
		const url = new URL(window.location.href);
		const featsParam = url.searchParams.get("feats");
		if (featsParam) {
			const fromUrl = parseFeatsParam(featsParam);
			// Merge: URL flags enable, don't disable stored ones
			const merged = [...new Set([...stored, ...fromUrl])];
			applyFlags(merged);
			writeStorage(merged);
		}
	} catch {
		/* ignore — SSR or test environment */
	}
}

export function isFeatureEnabled(flag: FeatureFlag): boolean {
	return featureFlags[flag];
}

export function enableFeature(flag: FeatureFlag): void {
	featureFlags[flag] = true;
	const current = readStorage();
	if (!current.includes(flag)) {
		writeStorage([...current, flag]);
	}
}

export function disableFeature(flag: FeatureFlag): void {
	featureFlags[flag] = false;
	const current = readStorage();
	writeStorage(current.filter((f) => f !== flag));
}

export function toggleFeature(flag: FeatureFlag): void {
	if (featureFlags[flag]) {
		disableFeature(flag);
	} else {
		enableFeature(flag);
	}
}

export function getEnabledFeatures(): FeatureFlag[] {
	return VALID_FLAGS.filter((f) => featureFlags[f]);
}
