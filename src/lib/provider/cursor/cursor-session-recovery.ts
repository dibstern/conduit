import { join } from "node:path";
import { isRecord } from "../../utils.js";
import {
	readRunnerIdentityFile,
	writeRunnerIdentityFile,
} from "../runner/runner-identity-file.js";
import { CursorSdkFailure } from "./sdk-error.js";

export interface CursorSessionIdentity {
	readonly agentId: string;
	readonly cwd: string;
	readonly controllerPid: number;
	readonly forkSeedPending?: boolean;
}

export function cursorSessionStorePath(
	configDir: string,
	sessionId: string,
): string {
	return join(configDir, "cursor", "stores", sessionId);
}

export function readCursorSessionIdentity(
	configDir: string,
	sessionId: string,
): CursorSessionIdentity | undefined {
	const value = readRunnerIdentityFile(
		cursorSessionStorePath(configDir, sessionId),
	);
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		typeof value["agentId"] !== "string" ||
		typeof value["cwd"] !== "string" ||
		typeof value["controllerPid"] !== "number" ||
		!Number.isSafeInteger(value["controllerPid"]) ||
		value["controllerPid"] <= 0 ||
		(value["forkSeedPending"] !== undefined &&
			typeof value["forkSeedPending"] !== "boolean")
	) {
		throw new CursorSdkFailure({
			operation: "session.identity",
			reason: "Invalid Cursor session identity",
		});
	}
	return {
		agentId: value["agentId"],
		cwd: value["cwd"],
		controllerPid: value["controllerPid"],
		...(typeof value["forkSeedPending"] === "boolean"
			? { forkSeedPending: value["forkSeedPending"] }
			: {}),
	};
}

export function resolveCursorSessionCwd<Root extends string | undefined>(
	identity: CursorSessionIdentity | undefined,
	providerState: Readonly<Record<string, unknown>>,
	workspaceRoot: Root,
): string | Root {
	const storedCwd = providerState["cursor.cwd"];
	return (
		identity?.cwd ?? (typeof storedCwd === "string" ? storedCwd : workspaceRoot)
	);
}

export function writeCursorSessionIdentity(
	configDir: string,
	sessionId: string,
	identity: CursorSessionIdentity,
): void {
	writeRunnerIdentityFile(
		cursorSessionStorePath(configDir, sessionId),
		identity,
	);
}
