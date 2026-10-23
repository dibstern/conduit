import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { RUNNER_PROTOCOL_VERSION } from "../../src/lib/provider/runner/runner-protocol.js";
import {
	prepareRunnerDirectory,
	type RunnerRegistration,
} from "../../src/lib/provider/runner/runner-registry.js";
import { isRecord } from "../../src/lib/utils.js";

export function testRunnerAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return isRecord(cause) && cause["code"] === "EPERM";
	}
}

function registrations(
	projectDir: string,
	configDir: string,
): RunnerRegistration[] {
	const directory = prepareRunnerDirectory(projectDir, configDir);
	const entries: RunnerRegistration[] = [];
	for (const filename of readdirSync(directory)) {
		if (!/^[0-9a-f]{12}\.json$/.test(filename)) continue;
		const socketPath = join(directory, filename.slice(0, -5));
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(`${socketPath}.json`, "utf8"));
		} catch {
			continue;
		}
		if (
			isRecord(value) &&
			value["socketPath"] === socketPath &&
			value["runnerId"] === filename.slice(0, -5) &&
			typeof value["sessionId"] === "string" &&
			typeof value["buildId"] === "string" &&
			typeof value["pid"] === "number" &&
			Number.isSafeInteger(value["pid"]) &&
			value["pid"] > 0
		)
			entries.push({
				...(typeof value["driverKind"] === "string"
					? { driverKind: value["driverKind"] }
					: {}),
				socketPath,
				runnerId: value["runnerId"],
				sessionId: value["sessionId"],
				buildId: value["buildId"],
				pid: value["pid"],
			});
	}
	return entries;
}

// PIDs learned only from files must identify themselves on their sockets.
// A runner serves one client and hangs up on others until it has processed the
// previous client's close, which a loaded machine can delay past cleanup.
async function requestShutdown(
	projectDir: string,
	entry: RunnerRegistration,
): Promise<boolean> {
	const deadline = Date.now() + 2000;
	for (;;) {
		const outcome = await attemptShutdown(projectDir, entry);
		if (outcome !== "refused" || Date.now() >= deadline)
			return outcome === true;
		await new Promise<void>((done) => setTimeout(done, 25));
	}
}

function attemptShutdown(
	projectDir: string,
	entry: RunnerRegistration,
): Promise<boolean | "refused"> {
	return new Promise((done) => {
		const socket = createConnection(entry.socketPath);
		let verified = false;
		let heard = false;
		let finished = false;
		let buffered = "";
		const commandId = randomUUID();
		const finish = (refused = false) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.destroy();
			done(refused ? "refused" : verified);
		};
		const timer = setTimeout(() => finish(), 2000);
		socket.once("error", () => finish());
		// A hang-up before any reply means the runner is still busy with another client.
		socket.once("close", () => finish(!heard));
		socket.once("connect", () =>
			socket.write(
				`${JSON.stringify({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, buildId: entry.buildId, driverKind: entry.driverKind, config: { workspaceRoot: projectDir } })}\n`,
			),
		);
		socket.on("data", (chunk: Buffer) => {
			heard = true;
			buffered += chunk.toString();
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					finish();
					return;
				}
				if (isRecord(message) && message["type"] === "hello") {
					if (
						message["protocolVersion"] !== RUNNER_PROTOCOL_VERSION ||
						message["buildId"] !== entry.buildId ||
						message["runnerId"] !== entry.runnerId ||
						message["sessionId"] !== entry.sessionId ||
						message["pid"] !== entry.pid
					) {
						finish();
						return;
					}
					verified = true;
					socket.write(
						`${JSON.stringify({ type: "command", commandId, command: { type: "shutdown" } })}\n`,
					);
				} else if (
					isRecord(message) &&
					message["type"] === "command-reply" &&
					message["commandId"] === commandId
				) {
					finish();
					return;
				}
				newline = buffered.indexOf("\n");
			}
		});
	});
}

async function waitForExit(
	pids: readonly number[],
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (pids.some(testRunnerAlive) && Date.now() < deadline)
		await new Promise<void>((done) => setTimeout(done, 25));
}

export async function cleanupTestClaudeRunners(
	root: string,
	knownPids: readonly number[],
	configDir = join(root, "config"),
	projectDir = join(root, "project"),
) {
	const entries = registrations(projectDir, configDir);
	// Known PIDs come from processes owned by the test, even if registration vanished.
	const ownedPids = new Set(knownPids);
	const pids = [
		...new Set([...knownPids, ...entries.map((entry) => entry.pid)]),
	];
	for (const entry of entries) {
		if (!testRunnerAlive(entry.pid)) continue;
		if (await requestShutdown(projectDir, entry)) ownedPids.add(entry.pid);
	}
	await waitForExit(pids, 500);
	for (const pid of ownedPids) {
		if (testRunnerAlive(pid)) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* Already exited. */
			}
			await waitForExit([pid], 500);
			if (testRunnerAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
		}
	}
	await waitForExit(pids, 5000);
	return {
		configDir,
		runnerPids: pids,
		remainingPids: pids.filter(testRunnerAlive),
	};
}
