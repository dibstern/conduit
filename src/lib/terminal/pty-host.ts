import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import * as nodePty from "node-pty";
import { BUILD_ID } from "../build-id.js";
import type { PtyInfo } from "../shared-types.js";
import { isRecord } from "../utils.js";
import {
	PTY_HOST_PROTOCOL_VERSION,
	PtyHostError,
	type PtyHostMessage,
	PtyHostRequestSchema,
	PtyScrollback,
	ptyHostConfigPath,
	ptyHostSocketPath,
	readPtyFrames,
	writePtyFrame,
} from "./pty-host-protocol.js";

const requireFromHere = createRequire(import.meta.url);

function ensureSpawnHelperExecutable(): void {
	if (process.platform !== "darwin") return;
	const root = resolve(dirname(requireFromHere.resolve("node-pty")), "..");
	for (const helper of [
		join(
			root,
			"prebuilds",
			`${process.platform}-${process.arch}`,
			"spawn-helper",
		),
		join(root, "build", "Release", "spawn-helper"),
	]) {
		if (!existsSync(helper)) continue;
		const mode = lstatSync(helper).mode;
		if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
	}
}

export async function runPtyHost(options: {
	configDir: string;
	buildId?: string;
}): Promise<void> {
	const configuredIdleTimeout = process.env["CONDUIT_PTY_HOST_IDLE_TIMEOUT_MS"];
	const idleTimeoutMs =
		configuredIdleTimeout === undefined
			? 30_000
			: Number(configuredIdleTimeout);
	if (
		!Number.isInteger(idleTimeoutMs) ||
		idleTimeoutMs <= 0 ||
		idleTimeoutMs > 2_147_483_647
	) {
		throw new PtyHostError({
			message:
				"CONDUIT_PTY_HOST_IDLE_TIMEOUT_MS must be an integer from 1 to 2147483647",
		});
	}
	const configDir = ptyHostConfigPath(options.configDir);
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const socketPath = ptyHostSocketPath(configDir);
	const alias = dirname(socketPath);
	if (alias !== configDir) {
		try {
			symlinkSync(configDir, alias);
		} catch (error) {
			if (!isRecord(error) || error["code"] !== "EEXIST") throw error;
			if (
				!lstatSync(alias).isSymbolicLink() ||
				readlinkSync(alias) !== configDir ||
				lstatSync(alias).uid !== process.getuid?.()
			) {
				throw new PtyHostError({
					message: `Unsafe PTY socket alias: ${alias}`,
				});
			}
		}
	}
	const generation = randomUUID();
	const privateSocket = join(alias, `h-${generation}`);
	const publication = join(alias, `s-${generation}`);
	const election = join(configDir, ".pty-host-lock");
	const candidate = join(configDir, `.pty-host-candidate-${generation}`);
	let elected = false;
	const removeGeneration = (directory: string, owner: string): void => {
		try {
			unlinkSync(join(directory, owner));
		} catch (error) {
			if (!isRecord(error) || error["code"] !== "ENOENT") throw error;
		}
		try {
			// A new generation's marker prevents a stale cleaner removing its lock.
			rmdirSync(directory);
		} catch (error) {
			if (
				!isRecord(error) ||
				!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error["code"]))
			)
				throw error;
		}
	};

	interface Terminal {
		pty: PtyInfo;
		process: nodePty.IPty;
		scrollback: PtyScrollback;
		exitCode: number | null;
		subscribers: Set<Socket>;
	}
	const terminals = new Map<string, Terminal>();
	const sockets = new Set<Socket>();
	const buildId = options.buildId ?? BUILD_ID;
	let stopping = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const cancelIdleShutdown = (): void => {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const canExpire = (): boolean =>
		elected &&
		!stopping &&
		sockets.size === 0 &&
		![...terminals.values()].some((terminal) => terminal.exitCode === null);
	const scheduleIdleShutdown = (): void => {
		cancelIdleShutdown();
		if (!canExpire()) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			if (canExpire()) shutdown();
		}, idleTimeoutMs);
	};
	let done: () => void = () => {};
	const stopped = new Promise<void>((resolveStopped) => {
		done = resolveStopped;
	});
	const send = (socket: Socket, message: PtyHostMessage): void => {
		try {
			writePtyFrame(socket, message);
		} catch {
			socket.destroy();
		}
	};
	const releasePaths = (): void => {
		for (const file of elected ? [socketPath, publication] : [publication]) {
			try {
				unlinkSync(file);
			} catch (error) {
				if (!isRecord(error) || error["code"] !== "ENOENT")
					console.error(error);
			}
		}
		try {
			removeGeneration(elected ? election : candidate, generation);
		} catch (error) {
			console.error(error);
		}
		// The shared short-path alias outlives generations; removing it can break
		// a replacement host that has already elected itself.
	};
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		cancelIdleShutdown();
		for (const terminal of terminals.values()) {
			if (terminal.pty.status === "running") {
				terminal.pty = { ...terminal.pty, status: "exited" };
				terminal.exitCode = 137;
				for (const subscriber of terminal.subscribers)
					send(subscriber, {
						type: "exit",
						id: terminal.pty.id,
						exitCode: 137,
					});
				try {
					terminal.process.kill("SIGKILL");
				} catch (error) {
					console.error(error);
				}
			}
		}
		terminals.clear();
		// Keep the generation's listener live until shared paths are released.
		releasePaths();
		server.close();
		for (const socket of sockets) socket.end();
		const deadline = setTimeout(() => {
			for (const socket of sockets) socket.destroy();
			done();
		}, 500);
		server.once("close", () => {
			clearTimeout(deadline);
			done();
		});
	};

	const server = createServer((socket) => {
		if (stopping) {
			socket.destroy();
			return;
		}
		cancelIdleShutdown();
		sockets.add(socket);
		let negotiated = false;
		const attached = new Set<string>();
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			sockets.delete(socket);
			for (const id of attached) terminals.get(id)?.subscribers.delete(socket);
			scheduleIdleShutdown();
		});
		readPtyFrames(
			socket,
			Schema.decodeUnknownSync(PtyHostRequestSchema),
			(message) => {
				if (stopping) return;
				if (message.type === "hello") {
					send(socket, {
						type: "hello",
						protocolVersion: PTY_HOST_PROTOCOL_VERSION,
						buildId,
						pid: process.pid,
						openTerminals: terminals.size,
					});
					negotiated = message.protocolVersion === PTY_HOST_PROTOCOL_VERSION;
					if (!negotiated) {
						console.error(
							`PTY host protocol mismatch: server=${message.protocolVersion}, host=${PTY_HOST_PROTOCOL_VERSION}`,
						);
						socket.end();
					}
					return;
				}
				if (!negotiated) {
					socket.destroy();
					return;
				}
				try {
					switch (message.type) {
						case "create": {
							cancelIdleShutdown();
							ensureSpawnHelperExecutable();
							const ptyProcess = nodePty.spawn(message.shell, [], {
								name: "xterm-256color",
								cols: message.cols,
								rows: message.rows,
								cwd: resolve(message.cwd),
								env: {
									...message.env,
									COLORTERM: "truecolor",
									CONDUIT: "1",
									TERM: message.env["TERM"] ?? "xterm-256color",
								},
							});
							const pty: PtyInfo = {
								id: `local-pty-${randomUUID()}`,
								title: "Terminal",
								command: message.shell.split("/").at(-1) ?? message.shell,
								cwd: resolve(message.cwd),
								status: "running",
								pid: ptyProcess.pid,
							};
							const terminal: Terminal = {
								pty,
								process: ptyProcess,
								scrollback: new PtyScrollback(),
								exitCode: null,
								subscribers: new Set(),
							};
							terminals.set(pty.id, terminal);
							ptyProcess.onData((data) => {
								if (stopping || terminals.get(pty.id) !== terminal) return;
								terminal.scrollback.append(data);
								for (const subscriber of terminal.subscribers)
									send(subscriber, { type: "output", id: pty.id, data });
							});
							ptyProcess.onExit(({ exitCode }) => {
								if (terminal.exitCode !== null) return;
								terminal.pty = { ...terminal.pty, status: "exited" };
								terminal.exitCode = exitCode;
								for (const subscriber of terminal.subscribers)
									send(subscriber, { type: "exit", id: pty.id, exitCode });
								scheduleIdleShutdown();
							});
							send(socket, {
								type: "created",
								requestId: message.requestId,
								pty,
							});
							break;
						}
						case "list":
							send(socket, {
								type: "list",
								requestId: message.requestId,
								terminals: [...terminals.values()]
									.filter(
										(terminal) => terminal.pty.cwd === resolve(message.cwd),
									)
									.map(({ pty, exitCode }) => ({ pty, exitCode })),
							});
							break;
						case "attach": {
							const terminal = terminals.get(message.id);
							if (!terminal || terminal.pty.cwd !== resolve(message.cwd))
								throw new PtyHostError({
									message: `Unknown terminal: ${message.id}`,
								});
							// Subscribe and enqueue the snapshot synchronously. Later PTY events
							// follow this response on the socket, with no replay/live gap.
							terminal.subscribers.add(socket);
							attached.add(message.id);
							send(socket, {
								type: "attached",
								requestId: message.requestId,
								pty: terminal.pty,
								exitCode: terminal.exitCode,
								scrollback: terminal.scrollback.read(),
							});
							break;
						}
						case "input":
							if (!attached.has(message.id))
								throw new PtyHostError({
									message: `Terminal not attached: ${message.id}`,
								});
							terminals.get(message.id)?.process.write(message.data);
							break;
						case "resize":
							if (!attached.has(message.id))
								throw new PtyHostError({
									message: `Terminal not attached: ${message.id}`,
								});
							terminals
								.get(message.id)
								?.process.resize(message.cols, message.rows);
							break;
						case "detach":
							terminals.get(message.id)?.subscribers.delete(socket);
							attached.delete(message.id);
							break;
						case "close": {
							if (!attached.has(message.id))
								throw new PtyHostError({
									message: `Terminal not attached: ${message.id}`,
								});
							const terminal = terminals.get(message.id);
							if (terminal?.pty.status === "running") terminal.process.kill();
							terminals.delete(message.id);
							attached.delete(message.id);
							scheduleIdleShutdown();
							break;
						}
						case "stop": {
							const allowed = message.force || terminals.size === 0;
							send(socket, {
								type: "stopped",
								requestId: message.requestId,
								stopped: allowed,
							});
							if (allowed) shutdown();
							break;
						}
					}
				} catch (error) {
					send(socket, {
						type: "error",
						...("requestId" in message ? { requestId: message.requestId } : {}),
						message: error instanceof Error ? error.message : String(error),
					});
				}
			},
			(error) => {
				console.error(`PTY host invalid frame: ${error.message}`);
				socket.destroy();
			},
		);
	});
	try {
		const inheritedUmask = process.umask(0o077);
		try {
			await new Promise<void>((ready, fail) => {
				server.once("error", fail);
				server.listen(privateSocket, () => {
					server.off("error", fail);
					ready();
				});
			});
			chmodSync(privateSocket, 0o600);
		} finally {
			// Only binding needs a restrictive process mask. Shells inherit the
			// invoking user's mask; every other IPC path has an explicit mode.
			process.umask(inheritedUmask);
		}
		mkdirSync(candidate, { mode: 0o700 });
		writeFileSync(join(candidate, generation), "", { mode: 0o600 });
		for (;;) {
			try {
				// POSIX rename cannot replace a nonempty directory. The marker and
				// live listener are published together without an empty-lock window.
				renameSync(candidate, election);
				elected = true;
				break;
			} catch (error) {
				if (
					!isRecord(error) ||
					!["EEXIST", "ENOTEMPTY"].includes(String(error["code"]))
				)
					throw error;
			}
			let entries: string[];
			try {
				entries = readdirSync(election);
			} catch (error) {
				if (isRecord(error) && error["code"] === "ENOENT") continue;
				throw error;
			}
			if (entries.length === 0) {
				// A stale cleaner can be between unlinking its marker and rmdir.
				removeGeneration(election, generation);
				continue;
			}
			const owner = entries[0];
			if (entries.length !== 1 || !owner || !/^[0-9a-f-]{36}$/.test(owner)) {
				throw new PtyHostError({
					message: `Invalid PTY host lock: ${election}`,
				});
			}
			const ownerSocket = join(alias, `h-${owner}`);
			const alive = await new Promise<boolean>((ready, fail) => {
				const probe = createConnection(ownerSocket);
				probe.setTimeout(2000, () => {
					probe.destroy();
					fail(
						new PtyHostError({ message: "PTY host liveness probe timed out" }),
					);
				});
				probe.once("connect", () => {
					probe.end();
					ready(true);
				});
				probe.once("error", (error) => {
					if (
						isRecord(error) &&
						["ENOENT", "ECONNREFUSED"].includes(String(error["code"]))
					)
						ready(false);
					else fail(error);
				});
			});
			if (alive) {
				shutdown();
				await stopped;
				return;
			}
			removeGeneration(election, owner);
			try {
				unlinkSync(ownerSocket);
			} catch (error) {
				if (!isRecord(error) || error["code"] !== "ENOENT") throw error;
			}
		}
		symlinkSync(`h-${generation}`, publication);
		renameSync(publication, socketPath);
		server.on("error", (error) => {
			console.error(error);
			shutdown();
		});
		process.once("SIGTERM", shutdown);
		process.once("SIGINT", shutdown);
		console.log(
			`PTY host pid=${process.pid} build=${buildId} socket=${socketPath}`,
		);
		scheduleIdleShutdown();
		await stopped;
	} catch (error) {
		shutdown();
		throw error;
	} finally {
		process.off("SIGTERM", shutdown);
		process.off("SIGINT", shutdown);
	}
}
