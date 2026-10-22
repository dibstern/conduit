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

export function readRunnerIdentityFile(directory: string): unknown | undefined {
	try {
		return JSON.parse(readFileSync(join(directory, "session.json"), "utf8"));
	} catch (cause) {
		if (isRecord(cause) && cause["code"] === "ENOENT") return undefined;
		throw cause;
	}
}

export function writeRunnerIdentityFile(
	directory: string,
	value: unknown,
): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "session.json");
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(value), {
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
