import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import type {
	RunnerLaunch,
	RunnerLaunchCallbacks,
} from "../runner/runner-host.js";
import {
	CursorBackendUrl,
	type CursorCredentialEnvelope,
} from "./cursor-credential.js";
import { makeCursorSessionRunner } from "./cursor-runner-payload.js";
import { cursorRunnerWire } from "./cursor-runner-wire.js";

export const makeCursorRunnerLaunch = (
	callbacks: RunnerLaunchCallbacks,
): Effect.Effect<RunnerLaunch> => {
	let resumeSessionId: string | undefined;
	let environment: Readonly<Record<string, string | undefined>> = process.env;
	const credentials = new Map<string, CursorCredentialEnvelope>();
	return Effect.succeed({
		wire: cursorRunnerWire,
		capabilities: {
			cursorBackendUrl: Schema.decodeUnknownSync(CursorBackendUrl)(
				process.env["CURSOR_BACKEND_URL"],
			),
		},
		shouldExitAfterCommand: (_command, result) =>
			result?.error?.code === "sandbox_unavailable",
		makeRunner: (config, emit) =>
			Effect.gen(function* () {
				const daemonConfigDir = config.daemonConfigDir ?? DEFAULT_CONFIG_DIR;
				// local.store does not redirect SDK transcript writes (workspace-resume).
				const dataDir = join(daemonConfigDir, "cursor", "data");
				process.env["CURSOR_DATA_DIR"] = dataDir;
				// A runner may start while the daemon redirects these for a title call.
				process.env["CURSOR_SANDBOX_POLICY_DIR"] = join(
					daemonConfigDir,
					"cursor",
					"sandbox-policies",
				);
				yield* Effect.sync(() =>
					mkdirSync(dataDir, { recursive: true, mode: 0o700 }),
				);
				return yield* makeCursorSessionRunner(
					{
						workspaceRoot: config.workspaceRoot,
						daemonConfigDir,
						environment: () => environment,
						credential: (inputId) => credentials.get(inputId),
						onAbandonedRun: (inputId) =>
							callbacks.retireAfterCommand?.(inputId),
					},
					emit,
					callbacks.turnStateChanged,
				);
			}),
		upgradeState: () => ({ ...(resumeSessionId ? { resumeSessionId } : {}) }),
		acceptCommand: (command) => {
			if (command.type === "send-turn") {
				environment = command.shellEnv ?? process.env;
			}
		},
		executeEffect: (runner, command) =>
			Effect.gen(function* () {
				if (command.type === "send-turn") {
					if (!command.cursorCredential)
						return yield* Effect.fail({
							operation: "send-turn",
							code: "turn_unprepared",
							message: "Cursor turn has no prepared credential envelope",
						});
					credentials.set(command.input.inputId, command.cursorCredential);
				}
				const result = yield* runner.executeEffect(command);
				resumeSessionId =
					(yield* runner.getResumeSessionIdEffect?.(callbacks.sessionId) ??
						Effect.succeed(undefined)) ?? undefined;
				callbacks.stateChanged();
				return result;
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						if (command.type === "send-turn")
							credentials.delete(command.input.inputId);
					}),
				),
			),
	});
};
