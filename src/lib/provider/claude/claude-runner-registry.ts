import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { isRecord } from "../../utils.js";
import { ClaudeRuntimeError } from "../event-sink-errors.js";

export interface ClaudeRunnerRegistration {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly socketPath: string;
	readonly buildId: string;
	readonly pid: number;
	readonly role?: "candidate" | "retiring";
}

function claudeRunnerTargetDirectory(
	workspaceRoot: string,
	configDir: string,
): string {
	const project = createHash("sha256")
		.update(resolve(workspaceRoot))
		.digest("hex")
		.slice(0, 12);
	return join(resolve(configDir), "r", project);
}

export function claudeRunnerDirectory(
	workspaceRoot: string,
	configDir = DEFAULT_CONFIG_DIR,
): string {
	const directory = claudeRunnerTargetDirectory(workspaceRoot, configDir);
	// Budget the separator and 12-character runner ID within Darwin's 103
	// usable socket-path bytes. The alias keeps runner files in the config dir.
	if (Buffer.byteLength(directory) + 1 + 12 < 104) return directory;
	const hash = createHash("sha256")
		.update(directory)
		.digest("hex")
		.slice(0, 16);
	return `/tmp/conduit-claude-${process.getuid?.() ?? "user"}-${hash}`;
}

export function prepareClaudeRunnerDirectory(
	workspaceRoot: string,
	configDir = DEFAULT_CONFIG_DIR,
): string {
	const target = claudeRunnerTargetDirectory(workspaceRoot, configDir);
	mkdirSync(target, { recursive: true, mode: 0o700 });
	const directory = claudeRunnerDirectory(workspaceRoot, configDir);
	if (directory !== target) {
		try {
			symlinkSync(target, directory);
		} catch (error) {
			if (!isRecord(error) || error["code"] !== "EEXIST") throw error;
			if (
				!lstatSync(directory).isSymbolicLink() ||
				readlinkSync(directory) !== target ||
				lstatSync(directory).uid !== process.getuid?.()
			) {
				throw new ClaudeRuntimeError({
					message: `Unsafe Claude runner socket alias: ${directory}`,
				});
			}
		}
	}
	return directory;
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

export function runnerPidMatchesRegistration(
	entry: ClaudeRunnerRegistration,
): boolean {
	try {
		const command = execFileSync(
			"ps",
			["-ww", "-o", "command=", "-p", String(entry.pid)],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 },
		);
		return (
			command.includes(entry.socketPath) &&
			command.trim().split(/\s+/).includes(entry.runnerId)
		);
	} catch {
		return false;
	}
}

export function removeClaudeRunner(socketPath: string): void {
	for (const suffix of ["", ".json", ".spool"])
		rmSync(`${socketPath}${suffix}`, { force: true });
}

export function discoverClaudeRunners(
	workspaceRoot: string,
	configDir = DEFAULT_CONFIG_DIR,
): ClaudeRunnerRegistration[] {
	const directory = prepareClaudeRunnerDirectory(workspaceRoot, configDir);
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
				...(value["role"] === "candidate" || value["role"] === "retiring"
					? { role: value["role"] }
					: {}),
			});
		} catch {
			removeClaudeRunner(socketPath);
		}
	}
	return entries.sort(
		(a, b) =>
			(a.role === "candidate" ? 2 : a.role === "retiring" ? 1 : 0) -
			(b.role === "candidate" ? 2 : b.role === "retiring" ? 1 : 0),
	);
}
