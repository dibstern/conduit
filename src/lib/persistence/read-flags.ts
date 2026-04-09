// src/lib/persistence/read-flags.ts

/**
 * Three-state read path mode for each Phase 4 sub-phase.
 *
 * - "legacy": Serve from legacy source (JSONL/REST/memory). No SQLite query.
 * - "shadow": Serve from legacy source. Query SQLite in background, log diffs.
 *             Use this to validate SQLite correctness before switching reads.
 * - "sqlite": Serve from SQLite. Query legacy in background, log diffs.
 *             Use this when confident SQLite is correct.
 *
 * Progression: legacy → shadow → sqlite → (Phase 7 removes legacy entirely)
 */
export type ReadFlagMode = "legacy" | "shadow" | "sqlite";

export interface ReadFlagConfig {
	toolContent?: ReadFlagMode;
	forkMetadata?: ReadFlagMode;
	sessionList?: ReadFlagMode;
	sessionStatus?: ReadFlagMode;
	sessionHistory?: ReadFlagMode;
	pendingApprovals?: ReadFlagMode;
}

export interface ReadFlags {
	toolContent: ReadFlagMode;
	forkMetadata: ReadFlagMode;
	sessionList: ReadFlagMode;
	sessionStatus: ReadFlagMode;
	sessionHistory: ReadFlagMode;
	pendingApprovals: ReadFlagMode;
}

/** Normalize a config value that may be a boolean (backward compat) or a mode string. */
function normalizeMode(
	value: ReadFlagMode | boolean | undefined,
): ReadFlagMode {
	if (value === undefined) return "legacy";
	if (value === true) return "sqlite";
	if (value === false) return "legacy";
	return value;
}

export function createReadFlags(config?: ReadFlagConfig): ReadFlags {
	return {
		toolContent: normalizeMode(
			config?.toolContent as ReadFlagMode | boolean | undefined,
		),
		forkMetadata: normalizeMode(
			config?.forkMetadata as ReadFlagMode | boolean | undefined,
		),
		sessionList: normalizeMode(
			config?.sessionList as ReadFlagMode | boolean | undefined,
		),
		sessionStatus: normalizeMode(
			config?.sessionStatus as ReadFlagMode | boolean | undefined,
		),
		sessionHistory: normalizeMode(
			config?.sessionHistory as ReadFlagMode | boolean | undefined,
		),
		pendingApprovals: normalizeMode(
			config?.pendingApprovals as ReadFlagMode | boolean | undefined,
		),
	};
}

// ─── Mode Check Helpers ─────────────────────────────────────────────────────
//
// (C1) CRITICAL: DO NOT use `if (flags.toolContent)` — all non-empty strings
// are truthy, so "legacy" would activate the SQLite path. Always use these
// helpers. All Phase 4 handlers (Tasks 25-34) must use:
//   `if (isActive(this.readFlags?.sessionList) && this.readQuery)`
// instead of:
//   `if (this.readFlags?.sessionList && this.readQuery)`

/** Returns true if the mode involves querying SQLite (shadow or sqlite). */
export function isActive(mode: ReadFlagMode | undefined): boolean {
	return mode === "shadow" || mode === "sqlite";
}

/** Returns true if SQLite is the authoritative source. */
export function isSqlite(mode: ReadFlagMode | undefined): boolean {
	return mode === "sqlite";
}

/** Returns true if the mode is shadow (legacy authoritative, SQLite compared). */
export function isShadow(mode: ReadFlagMode | undefined): boolean {
	return mode === "shadow";
}
