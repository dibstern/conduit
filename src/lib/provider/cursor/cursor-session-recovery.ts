import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../utils.js";
import { CursorSdkFailure } from "./sdk-error.js";

export interface CursorSessionIdentity {
	readonly agentId: string;
	readonly cwd: string;
	readonly controllerPid: number;
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
	let value: unknown;
	try {
		value = JSON.parse(
			readFileSync(
				join(cursorSessionStorePath(configDir, sessionId), "session.json"),
				"utf8",
			),
		);
	} catch (cause) {
		if (isRecord(cause) && cause["code"] === "ENOENT") return undefined;
		throw cause;
	}
	if (
		!isRecord(value) ||
		typeof value["agentId"] !== "string" ||
		typeof value["cwd"] !== "string" ||
		typeof value["controllerPid"] !== "number" ||
		!Number.isSafeInteger(value["controllerPid"]) ||
		value["controllerPid"] <= 0
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
	};
}

export function writeCursorSessionIdentity(
	configDir: string,
	sessionId: string,
	identity: CursorSessionIdentity,
): void {
	const directory = cursorSessionStorePath(configDir, sessionId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "session.json");
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(identity), {
		mode: 0o600,
		flush: true,
	});
	renameSync(temporary, path);
	const descriptor = openSync(directory, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
