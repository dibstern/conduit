import { join } from "node:path";
import { isRecord } from "../../utils.js";
import { ProviderInstanceFailure } from "../errors.js";
import {
	readRunnerIdentityFile,
	writeRunnerIdentityFile,
} from "../runner/runner-identity-file.js";

export interface CodexSessionIdentity {
	readonly threadId: string;
	readonly codexHome?: string;
	readonly cwd: string;
	readonly controllerPid: number;
	/** Inherited native turn IDs remain valid only after a native fork. */
	readonly inheritedThreadIds?: readonly string[];
	/** Consumed once by the first launch, before admitting a visible turn. */
	readonly forkSource?: {
		readonly threadId: string;
		readonly lastTurnId: string;
	};
	/** Thread creation can persist before its first digest-bearing turn is accepted. */
	readonly forkSeedPending?: boolean;
	/** Only used if a cross-account resume cannot find the original rollout. */
	readonly resumeFallbackDigest?: string;
	/** Retained with its input so a restarted runner reports the same outcome. */
	readonly continuationKind?: "native-thread" | "transcript-digest";
	readonly continuationInputId?: string;
}

export function codexSessionStorePath(configDir: string, sessionId: string) {
	return join(configDir, "codex", "stores", sessionId);
}

export function readCodexSessionIdentity(
	configDir: string,
	sessionId: string,
): CodexSessionIdentity | undefined {
	const value = readRunnerIdentityFile(
		codexSessionStorePath(configDir, sessionId),
	);
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		typeof value["threadId"] !== "string" ||
		value["threadId"].trim().length === 0 ||
		typeof value["cwd"] !== "string" ||
		typeof value["controllerPid"] !== "number" ||
		!Number.isSafeInteger(value["controllerPid"]) ||
		value["controllerPid"] <= 0 ||
		(value["codexHome"] !== undefined &&
			typeof value["codexHome"] !== "string") ||
		(value["forkSeedPending"] !== undefined &&
			typeof value["forkSeedPending"] !== "boolean") ||
		(value["inheritedThreadIds"] !== undefined &&
			(!Array.isArray(value["inheritedThreadIds"]) ||
				!value["inheritedThreadIds"].every((id) => typeof id === "string"))) ||
		(value["forkSource"] !== undefined &&
			(!isRecord(value["forkSource"]) ||
				typeof value["forkSource"]["threadId"] !== "string" ||
				typeof value["forkSource"]["lastTurnId"] !== "string")) ||
		(value["resumeFallbackDigest"] !== undefined &&
			typeof value["resumeFallbackDigest"] !== "string") ||
		(value["continuationKind"] !== undefined &&
			value["continuationKind"] !== "native-thread" &&
			value["continuationKind"] !== "transcript-digest") ||
		(value["continuationInputId"] !== undefined &&
			typeof value["continuationInputId"] !== "string")
	) {
		throw new ProviderInstanceFailure({
			providerId: "codex",
			operation: "session.identity",
			cause: "Invalid Codex session identity",
		});
	}
	return {
		threadId: value["threadId"],
		cwd: value["cwd"],
		controllerPid: value["controllerPid"],
		...(Array.isArray(value["inheritedThreadIds"])
			? {
					inheritedThreadIds: value["inheritedThreadIds"].filter(
						(id): id is string => typeof id === "string",
					),
				}
			: {}),
		...(isRecord(value["forkSource"]) &&
		typeof value["forkSource"]["threadId"] === "string" &&
		typeof value["forkSource"]["lastTurnId"] === "string"
			? {
					forkSource: {
						threadId: value["forkSource"]["threadId"],
						lastTurnId: value["forkSource"]["lastTurnId"],
					},
				}
			: {}),
		...(typeof value["codexHome"] === "string"
			? { codexHome: value["codexHome"] }
			: {}),
		...(typeof value["forkSeedPending"] === "boolean"
			? { forkSeedPending: value["forkSeedPending"] }
			: {}),
		...(typeof value["resumeFallbackDigest"] === "string"
			? { resumeFallbackDigest: value["resumeFallbackDigest"] }
			: {}),
		...(value["continuationKind"] === "native-thread" ||
		value["continuationKind"] === "transcript-digest"
			? { continuationKind: value["continuationKind"] }
			: {}),
		...(typeof value["continuationInputId"] === "string"
			? { continuationInputId: value["continuationInputId"] }
			: {}),
	};
}

export function writeCodexSessionIdentity(
	configDir: string,
	sessionId: string,
	identity: CodexSessionIdentity,
): void {
	writeRunnerIdentityFile(
		codexSessionStorePath(configDir, sessionId),
		identity,
	);
}
