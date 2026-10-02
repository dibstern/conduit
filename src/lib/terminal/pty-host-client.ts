import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Schema } from "effect";
import { BUILD_ID } from "../build-id.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import type { PtyUpstream } from "../relay/pty-manager.js";
import type { PtyInfo } from "../shared-types.js";
import { isRecord } from "../utils.js";
import {
	PTY_HOST_PROTOCOL_VERSION,
	PtyHostError,
	type PtyHostHello,
	type PtyHostMessage,
	PtyHostMessageSchema,
	PtyHostProtocolMismatch,
	type PtyHostRequest,
	PtyScrollback,
	ptyHostConfigPath,
	ptyHostSocketPath,
	readPtyFrames,
	writePtyFrame,
} from "./pty-host-protocol.js";

type RequestBody<T> = T extends { requestId: number }
	? Omit<T, "requestId">
	: never;
interface HostOptions {
	configDir?: string;
	buildId?: string;
	start?: boolean;
	log?: { warn(message: string): void };
}

export interface HostedPtySession {
	readonly pty: PtyInfo;
	readonly upstream: PtyUpstream;
	onData(handler: (data: string) => void): void;
	onExit(handler: (exitCode: number) => void): void;
	onDisconnect(handler: () => void): void;
}

export function isPtyHostUnavailable(error: unknown): boolean {
	return (
		isRecord(error) &&
		["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(
			String(error["code"]),
		)
	);
}

interface OwnedHost {
	child: ChildProcess;
	exited: Promise<void>;
	finished: boolean;
	cancelled: boolean;
}

const ownedHosts = new Map<string, Set<OwnedHost>>();

async function waitForOwnedHosts(
	hosts: OwnedHost[],
	timeoutMs = 2000,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.all(hosts.map(({ exited }) => exited)),
			new Promise<never>((_, fail) => {
				timer = setTimeout(
					() =>
						fail(
							new PtyHostError({
								message:
									"PTY host process did not exit before shutdown deadline",
							}),
						),
					Math.max(1, timeoutMs),
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function spawnHost(configDir: string): OwnedHost {
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const key = ptyHostConfigPath(configDir);
	const js = new URL("../../bin/pty-host.js", import.meta.url);
	const entry = existsSync(fileURLToPath(js))
		? fileURLToPath(js)
		: fileURLToPath(new URL("../../bin/pty-host.ts", import.meta.url));
	const args = entry.endsWith(".ts")
		? [
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				entry,
			]
		: [entry];
	const log = openSync(join(configDir, "pty-host.log"), "a", 0o600);
	try {
		const child = spawn(process.execPath, args, {
			detached: true,
			stdio: ["ignore", log, log],
			env: { ...process.env, CONDUIT_CONFIG_DIR: configDir },
		});
		let exited = () => {};
		const host: OwnedHost = {
			child,
			exited: new Promise<void>((done) => {
				exited = done;
			}),
			finished: false,
			cancelled: false,
		};
		const hosts = ownedHosts.get(key) ?? new Set<OwnedHost>();
		ownedHosts.set(key, hosts);
		hosts.add(host);
		const finish = (): void => {
			if (host.finished) return;
			host.finished = true;
			hosts.delete(host);
			if (hosts.size === 0 && ownedHosts.get(key) === hosts)
				ownedHosts.delete(key);
			exited();
		};
		child.once("exit", finish);
		child.once("error", (error) => {
			console.error(`Could not spawn PTY host: ${error.message}`);
			finish();
		});
		child.unref();
		return host;
	} finally {
		closeSync(log);
	}
}

class HostedSession implements HostedPtySession {
	readonly upstream: PtyUpstream;
	private readonly buffered = new PtyScrollback();
	private dataHandler: ((data: string) => void) | undefined;
	private exitHandler: ((exitCode: number) => void) | undefined;
	private disconnectHandler: (() => void) | undefined;
	private connectionLost = false;
	private detached = false;

	constructor(
		public pty: PtyInfo,
		private exitCode: number | null,
		scrollback: string,
		client: PtyHostClient,
	) {
		this.buffered.append(scrollback);
		const send = (message: PtyHostRequest) => client.send(message);
		const close = () => {
			if (this.detached) return;
			if (client.connected) send({ type: "close", id: pty.id });
			this.detached = true;
			client.forget(pty.id);
		};
		const session = this;
		this.upstream = {
			get readyState() {
				return session.detached
					? 3
					: !client.connected
						? 0
						: session.exitCode !== null
							? 3
							: 1;
			},
			send: (data, callback) => {
				try {
					const text =
						typeof data === "string"
							? data
							: Buffer.isBuffer(data)
								? data.toString("utf8")
								: Buffer.from(data).toString("utf8");
					send({ type: "input", id: pty.id, data: text });
					callback?.();
				} catch (error) {
					const failure =
						error instanceof Error
							? error
							: new PtyHostError({ message: String(error) });
					if (!callback) throw failure;
					callback(failure);
				}
			},
			resize: (cols, rows) => send({ type: "resize", id: pty.id, cols, rows }),
			close,
			terminate: close,
			detach: () => {
				if (this.detached) return;
				if (client.connected) send({ type: "detach", id: pty.id });
				this.detached = true;
				client.forget(pty.id);
			},
		};
	}

	onData(handler: (data: string) => void): void {
		this.dataHandler = handler;
		const replay = this.buffered.read();
		this.buffered.clear();
		if (replay) handler(replay);
	}

	onExit(handler: (exitCode: number) => void): void {
		this.exitHandler = handler;
		if (this.exitCode !== null) handler(this.exitCode);
	}

	onDisconnect(handler: () => void): void {
		this.disconnectHandler = handler;
		if (this.connectionLost) handler();
	}

	disconnected(): void {
		if (this.detached || this.exitCode !== null || this.connectionLost) return;
		this.connectionLost = true;
		this.disconnectHandler?.();
	}

	output(data: string): void {
		if (this.dataHandler) this.dataHandler(data);
		else this.buffered.append(data);
	}

	exited(exitCode: number): void {
		this.pty = { ...this.pty, status: "exited" };
		this.exitCode = exitCode;
		this.exitHandler?.(exitCode);
	}
}

export class PtyHostClient {
	private identity: PtyHostHello | undefined;
	private readonly sessions = new Map<string, HostedSession>();
	private readonly pending = new Map<
		number,
		{ resolve(message: PtyHostMessage): void; reject(error: Error): void }
	>();
	private nextRequestId = 0;
	private intentionalDisconnect = false;
	private readonly ready: Promise<void>;
	private readonly closed: Promise<void>;

	private constructor(
		private readonly socket: Socket,
		buildId: string,
		private readonly log: HostOptions["log"],
		protocolVersion = PTY_HOST_PROTOCOL_VERSION,
	) {
		let failReady: (error: Error) => void = () => {};
		let ready: () => void = () => {};
		this.ready = new Promise<void>((done, fail) => {
			ready = done;
			failReady = fail;
		});
		const timer = setTimeout(
			() => fail(new Error("PTY host hello timed out")),
			2000,
		);
		const fail = (error: Error): void => {
			clearTimeout(timer);
			failReady(error);
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear();
			this.socket.destroy();
			if (!this.intentionalDisconnect)
				for (const session of this.sessions.values()) session.disconnected();
		};
		this.closed = new Promise<void>((done) =>
			socket.once("close", () => {
				if (!this.intentionalDisconnect && this.identity)
					log?.warn(
						"PTY host connection lost; terminals will be rediscovered on reconnect",
					);
				fail(
					new PtyHostError({
						message: "PTY host disconnected",
						code: "ECONNRESET",
					}),
				);
				done();
			}),
		);
		socket.on("error", fail);
		readPtyFrames(
			socket,
			Schema.decodeUnknownSync(PtyHostMessageSchema),
			(message) => {
				if (message.type === "hello") {
					clearTimeout(timer);
					if (message.protocolVersion !== protocolVersion) {
						const error = new PtyHostProtocolMismatch({
							message: `PTY host protocol mismatch: server=${protocolVersion}, host=${message.protocolVersion}; refusing connection`,
							protocolVersion: message.protocolVersion,
						});
						log?.warn(error.message);
						fail(error);
						return;
					}
					this.identity = message;
					ready();
					return;
				}
				if (!this.identity) {
					fail(new Error("PTY host sent data before hello"));
					return;
				}
				if (message.type === "output") {
					this.sessions.get(message.id)?.output(message.data);
					return;
				}
				if (message.type === "exit") {
					this.sessions.get(message.id)?.exited(message.exitCode);
					return;
				}
				if (message.type === "error") {
					if (message.requestId === undefined)
						log?.warn(`PTY host: ${message.message}`);
					else
						this.pending
							.get(message.requestId)
							?.reject(new Error(message.message));
				} else {
					// Install the replay before resolving attach. Output in the same
					// socket read is buffered until the relay registers its handlers.
					if (message.type === "attached")
						this.sessions.set(
							message.pty.id,
							new HostedSession(
								message.pty,
								message.exitCode,
								message.scrollback,
								this,
							),
						);
					this.pending.get(message.requestId)?.resolve(message);
				}
			},
			fail,
		);
		socket.once("connect", () =>
			this.send({
				type: "hello",
				protocolVersion,
				buildId,
			}),
		);
	}

	get hello(): PtyHostHello {
		if (!this.identity)
			throw new PtyHostError({ message: "PTY host has not sent hello" });
		return this.identity;
	}

	get connected(): boolean {
		return !this.socket.destroyed && !this.socket.writableEnded;
	}

	private static async open(
		options: HostOptions,
		protocolVersion = PTY_HOST_PROTOCOL_VERSION,
	): Promise<PtyHostClient> {
		const client = new PtyHostClient(
			createConnection(
				ptyHostSocketPath(options.configDir ?? DEFAULT_CONFIG_DIR),
			),
			options.buildId ?? BUILD_ID,
			options.log,
			protocolVersion,
		);
		await client.ready;
		return client;
	}

	static async connect(options: HostOptions = {}): Promise<PtyHostClient> {
		const configDir = resolve(options.configDir ?? DEFAULT_CONFIG_DIR);
		const connect = async (
			start = options.start !== false,
		): Promise<PtyHostClient> => {
			try {
				return await PtyHostClient.open({ ...options, configDir });
			} catch (error) {
				if (!start || !isPtyHostUnavailable(error)) throw error;
			}
			let candidate = spawnHost(configDir);
			const deadline = Date.now() + 5000;
			for (;;) {
				await new Promise<void>((done) => setTimeout(done, 25));
				if (candidate.cancelled)
					throw new PtyHostError({
						message: "PTY host startup was explicitly stopped",
					});
				try {
					const client = await PtyHostClient.open({ ...options, configDir });
					if (candidate.child.pid !== client.hello.pid) {
						try {
							// A losing candidate must retire while the winner is still
							// reachable, before a later teardown can release its lock.
							await waitForOwnedHosts([candidate], deadline - Date.now());
						} catch (error) {
							client.disconnect();
							throw error;
						}
					}
					if (candidate.cancelled) {
						client.disconnect();
						throw new PtyHostError({
							message: "PTY host startup was explicitly stopped",
						});
					}
					return client;
				} catch (error) {
					if (!isPtyHostUnavailable(error)) throw error;
					if (Date.now() >= deadline)
						throw new PtyHostError({
							message: `PTY host did not start; see ${join(configDir, "pty-host.log")}`,
							cause: error,
						});
					if (candidate.finished) {
						// A contender may have found an owner just as it was retiring.
						candidate = spawnHost(configDir);
					}
				}
			}
		};
		let client = await connect();
		const buildId = options.buildId ?? BUILD_ID;
		if (client.hello.buildId !== buildId && client.hello.openTerminals === 0) {
			let stopped: boolean;
			try {
				stopped = await client.requestStop(false);
			} catch (error) {
				// Another server can win the idle upgrade and close our connection.
				if (client.connected && !isPtyHostUnavailable(error)) throw error;
				stopped = true;
			}
			if (stopped) client = await connect(true);
		}
		if (client.hello.buildId !== buildId)
			options.log?.warn(
				`PTY host build mismatch: server=${buildId}, host=${client.hello.buildId}; keeping compatible host pid=${client.hello.pid} with ${client.hello.openTerminals} open terminals`,
			);
		return client;
	}

	send(message: PtyHostRequest): void {
		writePtyFrame(this.socket, message);
	}
	forget(ptyId: string): void {
		this.sessions.delete(ptyId);
	}

	private request(
		message: RequestBody<PtyHostRequest>,
	): Promise<PtyHostMessage> {
		const requestId = ++this.nextRequestId;
		return new Promise<PtyHostMessage>((done, fail) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				fail(new Error(`PTY host ${message.type} timed out`));
			}, 5000);
			this.pending.set(requestId, {
				resolve: (reply) => {
					clearTimeout(timer);
					this.pending.delete(requestId);
					done(reply);
				},
				reject: (error) => {
					clearTimeout(timer);
					this.pending.delete(requestId);
					fail(error);
				},
			});
			try {
				this.send({ ...message, requestId });
			} catch (error) {
				this.pending
					.get(requestId)
					?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async list(
		cwd: string,
	): Promise<Array<{ pty: PtyInfo; exitCode: number | null }>> {
		const reply = await this.request({ type: "list", cwd: resolve(cwd) });
		if (reply.type !== "list")
			throw new PtyHostError({ message: "Unexpected PTY host list response" });
		return [...reply.terminals];
	}

	async create(options: {
		cwd: string;
		cols?: number | undefined;
		rows?: number | undefined;
		shell?: string;
		env?: Record<string, string>;
	}): Promise<HostedPtySession> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(options.env ?? process.env))
			if (value !== undefined) env[key] = value;
		const reply = await this.request({
			type: "create",
			cwd: resolve(options.cwd),
			cols: options.cols ?? 80,
			rows: options.rows ?? 24,
			shell:
				options.shell ??
				process.env["SHELL"] ??
				(process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
			env,
		});
		if (reply.type !== "created")
			throw new PtyHostError({
				message: "Unexpected PTY host create response",
			});
		return this.attach(reply.pty.id, options.cwd);
	}

	async attach(ptyId: string, cwd: string): Promise<HostedPtySession> {
		const reply = await this.request({
			type: "attach",
			id: ptyId,
			cwd: resolve(cwd),
		});
		const session = this.sessions.get(ptyId);
		if (reply.type !== "attached" || !session)
			throw new PtyHostError({
				message: "Unexpected PTY host attach response",
			});
		return session;
	}

	private async requestStop(force: boolean): Promise<boolean> {
		const reply = await this.request({ type: "stop", force });
		if (reply.type !== "stopped")
			throw new PtyHostError({ message: "Unexpected PTY host stop response" });
		if (reply.stopped) {
			this.intentionalDisconnect = true;
			await new Promise<void>((done, fail) => {
				const timer = setTimeout(
					() =>
						fail(
							new PtyHostError({
								message: "PTY host acknowledged stop but did not disconnect",
							}),
						),
					2000,
				);
				this.closed.then(() => {
					clearTimeout(timer);
					done();
				});
			});
		}
		return reply.stopped;
	}

	disconnect(): void {
		this.intentionalDisconnect = true;
		this.sessions.clear();
		// Flush queued input/close/detach frames before releasing the socket.
		this.socket.end();
	}

	static async stop(
		options: { configDir?: string; force?: boolean } = {},
	): Promise<boolean> {
		const hosts = [
			...(ownedHosts.get(
				ptyHostConfigPath(options.configDir ?? DEFAULT_CONFIG_DIR),
			) ?? []),
		];
		if (options.force && hosts.length > 0) {
			// These handles are children this process spawned for this exact config.
			// Never signal a PID reported by the protocol or a diagnostic PID file.
			for (const host of hosts) {
				host.cancelled = true;
				host.child.kill("SIGTERM");
			}
			await waitForOwnedHosts(hosts);
		}
		let client: PtyHostClient;
		try {
			client = await PtyHostClient.open(options);
		} catch (error) {
			if (isPtyHostUnavailable(error))
				return options.force === true && hosts.length > 0;
			if (!options.force || !(error instanceof PtyHostProtocolMismatch))
				throw error;
			// Explicit control may negotiate once using the stable hello/stop envelope.
			// This connection never escapes as a terminal client and never signals PID.
			client = await PtyHostClient.open(options, error.protocolVersion);
		}
		try {
			const stopped = await client.requestStop(options.force ?? false);
			if (stopped)
				await waitForOwnedHosts(
					hosts.filter(({ child }) => child.pid === client.hello.pid),
				);
			return stopped;
		} finally {
			client.disconnect();
		}
	}
}

export const stopPtyHost = (
	options: { configDir?: string; force?: boolean } = {},
): Promise<boolean> => PtyHostClient.stop(options);

export async function restartPtyHost(
	options: { configDir?: string; buildId?: string } = {},
): Promise<PtyHostClient> {
	await stopPtyHost({ ...options, force: true });
	return PtyHostClient.connect(options);
}
