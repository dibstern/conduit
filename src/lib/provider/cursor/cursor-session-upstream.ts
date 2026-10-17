import { rm } from "node:fs/promises";
import { Effect } from "effect";
import type { SessionUpstreamAdapter } from "../../domain/relay/Services/session-command.js";
import { discoverRunners, runnerPidAlive } from "../runner/runner-registry.js";
import { createCursorSdkPort } from "./cursor-sdk.js";
import {
	cursorSessionStorePath,
	readCursorSessionIdentity,
} from "./cursor-session-recovery.js";
import { CursorSdkFailure } from "./sdk-error.js";

export const cursorUpstreamAdapter = (
	configuration:
		| { readonly workspaceRoot: string; readonly configDir: string }
		| undefined,
): SessionUpstreamAdapter => ({
	provider: "cursor",
	sync: (command) =>
		command.type === "session.deleted"
			? Effect.tryPromise(async () => {
					if (configuration === undefined) {
						throw new CursorSdkFailure({
							operation: "agent.delete",
							reason:
								"Cursor cleanup requires the project and config directories",
						});
					}
					const { workspaceRoot, configDir } = configuration;
					const { sessionId } = command.data;
					const identity = readCursorSessionIdentity(configDir, sessionId);
					// An end-session failure must not let a live controller write into
					// the store while its persisted agent is being removed.
					if (
						discoverRunners(workspaceRoot, configDir).some(
							(runner) => runner.sessionId === sessionId,
						) ||
						(identity && runnerPidAlive(identity.controllerPid))
					) {
						throw new CursorSdkFailure({
							operation: "agent.delete",
							reason: "Cursor session runner is still alive",
						});
					}
					const path = cursorSessionStorePath(configDir, sessionId);
					if (identity) {
						const sdk = createCursorSdkPort();
						const store = await sdk.openStore(path, identity.cwd);
						try {
							await sdk.deleteAgent(identity.agentId, identity.cwd, store);
						} finally {
							await store.dispose();
						}
					}
					await rm(path, { recursive: true, force: true });
				})
			: Effect.void,
});
