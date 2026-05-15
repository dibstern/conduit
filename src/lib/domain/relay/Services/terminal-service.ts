import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import * as nodePty from "node-pty";
import { formatErrorDetail, RelayError } from "../../../errors.js";
import type { PtyUpstream } from "../../../relay/pty-manager.js";
import type { PtyInfo, PtyStatus } from "../../../shared-types.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	ConfigTag,
	ConnectPtyUpstreamTag,
	LoggerTag,
	PtyManagerTag,
	WebSocketHandlerTag,
} from "./services.js";

type TerminalOperation = "create" | "connect" | "list" | "delete" | "resize";
const PTY_OPEN = 1;
const PTY_CLOSED = 3;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const requireFromHere = createRequire(import.meta.url);

export class TerminalServiceError extends Data.TaggedError(
	"TerminalServiceError",
)<{
	readonly operation: TerminalOperation;
	readonly ptyId?: string | undefined;
	readonly cause: unknown;
}> {}

export interface OpenCodeTerminalService {
	create(clientId: string): Effect.Effect<void>;
	list(clientId: string): Effect.Effect<PtyInfo[], TerminalServiceError>;
	replay(clientId: string): Effect.Effect<void>;
	sendInput(ptyId: string, data: string): Effect.Effect<void>;
	close(ptyId: string): Effect.Effect<void, TerminalServiceError>;
	resize(
		clientId: string,
		ptyId: string,
		rows: number,
		cols: number,
	): Effect.Effect<void>;
}

export class OpenCodeTerminalServiceTag extends Context.Tag(
	"OpenCodeTerminalService",
)<OpenCodeTerminalServiceTag, OpenCodeTerminalService>() {}

export interface LocalPtySession {
	readonly pty: PtyInfo;
	readonly upstream: PtyUpstream;
	onData(handler: (data: string) => void): void;
	onExit(handler: (exitCode: number) => void): void;
}

export interface LocalPtyService {
	create(options: {
		readonly cwd: string;
		readonly cols?: number | undefined;
		readonly rows?: number | undefined;
	}): Effect.Effect<LocalPtySession, TerminalServiceError>;
}

export class LocalPtyServiceTag extends Context.Tag("LocalPtyService")<
	LocalPtyServiceTag,
	LocalPtyService
>() {}

const getDefaultShell = (): string => {
	if (process.platform === "win32") {
		return process.env["COMSPEC"] ?? "powershell.exe";
	}
	return process.env["SHELL"] ?? "/bin/zsh";
};

const toPtyWriteData = (
	data: string | Buffer | ArrayBuffer,
): string | Buffer => {
	if (typeof data === "string" || Buffer.isBuffer(data)) return data;
	return Buffer.from(data);
};

const getPtyEnv = (): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value != null) env[key] = value;
	}
	return env;
};

const ensureNodePtySpawnHelperExecutable = (): void => {
	if (process.platform !== "darwin") return;
	const nodePtyRoot = path.resolve(
		path.dirname(requireFromHere.resolve("node-pty")),
		"..",
	);
	for (const helperPath of [
		path.join(
			nodePtyRoot,
			"prebuilds",
			`${process.platform}-${process.arch}`,
			"spawn-helper",
		),
		path.join(nodePtyRoot, "build", "Release", "spawn-helper"),
	]) {
		if (!fs.existsSync(helperPath)) continue;
		const mode = fs.statSync(helperPath).mode;
		if ((mode & 0o111) === 0) {
			fs.chmodSync(helperPath, mode | 0o755);
		}
	}
};

export const LocalPtyServiceLive: Layer.Layer<LocalPtyServiceTag> =
	Layer.succeed(LocalPtyServiceTag, {
		create: ({ cwd, cols = DEFAULT_COLS, rows = DEFAULT_ROWS }) =>
			Effect.try({
				try: () => {
					ensureNodePtySpawnHelperExecutable();
					const shell = getDefaultShell();
					const id = `local-pty-${randomUUID()}`;
					const ptyProcess = nodePty.spawn(shell, [], {
						name: "xterm-256color",
						cols,
						rows,
						cwd,
						env: {
							...getPtyEnv(),
							COLORTERM: "truecolor",
							CONDUIT: "1",
							TERM: process.env["TERM"] ?? "xterm-256color",
						},
					});
					let readyState = PTY_OPEN;
					const close = () => {
						if (readyState !== PTY_OPEN) return;
						readyState = PTY_CLOSED;
						ptyProcess.kill();
					};
					const upstream: PtyUpstream = {
						get readyState() {
							return readyState;
						},
						send: (data, cb) => {
							try {
								ptyProcess.write(toPtyWriteData(data));
								cb?.();
							} catch (err) {
								cb?.(err instanceof Error ? err : new Error(String(err)));
							}
						},
						close,
						terminate: close,
						resize: (nextCols, nextRows) => {
							ptyProcess.resize(nextCols, nextRows);
						},
					};
					return {
						pty: {
							id,
							title: "Terminal",
							command: path.basename(shell),
							cwd,
							status: "running",
							pid: ptyProcess.pid,
						},
						upstream,
						onData: (handler) => {
							ptyProcess.onData(handler);
						},
						onExit: (handler) => {
							ptyProcess.onExit(({ exitCode }) => {
								readyState = PTY_CLOSED;
								handler(exitCode);
							});
						},
					};
				},
				catch: (cause) =>
					new TerminalServiceError({ operation: "create", cause }),
			}),
	});

type PtyInfoResult =
	| { readonly _tag: "MissingId"; readonly raw: Record<string, unknown> }
	| {
			readonly _tag: "Created";
			readonly pty: PtyInfo;
	  };

const toPtyInfo = (
	rawResult: { readonly [key: string]: unknown },
	projectDir: string,
): PtyInfoResult => {
	const ptyId = String(rawResult["id"] ?? "");
	if (!ptyId) {
		return { _tag: "MissingId", raw: rawResult };
	}
	return {
		_tag: "Created",
		pty: {
			id: ptyId,
			title: String(rawResult["title"] ?? "Terminal"),
			command: String(rawResult["command"] ?? "bash"),
			cwd: String(rawResult["cwd"] ?? projectDir),
			status: (rawResult["status"] === "exited"
				? "exited"
				: "running") satisfies PtyStatus,
			pid: Number(rawResult["pid"] ?? 0),
		},
	};
};

const toTrackedPtyInfo = (
	pty: { readonly id: string; readonly status: PtyStatus },
	projectDir: string,
): PtyInfo => ({
	id: pty.id,
	title: "Terminal",
	command: "bash",
	cwd: projectDir,
	status: pty.status,
	pid: 0,
});

export const OpenCodeTerminalServiceLive: Layer.Layer<
	OpenCodeTerminalServiceTag,
	never,
	| OpenCodeAPITag
	| WebSocketHandlerTag
	| LoggerTag
	| ConfigTag
	| PtyManagerTag
	| ConnectPtyUpstreamTag
	| LocalPtyServiceTag
> = Layer.effect(
	OpenCodeTerminalServiceTag,
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;
		const ptyManager = yield* PtyManagerTag;
		const connectPtyUpstream = yield* ConnectPtyUpstreamTag;
		const localPty = yield* LocalPtyServiceTag;

		return {
			create: (clientId: string) =>
				Effect.gen(function* () {
					const session = wsHandler.getClientSession(clientId) ?? "?";
					const createResult = yield* Effect.either(
						localPty.create({ cwd: config.projectDir }),
					);
					if (createResult._tag === "Left") {
						log.warn(
							`client=${clientId} session=${session} Failed to create PTY: ${formatErrorDetail(createResult.left.cause)}`,
						);
						wsHandler.sendTo(
							clientId,
							RelayError.fromCaught(
								createResult.left.cause,
								"PTY_CREATE_FAILED",
								"Failed to create terminal",
							).toSystemError(),
						);
						return;
					}

					const { pty, upstream } = createResult.right;
					ptyManager.registerSession(pty.id, upstream, "local");
					createResult.right.onData((data) => {
						ptyManager.appendScrollback(pty.id, data);
						wsHandler.broadcast({ type: "pty_output", ptyId: pty.id, data });
					});
					createResult.right.onExit((exitCode) => {
						ptyManager.markExited(pty.id, exitCode);
						if (ptyManager.hasSession(pty.id)) {
							wsHandler.broadcast({
								type: "pty_exited",
								ptyId: pty.id,
								exitCode,
							});
						}
					});
					log.info(
						`client=${clientId} session=${session} Created: ${pty.id} (pid=${pty.pid})`,
					);
					wsHandler.broadcast({ type: "pty_created", pty });
				}),
			list: (clientId: string) =>
				Effect.gen(function* () {
					const session = wsHandler.getClientSession(clientId) ?? "?";
					const rawPtysResult = yield* Effect.either(
						Effect.tryPromise({
							try: () => client.pty.list(),
							catch: (cause) =>
								new TerminalServiceError({ operation: "list", cause }),
						}),
					);
					const ptys: PtyInfo[] = ptyManager
						.listSessions()
						.map((pty) => toTrackedPtyInfo(pty, config.projectDir));
					if (rawPtysResult._tag === "Left") {
						log.debug(
							`client=${clientId} session=${session} OpenCode PTY list unavailable: ${formatErrorDetail(rawPtysResult.left.cause)}`,
						);
					} else {
						const rawPtys = rawPtysResult.right;
						for (const rawPty of rawPtys) {
							const ptyResult = toPtyInfo(rawPty, config.projectDir);
							if (ptyResult._tag === "Created") {
								if (!ptyManager.hasSession(ptyResult.pty.id)) {
									ptys.push(ptyResult.pty);
								}
							} else {
								log.warn(
									`client=${clientId} session=${session} List returned PTY with no id: ${JSON.stringify(ptyResult.raw)}`,
								);
							}
						}
					}
					wsHandler.sendTo(clientId, {
						type: "pty_list",
						ptys,
					});
					for (const pty of ptys) {
						const ptyId = pty.id;
						if (!ptyManager.hasSession(ptyId) && pty.status === "running") {
							const reconnectResult = yield* Effect.either(
								Effect.tryPromise({
									try: () => connectPtyUpstream(ptyId, -1),
									catch: (cause) =>
										new TerminalServiceError({
											operation: "connect",
											ptyId,
											cause,
										}),
								}),
							);
							if (reconnectResult._tag === "Right") {
								log.info(
									`client=${clientId} session=${session} Reconnected upstream WS: ${ptyId}`,
								);
							} else {
								log.warn(
									`client=${clientId} session=${session} Failed to reconnect upstream: ${ptyId}: ${formatErrorDetail(reconnectResult.left.cause)}`,
								);
							}
						}
					}
					return ptys;
				}),
			replay: (clientId: string) =>
				Effect.sync(() => {
					if (ptyManager.sessionCount === 0) return;
					const ptys = ptyManager
						.listSessions()
						.map((pty) => toTrackedPtyInfo(pty, config.projectDir));
					wsHandler.sendTo(clientId, {
						type: "pty_list",
						ptys,
					});
					for (const { id: ptyId } of ptys) {
						const scrollback = ptyManager.getScrollback(ptyId);
						if (scrollback) {
							wsHandler.sendTo(clientId, {
								type: "pty_output",
								ptyId,
								data: scrollback,
							});
						}
						const session = ptyManager.getSession(ptyId);
						if (session?.exited) {
							wsHandler.sendTo(clientId, {
								type: "pty_exited",
								ptyId,
								exitCode: session.exitCode ?? 0,
							});
						}
					}
				}),
			sendInput: (ptyId: string, data: string) =>
				Effect.sync(() => {
					ptyManager.sendInput(ptyId, data);
				}),
			close: (ptyId: string) =>
				Effect.gen(function* () {
					const session = ptyManager.getSession(ptyId);
					ptyManager.closeSession(ptyId);
					if (session?.source !== "local") {
						yield* Effect.tryPromise({
							try: () => client.pty.delete(ptyId),
							catch: (cause) =>
								new TerminalServiceError({
									operation: "delete",
									ptyId,
									cause,
								}),
						});
					}
					wsHandler.broadcast({ type: "pty_deleted", ptyId });
				}),
			resize: (clientId: string, ptyId: string, rows: number, cols: number) =>
				Effect.gen(function* () {
					const session = ptyManager.getSession(ptyId);
					if (session?.source === "local") {
						session.upstream.resize?.(cols, rows);
						return;
					}
					const resizeResult = yield* Effect.either(
						Effect.tryPromise({
							try: () => client.pty.resize(ptyId, rows, cols),
							catch: (cause) =>
								new TerminalServiceError({
									operation: "resize",
									ptyId,
									cause,
								}),
						}),
					);
					if (resizeResult._tag === "Left") {
						log.warn(
							`client=${clientId} session=${wsHandler.getClientSession(clientId) ?? "?"} Resize failed ${ptyId}: ${formatErrorDetail(resizeResult.left.cause)}`,
						);
					}
				}),
		};
	}),
);
