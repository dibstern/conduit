import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { isRecord } from "../../utils.js";

export interface ClaudeRunnerRegistration {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly socketPath: string;
	readonly buildId: string;
	readonly pid: number;
}

export function claudeRunnerDirectory(workspaceRoot: string): string {
	const project = createHash("sha256")
		.update(resolve(workspaceRoot))
		.digest("hex")
		.slice(0, 12);
	return join(resolve(DEFAULT_CONFIG_DIR), "r", project);
}

export function registerClaudeRunner(entry: ClaudeRunnerRegistration): void {
	const temporary = `${entry.socketPath}.json.tmp`;
	writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
	renameSync(temporary, `${entry.socketPath}.json`);
}

export function runnerPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		// An inaccessible PID is not proof of death and must keep its files.
		return !isRecord(cause) || cause["code"] !== "ESRCH";
	}
}

export function removeClaudeRunner(socketPath: string): void {
	for (const suffix of ["", ".json", ".spool"])
		rmSync(`${socketPath}${suffix}`, { force: true });
}

export function discoverClaudeRunners(
	workspaceRoot: string,
): ClaudeRunnerRegistration[] {
	const directory = claudeRunnerDirectory(workspaceRoot);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const entries: ClaudeRunnerRegistration[] = [];
	for (const filename of readdirSync(directory)) {
		if (!/^[0-9a-f]{12}\.json$/.test(filename)) continue;
		const socketPath = join(directory, filename.slice(0, -5));
		try {
			const value: unknown = JSON.parse(
				readFileSync(`${socketPath}.json`, "utf8"),
			);
			if (
				!isRecord(value) ||
				value["socketPath"] !== socketPath ||
				value["runnerId"] !== filename.slice(0, -5) ||
				typeof value["sessionId"] !== "string" ||
				typeof value["buildId"] !== "string" ||
				typeof value["pid"] !== "number" ||
				!Number.isSafeInteger(value["pid"]) ||
				value["pid"] <= 0 ||
				!runnerPidAlive(value["pid"])
			) {
				removeClaudeRunner(socketPath);
				continue;
			}
			entries.push({
				runnerId: filename.slice(0, -5),
				socketPath,
				sessionId: value["sessionId"],
				buildId: value["buildId"],
				pid: value["pid"],
			});
		} catch {
			removeClaudeRunner(socketPath);
		}
	}
	return entries;
}
