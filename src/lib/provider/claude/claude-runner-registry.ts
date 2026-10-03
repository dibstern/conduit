import { createHash } from "node:crypto";
import {
	existsSync,
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
import { createLogger } from "../../logger.js";
import { isRecord } from "../../utils.js";
import { ClaudeRuntimeError } from "../event-sink-errors.js";

export interface ClaudeRunnerRegistration {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly socketPath: string;
	readonly buildId: string;
	readonly pid: number;
	readonly role?: "candidate" | "retiring";
	/** A recovery journal without a live registration has no process to adopt. */
	readonly stopped?: true;
	/** Quarantined evidence is never replayed; only unfinished turn settlement retries. */
	readonly recoveryFailed?: true;
}

const log = createLogger("claude-runner-registry");

export function quarantineClaudeRunnerJournal(
	registration: Pick<ClaudeRunnerRegistration, "runnerId" | "socketPath">,
	cause: unknown,
): void {
	log.error(
		`Quarantining Claude runner ${registration.runnerId} recovery journal: ${String(cause)}`,
	);
	renameSync(
		`${registration.socketPath}.recovery`,
		`${registration.socketPath}.recovery.failed`,
	);
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

export function removeClaudeRunner(socketPath: string): void {
	for (const suffix of ["", ".json", ".spool"])
		rmSync(`${socketPath}${suffix}`, { force: true });
}

export function discoverClaudeRunners(
	workspaceRoot: string,
	configDir = DEFAULT_CONFIG_DIR,
	includeStopped = false,
): ClaudeRunnerRegistration[] {
	const entries: ClaudeRunnerRegistration[] = [];
	const seen = new Set<string>();
	let directory: string;
	let filenames: string[];
	try {
		directory = prepareClaudeRunnerDirectory(workspaceRoot, configDir);
		filenames = readdirSync(directory).sort();
	} catch (cause) {
		log.error("Failed to discover Claude runners", cause);
		return entries;
	}
	for (const filename of filenames) {
		const archived = filename.includes(".recovery");
		const failed = filename.endsWith(".failed");
		if (!/^[0-9a-f]{12}\.(json|recovery(?:\.failed)?)$/.test(filename))
			continue;
		if (archived && !includeStopped) continue;
		const runnerId = filename.slice(0, 12);
		if (seen.has(runnerId)) continue;
		const socketPath = join(directory, runnerId);
		if (failed && existsSync(`${socketPath}.recovery.failed.settled`)) continue;
		let value: unknown;
		try {
			const contents = readFileSync(join(directory, filename), "utf8");
			value = JSON.parse(
				archived ? (contents.split("\n", 1)[0] ?? "") : contents,
			);
			if (
				!isRecord(value) ||
				value["socketPath"] !== socketPath ||
				value["runnerId"] !== runnerId ||
				typeof value["sessionId"] !== "string" ||
				typeof value["buildId"] !== "string" ||
				typeof value["pid"] !== "number" ||
				!Number.isSafeInteger(value["pid"]) ||
				value["pid"] <= 0
			) {
				if (archived)
					throw new ClaudeRuntimeError({
						message: "Invalid stopped Claude runner registration",
					});
				removeClaudeRunner(socketPath);
				continue;
			}
			if (!runnerPidAlive(value["pid"]) && !archived) {
				removeClaudeRunner(socketPath);
				continue;
			}
			seen.add(runnerId);
			entries.push({
				runnerId,
				socketPath,
				sessionId: value["sessionId"],
				buildId: value["buildId"],
				pid: value["pid"],
				...(archived ? { stopped: true as const } : {}),
				...(failed ? { recoveryFailed: true as const } : {}),
				...(value["role"] === "candidate" || value["role"] === "retiring"
					? { role: value["role"] }
					: {}),
			});
		} catch (cause) {
			if (archived) {
				if (!failed) {
					try {
						quarantineClaudeRunnerJournal({ runnerId, socketPath }, cause);
					} catch (error) {
						log.error(`Failed to quarantine Claude runner ${runnerId}`, error);
					}
				}
				seen.add(runnerId);
				entries.push({
					runnerId,
					socketPath,
					sessionId:
						isRecord(value) &&
						value["runnerId"] === runnerId &&
						typeof value["sessionId"] === "string"
							? value["sessionId"]
							: "",
					buildId: "",
					pid: 0,
					stopped: true,
					recoveryFailed: true,
				});
			} else {
				try {
					removeClaudeRunner(socketPath);
				} catch (error) {
					log.error(`Failed to clean Claude runner ${runnerId}`, error);
				}
			}
		}
	}
	return entries.sort(
		(a, b) =>
			(a.role === "candidate" ? 2 : a.role === "retiring" ? 1 : 0) -
			(b.role === "candidate" ? 2 : b.role === "retiring" ? 1 : 0),
	);
}
