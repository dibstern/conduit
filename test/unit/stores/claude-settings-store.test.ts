import { beforeEach, describe, expect, it } from "vitest";
import type {
	ClaudeSettingsOverrides,
	ResolvedClaudeSettings,
} from "../../../src/lib/contracts/claude-settings.js";
import {
	applyClaudeSettingsResponse,
	applyResolvedClaudeSettingsResponse,
	beginClaudeSettingsResolution,
	claudeSettingsState,
	clearClaudeSettingsState,
	describeClaudeSettingProvenance,
	failClaudeSettingsResolution,
	getClaudeSettingValue,
	handleClaudeSettingsInfo,
	markClaudeSettingsResolutionUnavailable,
	proposeClaudeSettingsOverrides,
	setClaudeSettingEdited,
} from "../../../src/lib/frontend/stores/claude-settings.svelte.js";

beforeEach(() => {
	clearClaudeSettingsState();
});

/** Every displayable key resolved to nothing — the base a test layers over. */
const NOTHING_RESOLVED: ResolvedClaudeSettings = {
	autoCompactEnabled: {},
	autoCompactWindow: {},
	alwaysThinkingEnabled: {},
	disableAllHooks: {},
	cleanupPeriodDays: {},
	attribution: {},
};

/** Fill the store the way the relay does: the overrides broadcast, then the
 *  resolution response for the project those overrides belong to. */
function seedSettings(
	overrides: ClaudeSettingsOverrides,
	resolved: Partial<ResolvedClaudeSettings> = {},
): void {
	beginClaudeSettingsResolution("project-a");
	handleClaudeSettingsInfo({ type: "claude_settings_info", overrides });
	applyResolvedClaudeSettingsResponse({
		projectSlug: "project-a",
		instanceId: "claude",
		resolved: { ...NOTHING_RESOLVED, ...resolved },
	});
}

describe("Claude settings store", () => {
	it("applies RPC reads, optimistic writes, and confirming broadcasts", () => {
		applyClaudeSettingsResponse({
			projectSlug: "project-a",
			overrides: { autoCompactEnabled: true },
		});
		expect(claudeSettingsState.overrides).toEqual({
			autoCompactEnabled: true,
		});

		proposeClaudeSettingsOverrides({ autoCompactWindow: 24_000 });
		expect(claudeSettingsState.overrides).toEqual({
			autoCompactWindow: 24_000,
		});

		handleClaudeSettingsInfo({
			type: "claude_settings_info",
			overrides: { autoCompactEnabled: false },
		});
		expect(claudeSettingsState.overrides).toEqual({
			autoCompactEnabled: false,
		});
	});

	it("keeps this user's edit marks when the relay broadcasts", () => {
		setClaudeSettingEdited("autoCompactEnabled", true);

		handleClaudeSettingsInfo({
			type: "claude_settings_info",
			overrides: { autoCompactWindow: 12_000 },
		});

		expect(claudeSettingsState.editedKeys).toEqual(["autoCompactEnabled"]);
	});

	it("reverts a failed write to the relay's value, not a remembered one", () => {
		handleClaudeSettingsInfo({
			type: "claude_settings_info",
			overrides: { autoCompactEnabled: true },
		});
		const undo = proposeClaudeSettingsOverrides({ autoCompactEnabled: false });

		// Someone else's change lands while our write is still in flight.
		handleClaudeSettingsInfo({
			type: "claude_settings_info",
			overrides: { autoCompactWindow: 8_000 },
		});
		undo(); // ...and then ours is rejected.

		expect(claudeSettingsState.overrides).toEqual({ autoCompactWindow: 8_000 });
	});

	it("lets a newer write stand when an older one is rejected", () => {
		handleClaudeSettingsInfo({
			type: "claude_settings_info",
			overrides: { autoCompactEnabled: true },
		});

		const undoFirst = proposeClaudeSettingsOverrides({
			autoCompactEnabled: false,
		});
		proposeClaudeSettingsOverrides({ autoCompactWindow: 8_000 });
		undoFirst(); // the first write comes back rejected, the second is in flight

		expect(claudeSettingsState.overrides).toEqual({ autoCompactWindow: 8_000 });
	});

	it("tracks successful, failed, and unavailable resolution", () => {
		beginClaudeSettingsResolution("project-a");
		expect(claudeSettingsState.resolutionStatus).toBe("loading");

		applyResolvedClaudeSettingsResponse({
			projectSlug: "project-a",
			instanceId: "claude",
			resolved: {
				alwaysThinkingEnabled: {},
				attribution: {},
				autoCompactEnabled: {
					value: true,
					source: "project",
					path: "/workspace/.claude/settings.json",
				},
				autoCompactWindow: {},
				cleanupPeriodDays: {},
				disableAllHooks: {},
			},
		});
		expect(claudeSettingsState.resolutionStatus).toBe("ready");
		expect(claudeSettingsState.resolved.autoCompactEnabled).toEqual({
			value: true,
			source: "project",
			path: "/workspace/.claude/settings.json",
		});

		failClaudeSettingsResolution("project-a");
		expect(claudeSettingsState.resolutionStatus).toBe("error");
		expect(claudeSettingsState.resolved).toEqual({});

		markClaudeSettingsResolutionUnavailable("project-a");
		expect(claudeSettingsState.resolutionStatus).toBe("unavailable");
	});
});

describe("Claude setting provenance", () => {
	it.each([
		[true, "on"],
		[false, "off"],
	] as const)("formats an underlying boolean value of %s as %s", (value, formattedValue) => {
		seedSettings(
			{ autoCompactEnabled: false },
			{
				autoCompactEnabled: {
					value,
					source: "user",
					path: "/profiles/work/settings.json",
				},
			},
		);

		expect(
			describeClaudeSettingProvenance("autoCompactEnabled", false),
		).toEqual({
			kind: "set-here",
			beforeSource: "Set here · ",
			sourceLabel: "your user settings",
			afterSource: ` had ${formattedValue}`,
			sourcePath: "/profiles/work/settings.json",
			text: `Set here · your user settings had ${formattedValue}`,
			canReset: true,
			locked: false,
		});
	});

	it("inverts a displayed boolean without changing the stored value", () => {
		seedSettings(
			{ disableAllHooks: false },
			{ disableAllHooks: { value: true, source: "user" } },
		);

		expect(
			describeClaudeSettingProvenance("disableAllHooks", false, {
				invertBoolean: true,
			}),
		).toMatchObject({
			afterSource: " had off",
			text: "Set here · your user settings had off",
		});
		expect(claudeSettingsState.overrides["disableAllHooks"]).toBe(false);
		expect(claudeSettingsState.resolved.disableAllHooks?.value).toBe(true);
	});

	it("describes an object override without rendering its resolved value", () => {
		seedSettings(
			{ attribution: { sessionUrl: false } },
			{
				attribution: {
					value: { commit: "Inherited commit attribution" },
					source: "user",
					path: "/profiles/work/settings.json",
				},
			},
		);

		const provenance = describeClaudeSettingProvenance("attribution", false);

		expect(provenance).toEqual({
			kind: "set-here",
			beforeSource: "Set here · overrides ",
			sourceLabel: "your user settings",
			sourcePath: "/profiles/work/settings.json",
			text: "Set here · overrides your user settings",
			canReset: true,
			locked: false,
		});
		expect(provenance.text).not.toMatch(/[{}[\]]/);
	});

	it("describes an override with nothing underneath", () => {
		seedSettings({ autoCompactEnabled: true });

		expect(
			describeClaudeSettingProvenance("autoCompactEnabled", false),
		).toMatchObject({
			kind: "set-here",
			text: "Set here",
			canReset: true,
			locked: false,
		});
	});

	it("describes an inherited project-local setting", () => {
		seedSettings(
			{},
			{
				autoCompactWindow: {
					value: 12_000,
					source: "local",
					path: "/workspace/.claude/settings.local.json",
				},
			},
		);

		expect(
			describeClaudeSettingProvenance("autoCompactWindow", false),
		).toMatchObject({
			kind: "inherited",
			text: "From this project's local settings",
			sourceLabel: "this project's local settings",
			sourcePath: "/workspace/.claude/settings.local.json",
			canReset: false,
			locked: false,
		});
	});

	it("locks managed policy even when Conduit has an override", () => {
		seedSettings(
			{ autoCompactWindow: 24_000 },
			{
				autoCompactWindow: {
					value: 8_000,
					source: "managed",
					path: "/Library/Application Support/ClaudeCode/managed-settings.json",
				},
			},
		);

		expect(
			describeClaudeSettingProvenance("autoCompactWindow", false),
		).toMatchObject({
			kind: "locked",
			text: "Locked by managed policy",
			canReset: false,
			locked: true,
			sourcePath:
				"/Library/Application Support/ClaudeCode/managed-settings.json",
		});
		expect(getClaudeSettingValue("autoCompactWindow")).toBe(8_000);
	});

	it("shows the next-session notice after an edit unless policy locks the key", () => {
		handleClaudeSettingsInfo({
			type: "claude_settings_info",
			overrides: { autoCompactEnabled: false },
		});

		expect(
			describeClaudeSettingProvenance("autoCompactEnabled", true),
		).toMatchObject({
			kind: "edited",
			text: "Applies to your next session",
			canReset: true,
			locked: false,
		});
	});

	it.each([
		["loading", "Checking…", () => beginClaudeSettingsResolution("project-a")],
		[
			"error",
			"Couldn't read settings files",
			() => {
				beginClaudeSettingsResolution("project-a");
				failClaudeSettingsResolution("project-a");
			},
		],
		[
			"unavailable",
			"Couldn't read settings files",
			() => markClaudeSettingsResolutionUnavailable("project-a"),
		],
	] as const)("describes %s resolution", (_resolutionStatus, text, reach) => {
		reach();

		expect(
			describeClaudeSettingProvenance("autoCompactEnabled", false),
		).toMatchObject({ text, canReset: false, locked: false });
	});
});
