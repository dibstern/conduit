// Load/save settings.jsonc in the config dir (DEFAULT_CONFIG_DIR).
// Separate from OpenCode's own config — the relay has its own settings file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { ClaudeSettingsOverrides } from "../contracts/claude-settings.js";
import {
	type SessionMode,
	SessionModeSchema,
} from "../contracts/project-file.js";
import type { KnownProviderDriverKind } from "../contracts/provider-instance.js";
import type { ModelOverride } from "../domain/relay/Services/session-overrides-state.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import {
	type GroupingMode,
	GroupingModeSchema,
	type SessionPermissionMode,
	SessionPermissionModeSchema,
} from "../shared-types.js";

export interface RelaySettings {
	defaultModel?: string;
	harnessDefaults?: Partial<
		Record<
			KnownProviderDriverKind,
			{ providerId: string; modelId: string; contextWindow: string }
		>
	>;
	defaultPermissionMode?: SessionPermissionMode;
	defaultSessionMode?: SessionMode;
	defaultGroupingMode?: GroupingMode;
	defaultVariants?: Record<string, string>;
	/** Model keys ("<providerId>/<modelId>") hidden from the model dropdown. */
	hiddenModels?: string[];
	/** Agent keys ("<scopeId>/<agentId>") hidden from the agent dropdown. */
	hiddenAgents?: string[];
	/** Global Claude SDK flag-layer overrides. */
	claudeSettings?: ClaudeSettingsOverrides;
}

const SETTINGS_FILE = "settings.jsonc";

function resolveDir(configDir?: string): string {
	return configDir ?? DEFAULT_CONFIG_DIR;
}

/** Strip single-line (//) and multi-line (/* *​/) comments from JSONC text. */
function stripComments(text: string): string {
	return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const isSessionPermissionMode = Schema.is(SessionPermissionModeSchema);
const isSessionMode = Schema.is(SessionModeSchema);
const isGroupingMode = Schema.is(GroupingModeSchema);

/**
 * Load relay settings from the config directory.
 * Returns empty object if file doesn't exist or is corrupt.
 */
export function loadRelaySettings(configDir?: string): RelaySettings {
	try {
		const dir = resolveDir(configDir);
		const raw = readFileSync(join(dir, SETTINGS_FILE), "utf-8");
		const settings = JSON.parse(stripComments(raw)) as RelaySettings;
		// The file is hand-editable. Drop unknown modes so consumers use their defaults.
		const {
			defaultPermissionMode,
			defaultSessionMode,
			defaultGroupingMode,
			...rest
		} = settings;
		return {
			...rest,
			...(defaultPermissionMode !== undefined &&
				isSessionPermissionMode(defaultPermissionMode) && {
					defaultPermissionMode,
				}),
			...(defaultSessionMode !== undefined &&
				isSessionMode(defaultSessionMode) && { defaultSessionMode }),
			...(defaultGroupingMode !== undefined &&
				isGroupingMode(defaultGroupingMode) && { defaultGroupingMode }),
		};
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
	if (settings.harnessDefaults) {
		merged.harnessDefaults = {
			...existing.harnessDefaults,
			...settings.harnessDefaults,
		};
	}
	if (settings.defaultPermissionMode !== undefined) {
		merged.defaultPermissionMode = settings.defaultPermissionMode;
	}
	if (settings.defaultSessionMode !== undefined) {
		merged.defaultSessionMode = settings.defaultSessionMode;
	}
	if (settings.defaultGroupingMode !== undefined) {
		merged.defaultGroupingMode = settings.defaultGroupingMode;
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
