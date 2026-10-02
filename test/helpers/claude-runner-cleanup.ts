import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { CLAUDE_RUNNER_PROTOCOL_VERSION } from "../../src/lib/provider/claude/claude-runner-protocol.js";
import type { ClaudeRunnerRegistration } from "../../src/lib/provider/claude/claude-runner-registry.js";
import { isRecord } from "../../src/lib/utils.js";

export function testRunnerAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function registrations(configDir: string): ClaudeRunnerRegistration[] {
	const directory = join(configDir, "r");
	if (!existsSync(directory)) return [];
	const entries: ClaudeRunnerRegistration[] = [];
	for (const project of readdirSync(directory, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		for (const filename of readdirSync(join(directory, project.name))) {
			if (!/^[0-9a-f]{12}\.json$/.test(filename)) continue;
			const socketPath = join(directory, project.name, filename.slice(0, -5));
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
					socketPath,
					runnerId: value["runnerId"],
					sessionId: value["sessionId"],
					buildId: value["buildId"],
					pid: value["pid"],
				});
		}
	}
	return entries;
}

// Never signal a PID from a file until the process identifies itself on its socket.
function requestShutdown(
	root: string,
	entry: ClaudeRunnerRegistration,
): Promise<boolean> {
	return new Promise((done) => {
		const socket = createConnection(entry.socketPath);
		let verified = false;
		let finished = false;
		let buffered = "";
		const commandId = randomUUID();
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.destroy();
			done(verified);
		};
		const timer = setTimeout(finish, 2000);
		socket.once("error", finish);
		socket.once("close", finish);
		socket.once("connect", () =>
			socket.write(
				`${JSON.stringify({ type: "hello", protocolVersion: CLAUDE_RUNNER_PROTOCOL_VERSION, buildId: entry.buildId, config: { workspaceRoot: join(root, "project"), materializeSubagents: false } })}\n`,
			),
		);
		socket.on("data", (chunk: Buffer) => {
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
						message["protocolVersion"] !== CLAUDE_RUNNER_PROTOCOL_VERSION ||
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
) {
	const entries = registrations(configDir);
	const pids = [
		...new Set([...knownPids, ...entries.map((entry) => entry.pid)]),
	];
	for (const entry of entries) {
		if (!testRunnerAlive(entry.pid)) continue;
		const verified = await requestShutdown(root, entry);
		await waitForExit([entry.pid], 500);
		if (verified && testRunnerAlive(entry.pid)) {
			try {
				process.kill(entry.pid, "SIGTERM");
			} catch {
				/* Already exited. */
			}
			await waitForExit([entry.pid], 500);
			if (testRunnerAlive(entry.pid)) {
				try {
					process.kill(entry.pid, "SIGKILL");
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
