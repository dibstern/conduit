import { beforeEach, describe, expect, it } from "vitest";
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
	setClaudeSettingsOverridesOptimistically,
} from "../../../src/lib/frontend/stores/claude-settings.svelte.js";

beforeEach(() => {
	clearClaudeSettingsState();
});

describe("Claude settings store", () => {
	it("applies RPC reads, optimistic writes, and confirming broadcasts", () => {
		applyClaudeSettingsResponse({
			projectSlug: "project-a",
			overrides: { autoCompactEnabled: true },
		});
		expect(claudeSettingsState.overrides).toEqual({
			autoCompactEnabled: true,
		});

		setClaudeSettingsOverridesOptimistically({ autoCompactWindow: 24_000 });
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

	it("tracks successful, failed, and unavailable resolution", () => {
		beginClaudeSettingsResolution("project-a");
		expect(claudeSettingsState.resolutionStatus).toBe("loading");

		applyResolvedClaudeSettingsResponse({
			projectSlug: "project-a",
			instanceId: "claude",
			resolved: {
				alwaysThinkingEnabled: {},
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
		claudeSettingsState.overrides = { autoCompactEnabled: false };
		claudeSettingsState.resolved = {
			autoCompactEnabled: {
				value,
				source: "user",
				path: "/profiles/work/settings.json",
			},
		};
		claudeSettingsState.resolutionStatus = "ready";

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
		claudeSettingsState.overrides = { disableAllHooks: false };
		claudeSettingsState.resolved = {
			disableAllHooks: {
				value: true,
				source: "user",
			},
		};
		claudeSettingsState.resolutionStatus = "ready";

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

	it("describes an override with nothing underneath", () => {
		claudeSettingsState.overrides = { autoCompactEnabled: true };
		claudeSettingsState.resolutionStatus = "ready";

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
		claudeSettingsState.resolved = {
			autoCompactWindow: {
				value: 12_000,
				source: "local",
				path: "/workspace/.claude/settings.local.json",
			},
		};
		claudeSettingsState.resolutionStatus = "ready";

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
		claudeSettingsState.overrides = { autoCompactWindow: 24_000 };
		claudeSettingsState.resolved = {
			autoCompactWindow: {
				value: 8_000,
				source: "managed",
				path: "/Library/Application Support/ClaudeCode/managed-settings.json",
			},
		};
		claudeSettingsState.resolutionStatus = "ready";

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
		claudeSettingsState.overrides = { autoCompactEnabled: false };

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
		["loading", "Checking…"],
		["error", "Couldn't read settings files"],
		["unavailable", "Couldn't read settings files"],
	] as const)("describes %s resolution", (resolutionStatus, text) => {
		claudeSettingsState.resolutionStatus = resolutionStatus;

		expect(
			describeClaudeSettingProvenance("autoCompactEnabled", false),
		).toMatchObject({ text, canReset: false, locked: false });
	});
});
