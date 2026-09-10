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
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";

beforeEach(() => {
	clearClaudeSettingsState();
	clearDiscoveryState();
});

describe("Claude settings broadcast dispatch", () => {
	it("applies claude_settings_info to the reactive settings state", () => {
		handleMessage({
			type: "claude_settings_info",
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

	it("applies default_permission_mode_info without changing the session mode", () => {
		discoveryState.permissionMode = "acceptEdits";

		handleMessage({
			type: "default_permission_mode_info",
			mode: "full",
		});

		expect(discoveryState.defaultPermissionMode).toBe("full");
		expect(discoveryState.permissionMode).toBe("acceptEdits");
	});

	it("applies default_model_info without changing the session variant", () => {
		discoveryState.currentVariant = "low";

		handleMessage({
			type: "default_model_info",
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
