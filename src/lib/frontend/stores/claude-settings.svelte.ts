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

// ─── Server-owned state ─────────────────────────────────────────────────────
// What the relay says this project's Claude settings are. The `apply*`,
// `handle*` and resolution functions below are the only writers.

const serverClaudeSettings = $state({
	projectSlug: null as string | null,
	overrides: {} as ClaudeSettingsOverrides,
	resolved: {} as Partial<ResolvedClaudeSettings>,
	resolutionStatus: "idle" as ClaudeSettingsResolutionStatus,
});

// ─── Client-owned state ─────────────────────────────────────────────────────
// The panel shows a toggle's new position the moment it is clicked, before the
// relay has confirmed the write: `pendingOverrides` is that unconfirmed value,
// and reads fall through to the server's when it is null. `editedKeys` is the
// set of settings this user has touched, which drives the "set here" marks.
// Applying a relay response never touches `editedKeys`.

const clientClaudeSettings = $state({
	pendingOverrides: null as ClaudeSettingsOverrides | null,
	editedKeys: [] as ClaudeSettingKey[],
});

/** Which write `pendingOverrides` belongs to, so a rejection can tell whether
 *  it is still undoing its own optimism. Plain, not `$state`: nothing shows it. */
let pendingWrite: symbol | null = null;

/** Read view over both halves. The server half is readable but has no setter:
 *  write it by applying a relay response. */
export const claudeSettingsState = {
	get projectSlug(): string | null {
		return serverClaudeSettings.projectSlug;
	},
	/** The value of an in-flight write if there is one, else the relay's. */
	get overrides(): ClaudeSettingsOverrides {
		return (
			clientClaudeSettings.pendingOverrides ?? serverClaudeSettings.overrides
		);
	},
	get resolved(): Partial<ResolvedClaudeSettings> {
		return serverClaudeSettings.resolved;
	},
	get resolutionStatus(): ClaudeSettingsResolutionStatus {
		return serverClaudeSettings.resolutionStatus;
	},
	get editedKeys(): readonly ClaudeSettingKey[] {
		return clientClaudeSettings.editedKeys;
	},
};

/** The relay has spoken, so an in-flight write is now either confirmed or
 *  overtaken — either way it is no longer the value to show. */
function setServerOverrides(overrides: ClaudeSettingsOverrides): void {
	serverClaudeSettings.overrides = { ...overrides };
	clientClaudeSettings.pendingOverrides = null;
	pendingWrite = null;
}

export function applyClaudeSettingsResponse(
	response: ClaudeSettingsResponse,
): void {
	if (
		serverClaudeSettings.projectSlug !== null &&
		serverClaudeSettings.projectSlug !== response.projectSlug
	) {
		return;
	}
	serverClaudeSettings.projectSlug = response.projectSlug;
	setServerOverrides(response.overrides);
}

export function handleClaudeSettingsInfo(
	message: Extract<RelayMessage, { type: "claude_settings_info" }>,
): void {
	setServerOverrides(message.overrides);
}

/**
 * Show a write before the relay has confirmed it, and hand back the undo for
 * *that* write: call it when the relay refuses. It drops back to the relay's
 * value rather than to a remembered one, and does nothing at all once a newer
 * write — or a broadcast that landed meanwhile — owns what is on screen.
 */
export function proposeClaudeSettingsOverrides(
	overrides: ClaudeSettingsOverrides,
): () => void {
	const write = Symbol("claude settings write");
	pendingWrite = write;
	clientClaudeSettings.pendingOverrides = { ...overrides };
	return () => {
		if (pendingWrite !== write) return;
		pendingWrite = null;
		clientClaudeSettings.pendingOverrides = null;
	};
}

export function beginClaudeSettingsResolution(projectSlug: string): void {
	if (serverClaudeSettings.projectSlug !== projectSlug) setServerOverrides({});
	serverClaudeSettings.projectSlug = projectSlug;
	serverClaudeSettings.resolved = {};
	serverClaudeSettings.resolutionStatus = "loading";
}

export function applyResolvedClaudeSettingsResponse(
	response: ResolveClaudeSettingsResponse,
): void {
	if (serverClaudeSettings.projectSlug !== response.projectSlug) return;
	serverClaudeSettings.resolved = Object.fromEntries(
		Object.entries(response.resolved).map(([key, value]) => [
			key,
			{ ...value },
		]),
	) as Partial<ResolvedClaudeSettings>;
	serverClaudeSettings.resolutionStatus = "ready";
}

export function failClaudeSettingsResolution(projectSlug: string): void {
	if (serverClaudeSettings.projectSlug !== projectSlug) return;
	serverClaudeSettings.resolved = {};
	serverClaudeSettings.resolutionStatus = "error";
}

export function markClaudeSettingsResolutionUnavailable(
	projectSlug: string,
): void {
	if (serverClaudeSettings.projectSlug !== projectSlug) setServerOverrides({});
	serverClaudeSettings.projectSlug = projectSlug;
	serverClaudeSettings.resolved = {};
	serverClaudeSettings.resolutionStatus = "unavailable";
}

export function clearClaudeSettingsState(): void {
	serverClaudeSettings.projectSlug = null;
	serverClaudeSettings.resolved = {};
	serverClaudeSettings.resolutionStatus = "idle";
	setServerOverrides({});
	clientClaudeSettings.editedKeys = [];
}

export function setClaudeSettingEdited(
	key: ClaudeSettingKey,
	edited: boolean,
): void {
	const keys = new Set(clientClaudeSettings.editedKeys);
	if (edited) keys.add(key);
	else keys.delete(key);
	clientClaudeSettings.editedKeys = [...keys];
}

export function clearClaudeSettingEdits(): void {
	clientClaudeSettings.editedKeys = [];
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
