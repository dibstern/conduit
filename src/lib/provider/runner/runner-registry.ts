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
import { Data } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { isRecord } from "../../utils.js";

class RunnerRegistryError extends Data.TaggedError("RunnerRegistryError")<{
	readonly message: string;
}> {}

export interface RunnerRegistration {
	readonly driverKind?: string;
	readonly runnerId: string;
	readonly sessionId: string;
	readonly socketPath: string;
	readonly buildId: string;
	readonly pid: number;
	readonly role?: "candidate" | "retiring";
}

function runnerTargetDirectory(
	workspaceRoot: string,
	configDir: string,
): string {
	const project = createHash("sha256")
		.update(resolve(workspaceRoot))
		.digest("hex")
		.slice(0, 12);
	return join(resolve(configDir), "r", project);
}

export function runnerDirectory(
	workspaceRoot: string,
	configDir = DEFAULT_CONFIG_DIR,
): string {
	const directory = runnerTargetDirectory(workspaceRoot, configDir);
	// Budget the separator and 12-character runner ID within Darwin's 103
	// usable socket-path bytes. The alias keeps runner files in the config dir.
	if (Buffer.byteLength(directory) + 1 + 12 < 104) return directory;
	const hash = createHash("sha256")
		.update(directory)
		.digest("hex")
		.slice(0, 16);
	// Keep the existing alias so retained runners remain discoverable.
	return `/tmp/conduit-claude-${process.getuid?.() ?? "user"}-${hash}`;
}

export function prepareRunnerDirectory(
	workspaceRoot: string,
	configDir = DEFAULT_CONFIG_DIR,
): string {
	const target = runnerTargetDirectory(workspaceRoot, configDir);
	mkdirSync(target, { recursive: true, mode: 0o700 });
	const directory = runnerDirectory(workspaceRoot, configDir);
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
				throw new RunnerRegistryError({
					message: `Unsafe runner socket alias: ${directory}`,
				});
			}
		}
	}
	return directory;
}

export function registerRunner(entry: RunnerRegistration): void {
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
	entry: RunnerRegistration,
): boolean {
	try {
		const command = execFileSync(
			"ps",
			["-ww", "-o", "command=", "-p", String(entry.pid)],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 },
		);
		// Whole-argument matches only: `<socketPath>.spool` must not pass.
		const argv = ` ${command.trim()} `;
		return (
			argv.includes(` ${entry.socketPath} `) &&
			argv.includes(` ${entry.runnerId} `)
		);
	} catch {
		return false;
	}
}

export function removeRunner(socketPath: string): void {
	for (const suffix of ["", ".json", ".spool"])
		rmSync(`${socketPath}${suffix}`, { force: true });
}

export function discoverRunners(
	workspaceRoot: string,
	configDir = DEFAULT_CONFIG_DIR,
): RunnerRegistration[] {
	const directory = prepareRunnerDirectory(workspaceRoot, configDir);
	const entries: RunnerRegistration[] = [];
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
				removeRunner(socketPath);
				continue;
			}
			entries.push({
				driverKind:
					typeof value["driverKind"] === "string"
						? value["driverKind"]
						: "claude",
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
			removeRunner(socketPath);
		}
	}
	return entries.sort(
		(a, b) =>
			(a.role === "candidate" ? 2 : a.role === "retiring" ? 1 : 0) -
			(b.role === "candidate" ? 2 : b.role === "retiring" ? 1 : 0),
	);
}
