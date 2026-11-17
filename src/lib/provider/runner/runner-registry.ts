import { execFileSync } from "node:child_process";
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
import type { RunnerMember } from "./runner-receipts.js";

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
	readonly startTime?: string;
	readonly registeredAt?: number;
	readonly signalled?: boolean;
}

export interface RunnerProcessTable {
	readonly inspect: (pid: number) => {
		readonly state: "running" | "zombie" | "gone" | "unknown";
		readonly startTime?: string;
		readonly pgid?: number;
	};
	readonly signal: (pid: number, signal: NodeJS.Signals) => void;
	/** Liveness only: false proves the pid gone, true proves no identity. */
	readonly alive?: (pid: number) => boolean;
	readonly members?: (pgid: number) => readonly RunnerMember[] | undefined;
	readonly inspectMany?: (
		pids: readonly number[],
	) => ReadonlyMap<number, ReturnType<RunnerProcessTable["inspect"]>>;
}

export const runnerMembersGone = (
	table: RunnerProcessTable,
	members: readonly {
		readonly pid: number;
		readonly startTime?: string | undefined;
	}[],
) => {
	if (members.length === 0) return true;
	const current = table.inspectMany?.([
		...new Set(members.map((member) => member.pid)),
	]);
	const inspect: RunnerProcessTable["inspect"] = (target) =>
		current
			? (current.get(target) ?? { state: "unknown" })
			: table.inspect(target);
	const gone = (target: number, started?: string) => {
		const process = inspect(target);
		return (
			process.state === "gone" ||
			process.state === "zombie" ||
			(started !== undefined &&
				process.startTime !== undefined &&
				process.startTime !== started)
		);
	};
	return members.every((member) => gone(member.pid, member.startTime));
};

export const runnerProcessTable: RunnerProcessTable = {
	inspectMany: (pids) => {
		const observed = new Map<
			number,
			ReturnType<RunnerProcessTable["inspect"]>
		>();
		// A gone pid is a gone member (6.6) without a ps.
		for (const pid of pids)
			if (!runnerPidAlive(pid)) observed.set(pid, { state: "gone" });
		const live = pids.filter((pid) => !observed.has(pid));
		if (live.length === 0) return observed;
		try {
			const output = execFileSync(
				"ps",
				["-o", "pid=,pgid=,lstart=,stat=", "-p", live.join(",")],
				{
					encoding: "utf8",
					env: { ...process.env, LC_ALL: "C" },
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 1000,
				},
			);
			for (const line of output.split("\n")) {
				const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(line);
				if (match?.[1] && match[2] && match[3] && match[4])
					observed.set(Number(match[1]), {
						state: match[4].startsWith("Z") ? "zombie" : "running",
						startTime: match[3],
						pgid: Number(match[2]),
					});
			}
		} catch {
			// A failed inspection is not proof that a process has exited.
		}
		for (const pid of pids)
			if (!observed.has(pid))
				observed.set(pid, { state: runnerPidAlive(pid) ? "unknown" : "gone" });
		return observed;
	},
	inspect: (pid) => {
		if (!runnerPidAlive(pid)) return { state: "gone" };
		try {
			const output = execFileSync(
				"ps",
				["-o", "pgid=,lstart=,stat=", "-p", String(pid)],
				{
					encoding: "utf8",
					// lstart is persisted and compared across daemon environments.
					env: { ...process.env, LC_ALL: "C" },
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 1000,
				},
			).trim();
			const match = /^(\d+)\s+(.*?)\s+(\S+)$/.exec(output);
			if (!match?.[1] || !match[2] || !match[3]) return { state: "unknown" };
			return {
				state: match[3].startsWith("Z") ? "zombie" : "running",
				startTime: match[2],
				pgid: Number(match[1]),
			};
		} catch {
			return { state: runnerPidAlive(pid) ? "unknown" : "gone" };
		}
	},
	signal: (pid, signal) => process.kill(pid, signal),
	alive: runnerPidAlive,
	members: (pgid) => {
		// A group with no member has none to list (6.6).
		if (!runnerPidAlive(-pgid)) return [];
		try {
			const output = execFileSync("ps", ["-axo", "pid=,pgid=,lstart="], {
				encoding: "utf8",
				env: { ...process.env, LC_ALL: "C" },
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1000,
			});
			return output.split("\n").flatMap((line) => {
				const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
				return match?.[1] && match[2] && match[3] && Number(match[2]) === pgid
					? [{ pid: Number(match[1]), startTime: match[3] }]
					: [];
			});
		} catch {
			return undefined;
		}
	},
};

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

export function registerRunner(entry: RunnerRegistration): void {
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
	const contents = JSON.stringify({
		...entry,
		startTime:
			entry.startTime ??
			previous.startTime ??
			runnerProcessTable.inspect(entry.pid).startTime,
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
): RunnerRegistration[] {
	const directory = prepareRunnerDirectory(workspaceRoot, configDir);
	return discoverRunnersInDirectory(directory);
}

/** Daemon recovery includes retained projects whose folders are no longer registered. */
export function discoverAllRunners(
	configDir = DEFAULT_CONFIG_DIR,
	processTable: RunnerProcessTable = runnerProcessTable,
): RunnerRegistration[] {
	const root = join(resolve(configDir), "r");
	let directories: string[];
	try {
		directories = readdirSync(root);
	} catch (cause) {
		if (isRecord(cause) && cause["code"] === "ENOENT") return [];
		throw cause;
	}
	return directories.flatMap((directory) => {
		if (!/^[0-9a-f]{12}$/.test(directory)) return [];
		const target = join(root, directory);
		if (!lstatSync(target).isDirectory()) return [];
		return discoverRunnersInDirectory(
			prepareRunnerSocketDirectory(target),
			processTable,
		);
	});
}

function discoverRunnersInDirectory(
	directory: string,
	processTable = runnerProcessTable,
): RunnerRegistration[] {
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
				value["pid"] <= 0
			) {
				removeRunnerDiscovery(socketPath);
				continue;
			}
			// A dead process is not a live discovery candidate. Settle uses evidence.
			if (["gone", "zombie"].includes(processTable.inspect(value["pid"]).state))
				continue;
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
	return entries;
}
