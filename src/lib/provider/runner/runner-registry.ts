import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Data } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { isRecord } from "../../utils.js";
import {
	makeProductionProcessTable,
	type ProcessStart,
	type ProcessTable,
	sameProcess,
} from "./process-table.js";

class RunnerRegistryError extends Data.TaggedError("RunnerRegistryError")<{
	readonly message: string;
}> {}

export interface RunnerRegistration
	extends Partial<typeof ProcessStart.Encoded> {
	readonly driverKind?: string;
	readonly runnerId: string;
	readonly sessionId: string;
	readonly socketPath: string;
	readonly buildId: string;
	readonly pid: number;
	readonly registeredAt?: number;
	readonly signalled?: boolean;
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
	return runnerSocketDirectory(runnerTargetDirectory(workspaceRoot, configDir));
}

function runnerSocketDirectory(directory: string): string {
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
	return prepareRunnerSocketDirectory(target);
}

function prepareRunnerSocketDirectory(target: string): string {
	const directory = runnerSocketDirectory(target);
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

export function registerRunner(
	entry: RunnerRegistration,
	processTable?: ProcessTable,
): void {
	let previous: Partial<RunnerRegistration> = {};
	try {
		const value: unknown = JSON.parse(
			readFileSync(`${entry.socketPath}.json`, "utf8"),
		);
		if (isRecord(value) && value["runnerId"] === entry.runnerId)
			previous = value;
	} catch {
		/* First registration. */
	}
	const temporary = `${entry.socketPath}.${randomUUID()}.json.tmp`;
	const seen =
		entry.startTime === undefined && previous.startTime === undefined
			? (processTable ?? makeProductionProcessTable())
					.identify([entry.pid])
					.get(entry.pid)
			: undefined;
	// Choose a whole start from one source. A legacy string must not inherit a key.
	const start =
		entry.startTime !== undefined
			? entry
			: previous.startTime !== undefined
				? previous
				: seen && "startTime" in seen
					? seen
					: undefined;
	const contents = JSON.stringify({
		...entry,
		startTime: start?.startTime,
		startKey: start?.startKey,
		registeredAt: previous.registeredAt ?? entry.registeredAt ?? Date.now(),
	});
	// Identity remains beside the journal/spool after discovery is removed.
	// Publish it durably before this process can become discoverable or execute.
	const evidence = `${entry.socketPath}.evidence.json`;
	writeFileSync(temporary, contents, { mode: 0o600 });
	const fd = openSync(temporary, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, evidence);
	const directoryFd = openSync(dirname(evidence), "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
	writeFileSync(temporary, contents, { mode: 0o600 });
	renameSync(temporary, `${entry.socketPath}.json`);
}

/** Recovery finds retained evidence independently of live-runner discovery. */
export function readRunnerEvidence(
	configDir: string,
	runnerId: string,
	sessionId: string,
):
	| Pick<RunnerRegistration, "socketPath" | "buildId" | "driverKind">
	| undefined {
	if (!/^[0-9a-f]{12}$/.test(runnerId)) return undefined;
	const root = join(resolve(configDir), "r");
	try {
		for (const directory of readdirSync(root)) {
			if (!/^[0-9a-f]{12}$/.test(directory)) continue;
			try {
				const socketPath = join(
					runnerSocketDirectory(join(root, directory)),
					runnerId,
				);
				const value: unknown = JSON.parse(
					readFileSync(`${socketPath}.evidence.json`, "utf8"),
				);
				if (
					isRecord(value) &&
					value["runnerId"] === runnerId &&
					value["sessionId"] === sessionId &&
					value["socketPath"] === socketPath &&
					typeof value["buildId"] === "string"
				)
					return {
						socketPath,
						buildId: value["buildId"],
						...(typeof value["driverKind"] === "string"
							? { driverKind: value["driverKind"] }
							: {}),
					};
			} catch {
				// Unreadable identity never proves that journal absence is safe.
			}
		}
	} catch {
		// Missing identity is unknown build evidence, never current-build proof.
	}
	return undefined;
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
	processTable: ProcessTable = makeProductionProcessTable(),
): boolean {
	const argv = processTable.argv(entry.pid);
	if (!argv) return false;
	// The ps fallback splits argv on whitespace, so match space-delimited tokens;
	// exact elements match too, and prefix or suffix near-misses never do.
	const command = ` ${argv.join(" ")} `;
	return (
		command.includes(` ${entry.socketPath} `) &&
		command.includes(` ${entry.runnerId} `)
	);
}

export function removeRunnerDiscovery(socketPath: string): void {
	for (const suffix of ["", ".json"])
		rmSync(`${socketPath}${suffix}`, { force: true });
}

/** Only the Gone/Settle/prune lifecycle may discard retained output identity. */
export function removeRunnerEvidence(socketPath: string): void {
	for (const suffix of [".spool", ".evidence.json"])
		rmSync(`${socketPath}${suffix}`, { force: true });
}

export function discoverRunners(
	workspaceRoot: string,
	configDir = DEFAULT_CONFIG_DIR,
	processTable: ProcessTable = makeProductionProcessTable(),
): RunnerRegistration[] {
	const directory = prepareRunnerDirectory(workspaceRoot, configDir);
	return discoverRunnersInDirectories([directory], processTable);
}

/** Daemon recovery includes retained projects whose folders are no longer registered. */
export function discoverAllRunners(
	configDir = DEFAULT_CONFIG_DIR,
	processTable: ProcessTable = makeProductionProcessTable(),
): RunnerRegistration[] {
	const root = join(resolve(configDir), "r");
	let directories: string[];
	try {
		directories = readdirSync(root);
	} catch (cause) {
		if (isRecord(cause) && cause["code"] === "ENOENT") return [];
		throw cause;
	}
	return discoverRunnersInDirectories(
		directories.flatMap((directory) => {
			if (!/^[0-9a-f]{12}$/.test(directory)) return [];
			const target = join(root, directory);
			if (!lstatSync(target).isDirectory()) return [];
			return [prepareRunnerSocketDirectory(target)];
		}),
		processTable,
	);
}

function discoverRunnersInDirectories(
	directories: readonly string[],
	processTable: ProcessTable,
): RunnerRegistration[] {
	const entries: RunnerRegistration[] = [];
	for (const directory of directories) {
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
					value["pid"] <= 0
				) {
					removeRunnerDiscovery(socketPath);
					continue;
				}
				entries.push({
					// Runner builds predating driverKind were all Claude.
					driverKind:
						typeof value["driverKind"] === "string"
							? value["driverKind"]
							: "claude",
					runnerId: filename.slice(0, -5),
					socketPath,
					sessionId: value["sessionId"],
					buildId: value["buildId"],
					pid: value["pid"],
					...(typeof value["startTime"] === "string"
						? { startTime: value["startTime"] }
						: {}),
					...(typeof value["startKey"] === "string"
						? { startKey: value["startKey"] }
						: {}),
					registeredAt:
						typeof value["registeredAt"] === "number"
							? value["registeredAt"]
							: lstatSync(`${socketPath}.json`).mtimeMs,
					...(value["signalled"] === true ? { signalled: true } : {}),
				});
			} catch {
				removeRunnerDiscovery(socketPath);
			}
		}
	}
	const observed = processTable.identify(entries.map((entry) => entry.pid));
	// Unknown is retained; only positive identity/exit evidence excludes a runner.
	return entries.filter(
		(entry) => sameProcess(entry, observed.get(entry.pid)) !== "gone",
	);
}
