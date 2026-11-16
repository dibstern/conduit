import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedSettings } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import {
	CLAUDE_SETTINGS_REPLAY_DEFERRED,
	captureClaudeRunnerFileSettings,
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

// SDK 0.3.325 added machinePolicy to every read, so a runner captured on an
// older SDK never compared equal and every restart deferred its upgrade.
it("does not treat the host's machinePolicy read as a settings change", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-runner-settings-"));
	const options = { cwd: root };
	const configDir = configuredClaudeConfigDir(join(root, "claude"));
	const files: ResolvedSettings = {
		effective: { model: "opus" },
		provenance: {},
		sources: [{ source: "user", settings: { model: "opus" } }],
	};
	const before = await captureClaudeRunnerFileSettings(
		options,
		async () => files,
		configDir,
	);
	await expect(
		replayClaudeRunnerFileSettings(
			before,
			options,
			async () => ({ ...files, machinePolicy: { didNotLoad: false } }),
			true,
			configDir,
		),
	).resolves.toEqual({});
});
