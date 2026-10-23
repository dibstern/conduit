import { rm } from "node:fs/promises";
import { Effect } from "effect";
import type { SessionUpstreamAdapter } from "../../domain/relay/Services/session-command.js";
import { ProviderInstanceFailure } from "../errors.js";
import { discoverRunners, runnerPidAlive } from "../runner/runner-registry.js";
import {
	codexSessionStorePath,
	readCodexSessionIdentity,
} from "./codex-session-store.js";

export const codexUpstreamAdapter = (
	configuration:
		| { readonly workspaceRoot: string; readonly configDir: string }
		| undefined,
): SessionUpstreamAdapter => ({
	provider: "codex",
	sync: (command) =>
		command.type === "session.deleted"
			? Effect.tryPromise(async () => {
					if (!configuration) {
						throw new ProviderInstanceFailure({
							providerId: "codex",
							operation: "session.delete",
							cause:
								"Codex cleanup requires the project and config directories",
						});
					}
					const { workspaceRoot, configDir } = configuration;
					const { sessionId } = command.data;
					const identity = readCodexSessionIdentity(configDir, sessionId);
					if (
						discoverRunners(workspaceRoot, configDir).some(
							(runner) => runner.sessionId === sessionId,
						) ||
						(identity && runnerPidAlive(identity.controllerPid))
					) {
						throw new ProviderInstanceFailure({
							providerId: "codex",
							operation: "session.delete",
							cause: "Codex session runner is still alive",
						});
					}
					await rm(codexSessionStorePath(configDir, sessionId), {
						recursive: true,
						force: true,
					});
				})
			: Effect.void,
});
