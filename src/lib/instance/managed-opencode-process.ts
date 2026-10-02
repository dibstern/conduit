import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data } from "effect";
import type { ManagedOpenCodeProcessIdentity } from "../contracts/managed-opencode.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import { isRecord } from "../utils.js";

export class ManagedOpenCodeProcessError extends Data.TaggedError(
	"ManagedOpenCodeProcessError",
)<{
	message: string;
}> {}

export interface ManagedOpenCodeRecord {
	pid?: number;
	port: number;
	env?: Record<string, string>;
	version?: string;
	processIdentity?: ManagedOpenCodeProcessIdentity;
}

export function publicManagedOpenCodeEnv(
	env: Record<string, string>,
): Record<string, string>;
export function publicManagedOpenCodeEnv(
	env?: Record<string, string>,
): Record<string, string> | undefined;
export function publicManagedOpenCodeEnv(env?: Record<string, string>) {
	if (!env) return undefined;
	const { OPENCODE_SERVER_PASSWORD: _password, ...visible } = env;
	return visible;
}

export const openCodeAuth = (env?: Record<string, string>) =>
	env?.["OPENCODE_SERVER_PASSWORD"]
		? {
				username:
					env["OPENCODE_SERVER_USERNAME"] ??
					process.env["OPENCODE_SERVER_USERNAME"] ??
					"opencode",
				password: env["OPENCODE_SERVER_PASSWORD"],
			}
		: undefined;

export const managedOpenCodeEnv = (
	env?: Record<string, string>,
): Record<string, string> => ({
	...env,
	OPENCODE_SERVER_USERNAME:
		env?.["OPENCODE_SERVER_USERNAME"] ||
		process.env["OPENCODE_SERVER_USERNAME"] ||
		"opencode",
	OPENCODE_SERVER_PASSWORD:
		env?.["OPENCODE_SERVER_PASSWORD"] ||
		process.env["OPENCODE_SERVER_PASSWORD"] ||
		randomBytes(32).toString("hex"),
});

export function isProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return isRecord(cause) && cause["code"] === "EPERM";
	}
}

export async function availableOpenCodePort(
	preferredPort = 0,
): Promise<number> {
	const server = createServer();
	return new Promise((resolve, reject) => {
		server.once("error", (cause) => {
			if (
				preferredPort !== 0 &&
				isRecord(cause) &&
				cause["code"] === "EADDRINUSE"
			)
				availableOpenCodePort().then(resolve, reject);
			else reject(cause);
		});
		server.listen(preferredPort, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => {
				if (error) reject(error);
				else if (address && typeof address !== "string") resolve(address.port);
				else
					reject(
						new ManagedOpenCodeProcessError({
							message: "Could not allocate an OpenCode port",
						}),
					);
			});
		});
	});
}

export function spawnManagedOpenCode(
	id: string,
	port: number,
	env: Record<string, string>,
	configDir = DEFAULT_CONFIG_DIR,
): Promise<{
	pid: number;
	process: ChildProcess;
	processIdentity: ManagedOpenCodeProcessIdentity;
}> {
	const logDir = join(configDir, "logs");
	mkdirSync(logDir, { recursive: true, mode: 0o700 });
	const logPath = join(logDir, `opencode-${encodeURIComponent(id)}.log`);
	const fd = openSync(logPath, "a", 0o600);
	const token = randomBytes(32).toString("hex");
	const compiled = new URL("./managed-opencode-supervisor.js", import.meta.url);
	const supervisorPath = fileURLToPath(
		existsSync(compiled)
			? compiled
			: new URL("./managed-opencode-supervisor.ts", import.meta.url),
	);
	let child: ChildProcess;
	try {
		chmodSync(logPath, 0o600);
		child = spawn(process.execPath, [supervisorPath, String(port)], {
			detached: true,
			env: { ...process.env, ...env, CONDUIT_OPENCODE_CONTROL_TOKEN: token },
			stdio: ["ignore", fd, fd, "ipc"],
		});
	} finally {
		closeSync(fd);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (child.connected) child.disconnect();
			child.unref();
			reject(
				new ManagedOpenCodeProcessError({
					message: "OpenCode supervisor startup timed out",
				}),
			);
		}, 5000);
		child.once("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
		child.once("exit", () => {
			clearTimeout(timer);
			reject(
				new ManagedOpenCodeProcessError({
					message: "OpenCode supervisor exited during startup",
				}),
			);
		});
		child.once("message", (message: unknown) => {
			if (
				!isRecord(message) ||
				typeof message["pid"] !== "number" ||
				typeof message["controlPort"] !== "number" ||
				message["supervisorPid"] !== child.pid
			)
				return;
			clearTimeout(timer);
			if (child.pid === undefined)
				reject(
					new ManagedOpenCodeProcessError({
						message: "OpenCode spawned without a PID",
					}),
				);
			else
				resolve({
					pid: message["pid"],
					process: child,
					processIdentity: {
						supervisorPid: child.pid,
						controlPort: message["controlPort"],
						token,
					},
				});
		});
	});
}

export function commitManagedOpenCodeSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (cause?: Error) => {
			clearTimeout(timer);
			child.off("message", committed);
			child.off("exit", exited);
			if (child.connected) child.disconnect();
			child.unref();
			if (cause) reject(cause);
			else resolve();
		};
		const committed = (message: unknown) => {
			if (isRecord(message) && message["committed"] === true) finish();
		};
		const exited = () =>
			finish(
				new ManagedOpenCodeProcessError({
					message: "OpenCode supervisor exited before committing its identity",
				}),
			);
		const timer = setTimeout(
			() =>
				finish(
					new ManagedOpenCodeProcessError({
						message:
							"OpenCode supervisor did not acknowledge persisted identity",
					}),
				),
			3000,
		);
		child.on("message", committed);
		child.once("exit", exited);
		child.send({ command: "commit" }, (cause) => {
			if (cause) finish(cause);
		});
	});
}

export async function probeOpenCodeHealth(
	port: number,
	env?: Record<string, string>,
): Promise<{ version?: string } | undefined> {
	try {
		const auth = openCodeAuth(env);
		const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
			redirect: "error",
			...(auth
				? {
						headers: {
							Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
						},
					}
				: {}),
			signal: AbortSignal.timeout(1000),
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		if (!isRecord(body) || body["healthy"] !== true) return undefined;
		return typeof body["version"] === "string"
			? { version: body["version"] }
			: {};
	} catch {
		return undefined;
	}
}

const controlRequest = async (
	identity: ManagedOpenCodeProcessIdentity,
	command: "probe" | "stop",
	launchPid?: number,
): Promise<Record<string, unknown> | undefined> =>
	new Promise((resolve) => {
		const socket = createConnection({
			host: "127.0.0.1",
			port: identity.controlPort,
		});
		let input = "";
		socket.setTimeout(3000, () => {
			socket.destroy();
			resolve(undefined);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(undefined);
		});
		socket.once("connect", () =>
			socket.write(`${JSON.stringify({ ...identity, command, launchPid })}\n`),
		);
		socket.on("data", (chunk: Buffer) => {
			input += chunk.toString();
			if (input.length > 4096) {
				socket.destroy();
				resolve(undefined);
				return;
			}
			if (!input.includes("\n")) return;
			socket.destroy();
			try {
				const response: unknown = JSON.parse(input);
				resolve(
					isRecord(response) &&
						response["supervisorPid"] === identity.supervisorPid
						? response
						: undefined,
				);
			} catch {
				resolve(undefined);
			}
		});
		socket.once("close", () => resolve(undefined));
	});

export async function inspectManagedOpenCodeProcess(
	identity?: ManagedOpenCodeProcessIdentity,
) {
	if (!identity) return undefined;
	const response = await controlRequest(identity, "probe");
	if (!response || typeof response["launchPid"] !== "number") return undefined;
	return {
		launchPid: response["launchPid"],
		pid:
			typeof response["pid"] === "number"
				? response["pid"]
				: response["launchPid"],
		running: response["running"] === true,
		listening: response["listening"] === true,
	};
}

export async function canReuseManagedOpenCode(
	instance: ManagedOpenCodeRecord,
): Promise<boolean> {
	if (
		!instance.pid ||
		instance.pid === process.pid ||
		!isProcessAlive(instance.pid) ||
		!openCodeAuth(instance.env)
	)
		return false;
	const owned = await inspectManagedOpenCodeProcess(instance.processIdentity);
	if (
		!owned?.running ||
		!owned.listening ||
		(instance.pid !== owned.pid && instance.pid !== owned.launchPid)
	)
		return false;
	if (!(await probeOpenCodeHealth(instance.port, instance.env))) return false;
	// A permissive server would accept any password, so a 200 alone cannot
	// establish ownership of a persisted PID or port.
	try {
		const response = await fetch(
			`http://127.0.0.1:${instance.port}/global/health`,
			{
				redirect: "error",
				headers: {
					Authorization: `Basic ${Buffer.from("opencode:invalid-conduit-credential").toString("base64")}`,
				},
				signal: AbortSignal.timeout(1000),
			},
		);
		const after = await inspectManagedOpenCodeProcess(instance.processIdentity);
		return (
			response.status === 401 &&
			after?.running === true &&
			after.listening &&
			after.pid === owned.pid
		);
	} catch {
		return false;
	}
}

export async function waitForOpenCodeHealth(
	instance: {
		port: number;
		env?: Record<string, string>;
		processIdentity: ManagedOpenCodeProcessIdentity;
	},
	child: ChildProcess,
	signal?: AbortSignal,
): Promise<{ version?: string; pid: number }> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (signal?.aborted)
			throw new ManagedOpenCodeProcessError({
				message: "OpenCode startup interrupted",
			});
		if (child.exitCode !== null || child.signalCode !== null)
			throw new ManagedOpenCodeProcessError({
				message: "OpenCode exited during startup",
			});
		const health = await probeOpenCodeHealth(instance.port, instance.env);
		if (health) {
			const owned = await inspectManagedOpenCodeProcess(
				instance.processIdentity,
			);
			if (owned?.running && owned.listening)
				return { ...health, pid: owned.pid };
		}
		await new Promise<void>((done) => setTimeout(done, 100));
	}
	throw new ManagedOpenCodeProcessError({
		message: "Timed out waiting for managed OpenCode health",
	});
}

export async function stopManagedOpenCode(
	record: Pick<ManagedOpenCodeRecord, "pid" | "processIdentity">,
): Promise<boolean> {
	const identity = record.processIdentity;
	const owned = await inspectManagedOpenCodeProcess(identity);
	if (
		!identity ||
		!owned ||
		(record.pid !== undefined &&
			record.pid !== owned.pid &&
			record.pid !== owned.launchPid)
	)
		return false;
	const stopped = await controlRequest(identity, "stop", owned.launchPid);
	if (stopped?.["stopped"] !== true) return false;
	const deadline = Date.now() + 4000;
	while (isProcessAlive(identity.supervisorPid) && Date.now() < deadline)
		await new Promise<void>((done) => setTimeout(done, 50));
	if (isProcessAlive(identity.supervisorPid))
		throw new ManagedOpenCodeProcessError({
			message: "Managed OpenCode supervisor did not exit",
		});
	return true;
}
