import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	claudeSettingsState,
	clearClaudeSettingsState,
} from "../../../src/lib/frontend/stores/claude-settings.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";

beforeEach(() => {
	clearClaudeSettingsState();
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
});
