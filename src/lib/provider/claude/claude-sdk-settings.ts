import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Keys whose trust depends on which tier they arrived from: the CLI ignores
 * them from `project`/`local` because those files are repo-controllable, but
 * trusts them from the flag tier. Conduit occupies the flag tier, so passing
 * one through would launder a repo-derived value past a deliberate check.
 * See ADR-0003.
 *
 * Verified against @anthropic-ai/claude-agent-sdk 0.3.258. Note that
 * `Settings` carries a `[k: string]: unknown` index signature, so
 * `satisfies readonly (keyof Settings)[]` accepts any string whatsoever and
 * would assert nothing here. `autoMode` in particular is absent from the
 * published types and exists only in the CLI bundle. The list is pinned by
 * test instead — see claude-sdk-settings.test.ts.
 */
export const CLAUDE_TRUST_TIERED_SETTINGS_KEYS: readonly string[] = [
	"permissions",
	"autoMode",
];

/**
 * The flag-layer settings Conduit sends at session start: its own defaults
 * plus the user's explicit overrides. Trust-tiered keys are dropped before the
 * merge, so they never enter the object at all.
 */
export function buildClaudeFlagSettings(overrides?: Settings): Settings {
	const permitted = Object.entries(overrides ?? {}).filter(
		([key, value]) =>
			value !== undefined && !CLAUDE_TRUST_TIERED_SETTINGS_KEYS.includes(key),
	);

	return { showThinkingSummaries: true, ...Object.fromEntries(permitted) };
}
