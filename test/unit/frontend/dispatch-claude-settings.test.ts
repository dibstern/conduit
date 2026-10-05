import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	claudeSettingsState,
	clearClaudeSettingsState,
} from "../../../src/lib/frontend/stores/claude-settings.svelte.js";
import {
	clearDiscoveryState,
	discoveryState,
	handlePermissionModeInfo,
	handleVariantInfo,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { applyProjectSetting } from "../../../src/lib/frontend/stores/project-settings.js";

beforeEach(() => {
	clearClaudeSettingsState();
	clearDiscoveryState();
});

describe("project-settings dispatch", () => {
	it("applies a claudeSettings fact to the reactive settings state", () => {
		applyProjectSetting({
			_tag: "claudeSettings",
			overrides: {
				autoCompactEnabled: false,
				autoCompactWindow: 16_000,
			},
		});

		expect(claudeSettingsState.overrides).toEqual({
			autoCompactEnabled: false,
			autoCompactWindow: 16_000,
		});
	});

	it("applies a defaultPermissionMode fact without changing the session mode", () => {
		handlePermissionModeInfo({ mode: "acceptEdits" });

		applyProjectSetting({
			_tag: "defaultPermissionMode",
			mode: "full",
		});

		expect(discoveryState.defaultPermissionMode).toBe("full");
		expect(discoveryState.permissionMode).toBe("acceptEdits");
	});

	it("applies a defaultModel fact without changing the session variant", () => {
		handleVariantInfo({
			type: "variant_info",
			variant: "low",
			variants: ["low", "high"],
		});

		applyProjectSetting({
			_tag: "defaultModel",
			model: "claude-sonnet-4",
			provider: "anthropic",
			variant: "high",
		});

		expect(discoveryState.defaultModelId).toBe("claude-sonnet-4");
		expect(discoveryState.defaultProviderId).toBe("anthropic");
		expect(discoveryState.defaultVariant).toBe("high");
		expect(discoveryState.currentVariant).toBe("low");
	});
});
