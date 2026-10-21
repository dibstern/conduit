import { expect, it, vi } from "vitest";
import {
	CLAUDE_SETTINGS_REPLAY_DEFERRED,
	replayClaudeRunnerFileSettings,
} from "../../../../src/lib/provider/claude/claude-runner-settings.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";

// Missing capture must reject the replacement and arm a restart at the next send.
it("defers settings replay when the original capture is missing", async () => {
	const resolveSettings = vi.fn(async () => {
		throw new Error("Missing capture must not read the current settings");
	});
	await expect(
		replayClaudeRunnerFileSettings(
			undefined,
			{ cwd: "/unused" },
			resolveSettings,
			true,
			configuredClaudeConfigDir("/unused/claude"),
		),
	).rejects.toMatchObject({
		code: CLAUDE_SETTINGS_REPLAY_DEFERRED,
		message:
			"Original Claude file settings could not be captured; retaining the old runner",
	});
	expect(resolveSettings).not.toHaveBeenCalled();
});
