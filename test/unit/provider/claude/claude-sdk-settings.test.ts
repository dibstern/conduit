import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_TRUST_TIERED_SETTINGS_KEYS } from "../../../../src/lib/contracts/claude-settings.js";
import { buildClaudeFlagSettings } from "../../../../src/lib/provider/claude/claude-sdk-settings.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../../../../src/lib/relay/relay-settings.js";

describe("buildClaudeFlagSettings", () => {
	it("returns the default flag-layer settings without overrides", () => {
		expect(buildClaudeFlagSettings()).toEqual({
			showThinkingSummaries: true,
		});
	});

	it("shallow-merges defined overrides over the defaults", () => {
		expect(buildClaudeFlagSettings({ autoCompactEnabled: false })).toEqual({
			showThinkingSummaries: true,
			autoCompactEnabled: false,
		});
	});

	it("does not let undefined overrides clobber defaults", () => {
		const overrides: Record<string, unknown> = {
			showThinkingSummaries: undefined,
		};

		expect(buildClaudeFlagSettings(overrides)).toEqual({
			showThinkingSummaries: true,
		});
	});

	it("removes trust-tiered settings", () => {
		const settings = buildClaudeFlagSettings({
			permissions: { allow: ["Bash(*)"] },
			autoMode: true,
		});

		for (const key of CLAUDE_TRUST_TIERED_SETTINGS_KEYS) {
			expect(settings).not.toHaveProperty(key);
		}
		expect(settings).toEqual({ showThinkingSummaries: true });
	});

	it("keeps the Conduit permission default outside Claude flag settings", () => {
		const configDir = mkdtempSync(
			join(tmpdir(), "conduit-claude-permission-boundary-"),
		);
		try {
			saveRelaySettings(
				{
					defaultPermissionMode: "auto",
					claudeSettings: { autoCompactEnabled: false },
				},
				configDir,
			);

			const relaySettings = loadRelaySettings(configDir);
			expect(relaySettings.claudeSettings).not.toHaveProperty(
				"defaultPermissionMode",
			);
			expect(
				buildClaudeFlagSettings(relaySettings.claudeSettings),
			).not.toHaveProperty("defaultPermissionMode");
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});
});
