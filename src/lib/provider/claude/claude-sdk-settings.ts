import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_TRUST_TIERED_SETTINGS_KEYS } from "../../contracts/claude-settings.js";

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
