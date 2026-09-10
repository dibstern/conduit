import type {
	ClaudeSettingsOverrides,
	JsonValue,
	ResolvedClaudeSettings,
} from "../../contracts/claude-settings.js";
import type {
	ClaudeSettingsResponse,
	ResolveClaudeSettingsResponse,
} from "../transport/ws-rpc.js";
import type { RelayMessage } from "../types.js";

export type ClaudeSettingKey = keyof ResolvedClaudeSettings;
export type ClaudeSettingsResolutionStatus =
	| "idle"
	| "loading"
	| "ready"
	| "error"
	| "unavailable";

export const claudeSettingsState = $state({
	projectSlug: null as string | null,
	overrides: {} as ClaudeSettingsOverrides,
	resolved: {} as Partial<ResolvedClaudeSettings>,
	resolutionStatus: "idle" as ClaudeSettingsResolutionStatus,
	editedKeys: [] as ClaudeSettingKey[],
});

export function applyClaudeSettingsResponse(
	response: ClaudeSettingsResponse,
): void {
	if (
		claudeSettingsState.projectSlug !== null &&
		claudeSettingsState.projectSlug !== response.projectSlug
	) {
		return;
	}
	claudeSettingsState.projectSlug = response.projectSlug;
	claudeSettingsState.overrides = { ...response.overrides };
}

export function handleClaudeSettingsInfo(
	message: Extract<RelayMessage, { type: "claude_settings_info" }>,
): void {
	claudeSettingsState.overrides = { ...message.overrides };
}

export function setClaudeSettingsOverridesOptimistically(
	overrides: ClaudeSettingsOverrides,
): void {
	claudeSettingsState.overrides = { ...overrides };
}

export function beginClaudeSettingsResolution(projectSlug: string): void {
	if (claudeSettingsState.projectSlug !== projectSlug) {
		claudeSettingsState.overrides = {};
	}
	claudeSettingsState.projectSlug = projectSlug;
	claudeSettingsState.resolved = {};
	claudeSettingsState.resolutionStatus = "loading";
}

export function applyResolvedClaudeSettingsResponse(
	response: ResolveClaudeSettingsResponse,
): void {
	if (claudeSettingsState.projectSlug !== response.projectSlug) return;
	claudeSettingsState.resolved = Object.fromEntries(
		Object.entries(response.resolved).map(([key, value]) => [
			key,
			{ ...value },
		]),
	) as Partial<ResolvedClaudeSettings>;
	claudeSettingsState.resolutionStatus = "ready";
}

export function failClaudeSettingsResolution(projectSlug: string): void {
	if (claudeSettingsState.projectSlug !== projectSlug) return;
	claudeSettingsState.resolved = {};
	claudeSettingsState.resolutionStatus = "error";
}

export function markClaudeSettingsResolutionUnavailable(
	projectSlug: string,
): void {
	if (claudeSettingsState.projectSlug !== projectSlug) {
		claudeSettingsState.overrides = {};
	}
	claudeSettingsState.projectSlug = projectSlug;
	claudeSettingsState.resolved = {};
	claudeSettingsState.resolutionStatus = "unavailable";
}

export function clearClaudeSettingsState(): void {
	claudeSettingsState.projectSlug = null;
	claudeSettingsState.overrides = {};
	claudeSettingsState.resolved = {};
	claudeSettingsState.resolutionStatus = "idle";
	claudeSettingsState.editedKeys = [];
}

export function setClaudeSettingEdited(
	key: ClaudeSettingKey,
	edited: boolean,
): void {
	const keys = new Set(claudeSettingsState.editedKeys);
	if (edited) keys.add(key);
	else keys.delete(key);
	claudeSettingsState.editedKeys = [...keys];
}

export function clearClaudeSettingEdits(): void {
	claudeSettingsState.editedKeys = [];
}

const SOURCE_LABELS = {
	user: "your user settings",
	project: "this project's settings",
	local: "this project's local settings",
	managed: "managed policy",
} as const;

type DisplayableSource = keyof typeof SOURCE_LABELS;

export interface ClaudeSettingProvenance {
	readonly kind:
		| "checking"
		| "unavailable"
		| "edited"
		| "set-here"
		| "inherited"
		| "locked";
	readonly text: string;
	readonly beforeSource?: string;
	readonly sourceLabel?: string;
	readonly afterSource?: string;
	readonly sourcePath?: string;
	readonly canReset: boolean;
	readonly locked: boolean;
}

const hasOverride = (key: ClaudeSettingKey): boolean =>
	Object.hasOwn(claudeSettingsState.overrides, key);

const isDisplayableSource = (
	source: string | undefined,
): source is DisplayableSource =>
	source !== undefined && Object.hasOwn(SOURCE_LABELS, source);

const formatValue = (value: JsonValue): string => {
	if (typeof value === "boolean") return value ? "on" : "off";
	return typeof value === "string" ? value : JSON.stringify(value);
};

export function getClaudeSettingValue(
	key: ClaudeSettingKey,
): JsonValue | undefined {
	if (
		claudeSettingsState.resolutionStatus === "ready" &&
		claudeSettingsState.resolved[key]?.source === "managed"
	) {
		return claudeSettingsState.resolved[key]?.value;
	}
	return hasOverride(key)
		? claudeSettingsState.overrides[key]
		: claudeSettingsState.resolved[key]?.value;
}

export function describeClaudeSettingProvenance(
	key: ClaudeSettingKey,
	edited: boolean,
	options?: { invertBoolean?: boolean },
): ClaudeSettingProvenance {
	const resolved = claudeSettingsState.resolved[key];
	const resettable = hasOverride(key);

	if (
		claudeSettingsState.resolutionStatus === "ready" &&
		resolved?.source === "managed"
	) {
		return {
			kind: "locked",
			beforeSource: "Locked by ",
			sourceLabel: SOURCE_LABELS.managed,
			...(resolved.path !== undefined ? { sourcePath: resolved.path } : {}),
			text: "Locked by managed policy",
			canReset: false,
			locked: true,
		};
	}

	if (edited) {
		return {
			kind: "edited",
			text: "Applies to your next session",
			canReset: resettable,
			locked: false,
		};
	}

	if (claudeSettingsState.resolutionStatus === "loading") {
		return {
			kind: "checking",
			text: "Checking…",
			canReset: resettable,
			locked: false,
		};
	}

	if (
		claudeSettingsState.resolutionStatus === "error" ||
		claudeSettingsState.resolutionStatus === "unavailable"
	) {
		return {
			kind: "unavailable",
			text: "Couldn't read settings files",
			canReset: resettable,
			locked: false,
		};
	}

	if (resettable) {
		if (resolved?.value !== undefined && isDisplayableSource(resolved.source)) {
			const sourceLabel = SOURCE_LABELS[resolved.source];
			const displayValue =
				options?.invertBoolean === true && typeof resolved.value === "boolean"
					? !resolved.value
					: resolved.value;
			if (typeof displayValue === "object" && displayValue !== null) {
				return {
					kind: "set-here",
					beforeSource: "Set here · overrides ",
					sourceLabel,
					...(resolved.path !== undefined ? { sourcePath: resolved.path } : {}),
					text: `Set here · overrides ${sourceLabel}`,
					canReset: true,
					locked: false,
				};
			}
			const afterSource = ` had ${formatValue(displayValue)}`;
			return {
				kind: "set-here",
				beforeSource: "Set here · ",
				sourceLabel,
				afterSource,
				...(resolved.path !== undefined ? { sourcePath: resolved.path } : {}),
				text: `Set here · ${sourceLabel}${afterSource}`,
				canReset: true,
				locked: false,
			};
		}
		return {
			kind: "set-here",
			text: "Set here",
			canReset: true,
			locked: false,
		};
	}

	if (isDisplayableSource(resolved?.source)) {
		const sourceLabel = SOURCE_LABELS[resolved.source];
		return {
			kind: "inherited",
			beforeSource: "From ",
			sourceLabel,
			...(resolved.path !== undefined ? { sourcePath: resolved.path } : {}),
			text: `From ${sourceLabel}`,
			canReset: false,
			locked: false,
		};
	}

	return {
		kind: "inherited",
		beforeSource: "From ",
		sourceLabel: "Claude defaults",
		text: "From Claude defaults",
		canReset: false,
		locked: false,
	};
}
