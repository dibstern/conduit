// ─── Relay Settings Persistence ──────────────────────────────────────────────
// Load/save relay-specific settings from ~/.conduit/settings.jsonc.
// Separate from OpenCode's own config — the relay has its own settings file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { ClaudeSettingsOverrides } from "../contracts/claude-settings.js";
import type { ModelOverride } from "../domain/relay/Services/session-overrides-state.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import {
	type SessionPermissionMode,
	SessionPermissionModeSchema,
} from "../shared-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RelaySettings {
	defaultModel?: string;
	defaultPermissionMode?: SessionPermissionMode;
	defaultVariants?: Record<string, string>;
	/** Model keys ("<providerId>/<modelId>") hidden from the model dropdown. */
	hiddenModels?: string[];
	/** Agent keys ("<scopeId>/<agentId>") hidden from the agent dropdown. */
	hiddenAgents?: string[];
	/** Global Claude SDK flag-layer overrides. */
	claudeSettings?: ClaudeSettingsOverrides;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SETTINGS_FILE = "settings.jsonc";

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveDir(configDir?: string): string {
	return configDir ?? DEFAULT_CONFIG_DIR;
}

/** Strip single-line (//) and multi-line (/* *​/) comments from JSONC text. */
function stripComments(text: string): string {
	return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// ─── Public API ─────────────────────────────────────────────────────────────

const isSessionPermissionMode = Schema.is(SessionPermissionModeSchema);

const isPermissionMode = (
	value: unknown,
): value is SessionPermissionMode | undefined =>
	value === undefined || isSessionPermissionMode(value);

/**
 * Load relay settings from the config directory.
 * Returns empty object if file doesn't exist or is corrupt.
 */
export function loadRelaySettings(configDir?: string): RelaySettings {
	try {
		const dir = resolveDir(configDir);
		const raw = readFileSync(join(dir, SETTINGS_FILE), "utf-8");
		const settings = JSON.parse(stripComments(raw)) as RelaySettings;
		// The file is hand-editable, so an unknown mode reaches getPermissionMode
		// as a value no caller can interpret — the pill would fall back to "Ask"
		// while the session ran under something else. Drop it and use the default.
		if (isPermissionMode(settings.defaultPermissionMode)) return settings;
		const { defaultPermissionMode: _unusable, ...rest } = settings;
		return rest;
	} catch {
		return {};
	}
}

/**
 * Save relay settings to the config directory.
 * Uses load-merge-save to preserve existing fields not present in the update.
 * Creates the directory if it doesn't exist. Uses atomic write (tmp + rename).
 */
export function saveRelaySettings(
	settings: RelaySettings,
	configDir?: string,
): void {
	const dir = resolveDir(configDir);
	mkdirSync(dir, { recursive: true });

	// Load-merge-save: preserve existing fields not present in the new settings
	const existing = loadRelaySettings(configDir);
	const merged: RelaySettings = { ...existing };

	if (settings.defaultModel !== undefined) {
		merged.defaultModel = settings.defaultModel;
	}
	if (settings.defaultPermissionMode !== undefined) {
		merged.defaultPermissionMode = settings.defaultPermissionMode;
	}

	// Merge defaultVariants map (shallow merge of entries)
	if (settings.defaultVariants) {
		merged.defaultVariants = {
			...existing.defaultVariants,
			...settings.defaultVariants,
		};
	}

	// Hidden lists use replace semantics: a provided array wins wholesale,
	// including an empty array (which clears the list).
	if (settings.hiddenModels !== undefined) {
		merged.hiddenModels = [...settings.hiddenModels];
	}
	if (settings.hiddenAgents !== undefined) {
		merged.hiddenAgents = [...settings.hiddenAgents];
	}

	// Claude settings use replace semantics so removing a key unpins it.
	if (settings.claudeSettings !== undefined) {
		merged.claudeSettings = { ...settings.claudeSettings };
	}

	const tmpPath = join(dir, `.${SETTINGS_FILE}.tmp`);
	const finalPath = join(dir, SETTINGS_FILE);
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
	renameSync(tmpPath, finalPath);
}

/**
 * Parse a "provider/model" string into a ModelOverride.
 * Returns undefined for empty or missing input.
 */
export function parseDefaultModel(
	value: string | undefined,
): ModelOverride | undefined {
	if (!value) return undefined;
	const slashIdx = value.indexOf("/");
	if (slashIdx <= 0) return undefined;
	return {
		providerID: value.slice(0, slashIdx),
		modelID: value.slice(slashIdx + 1),
	};
}
