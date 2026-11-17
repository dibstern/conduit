import { rm } from "node:fs/promises";
import { Effect } from "effect";
import type { SessionUpstreamAdapter } from "../../domain/project-services/Services/session-command.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { ProcessTable } from "../runner/process-table.js";
import { discoverRunners } from "../runner/runner-registry.js";
import {
	codexSessionStorePath,
	readCodexSessionIdentity,
} from "./codex-session-store.js";

export const codexUpstreamAdapter = (
	configuration:
		| {
				readonly workspaceRoot: string;
				readonly configDir: string;
				readonly processTable: ProcessTable;
		  }
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
					const { workspaceRoot, configDir, processTable } = configuration;
					const { sessionId } = command.data;
					const identity = readCodexSessionIdentity(configDir, sessionId);
					if (
						discoverRunners(workspaceRoot, configDir, processTable).some(
							(runner) => runner.sessionId === sessionId,
						) ||
						// A zombie cannot write; Stop counts it as gone (6.6).
						(identity &&
							!["gone", "zombie"].includes(
								processTable
									.identify([identity.controllerPid])
									.get(identity.controllerPid)?.state ?? "unknown",
							))
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
