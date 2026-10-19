import { createHash } from "node:crypto";

/** Managed identities contain a private supervisor token. Persist only its hash. */
export const openCodePromptProcessId = (
	instanceId: string,
	processIdentity: string,
): string =>
	`opencode:${createHash("sha256")
		.update(JSON.stringify([instanceId, processIdentity]))
		.digest("hex")}`;
