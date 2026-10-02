import { Context, Data, Effect, Layer } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../../env.js";
import { formatErrorDetail, RelayError } from "../../../errors.js";
import type { PtyUpstream } from "../../../relay/pty-manager.js";
import type { PtyInfo, PtyStatus } from "../../../shared-types.js";
import {
	isPtyHostUnavailable,
	PtyHostClient,
} from "../../../terminal/pty-host-client.js";
import { PtyHostError } from "../../../terminal/pty-host-protocol.js";
import { isRecord } from "../../../utils.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	ConfigTag,
	ConnectPtyUpstreamTag,
	LoggerTag,
	PtyManagerTag,
	WebSocketHandlerTag,
} from "./services.js";

type TerminalOperation =
	| "create"
	| "connect"
	| "list"
	| "delete"
	| "resize"
	| "input";

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
	replay(clientId: string): Effect.Effect<void, TerminalServiceError>;
	sendInput(
		ptyId: string,
		data: string,
		clientId?: string,
	): Effect.Effect<void>;
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
	onDisconnect?(handler: () => void): void;
}

export interface LocalPtyService {
	list(
		cwd: string,
	): Effect.Effect<ReadonlyArray<PtyInfo>, TerminalServiceError>;
	attach(
		ptyId: string,
		cwd: string,
	): Effect.Effect<LocalPtySession, TerminalServiceError>;
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

export const LocalPtyServiceLive: Layer.Layer<
	LocalPtyServiceTag,
	never,
	ConfigTag | LoggerTag
> = Layer.scoped(
	LocalPtyServiceTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		let active: PtyHostClient | undefined;
		let connecting: Promise<PtyHostClient> | undefined;
		let disposed = false;
		const connect = async (start: boolean): Promise<PtyHostClient> => {
			if (disposed) throw new PtyHostError({ message: "PTY service disposed" });
			if (active?.connected) return active;
			if (connecting) {
				try {
					return await connecting;
				} catch (error) {
					if (!start || !isPtyHostUnavailable(error)) throw error;
					return connect(true);
				}
			}
			connecting = PtyHostClient.connect({
				configDir: config.configDir ?? DEFAULT_CONFIG_DIR,
				start,
				log,
			})
				.then((client) => {
					if (disposed) {
						client.disconnect();
						throw new PtyHostError({ message: "PTY service disposed" });
					}
					active = client;
					return client;
				})
				.finally(() => {
					connecting = undefined;
				});
			return connecting;
		};
		yield* Effect.addFinalizer(() =>
			Effect.promise(async () => {
				disposed = true;
				active?.disconnect();
				await connecting?.catch(() => undefined);
			}),
		);
		return {
			create: (options) =>
				Effect.tryPromise({
					try: async () => (await connect(true)).create(options),
					catch: (cause) =>
						new TerminalServiceError({ operation: "create", cause }),
				}),
			list: (cwd) =>
				Effect.tryPromise({
					try: async () => {
						let host: PtyHostClient;
						try {
							host = await connect(false);
						} catch (error) {
							if (
								isRecord(error) &&
								["ENOENT", "ECONNREFUSED"].includes(String(error["code"]))
							)
								return [];
							throw error;
						}
						// A failed exchange is not an authoritative empty terminal list.
						return (await host.list(cwd)).map(({ pty }) => pty);
					},
					catch: (cause) =>
						new TerminalServiceError({ operation: "list", cause }),
				}),
			attach: (ptyId, cwd) =>
				Effect.tryPromise({
					try: async () => (await connect(false)).attach(ptyId, cwd),
					catch: (cause) =>
						new TerminalServiceError({ operation: "connect", ptyId, cause }),
				}),
		} satisfies LocalPtyService;
	}),
);

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
	info?: PtyInfo,
): PtyInfo => ({
	id: pty.id,
	title: "Terminal",
	command: "bash",
	cwd: projectDir,
	pid: 0,
	...info,
	status: pty.status,
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
		const terminalLock = yield* Effect.makeSemaphore(1);
		const readyTerminals = new Map<string, Set<string>>();
		const clientTerminals = (clientId: string): Set<string> => {
			let ready = readyTerminals.get(clientId);
			if (!ready) {
				ready = new Set();
				readyTerminals.set(clientId, ready);
			}
			return ready;
		};
		wsHandler.on("client_connected", ({ clientId }) => {
			// A reconnect can reuse the same client ID but needs a fresh replay.
			readyTerminals.set(clientId, new Set());
		});
		wsHandler.on("client_disconnected", ({ clientId }) => {
			readyTerminals.delete(clientId);
		});
		const trackedPtys = () =>
			ptyManager
				.listSessions()
				.map((pty) =>
					toTrackedPtyInfo(
						pty,
						config.projectDir,
						ptyManager.getSession(pty.id)?.info,
					),
				);
		const registerLocalSession = (
			session: LocalPtySession,
			restoring: boolean,
		): void => {
			const { pty, upstream } = session;
			const affectedClients: string[] = [];
			if (restoring) {
				for (const [clientId, ready] of readyTerminals) {
					if (ready.delete(pty.id)) affectedClients.push(clientId);
				}
			}
			ptyManager.registerSession(pty.id, upstream, "local", pty);
			if (!restoring) {
				wsHandler.broadcast({ type: "pty_created", pty });
				for (const clientId of wsHandler.getClientIds())
					clientTerminals(clientId).add(pty.id);
			}
			let replaying = restoring;
			session.onData((data) => {
				if (ptyManager.getSession(pty.id)?.upstream !== upstream) return;
				ptyManager.appendScrollback(pty.id, data);
				if (replaying) return;
				for (const [clientId, ready] of readyTerminals) {
					if (ready.has(pty.id))
						wsHandler.sendTo(clientId, {
							type: "pty_output",
							ptyId: pty.id,
							data,
						});
				}
			});
			session.onExit((exitCode) => {
				if (ptyManager.getSession(pty.id)?.upstream !== upstream) return;
				ptyManager.markExited(pty.id, exitCode);
				if (replaying || !ptyManager.hasSession(pty.id)) return;
				for (const [clientId, ready] of readyTerminals) {
					if (ready.has(pty.id))
						wsHandler.sendTo(clientId, {
							type: "pty_exited",
							ptyId: pty.id,
							exitCode,
						});
				}
			});
			session.onDisconnect?.(() => {
				if (ptyManager.getSession(pty.id)?.upstream !== upstream) return;
				// The connection is unavailable; only host discovery can establish
				// whether this shell survived. Keep the proxy attachable (state 0).
				ptyManager.markExited(pty.id, -1);
				wsHandler.broadcast({
					type: "pty_exited",
					ptyId: pty.id,
					exitCode: -1,
				});
			});
			replaying = false;
			for (const clientId of affectedClients) {
				wsHandler.sendTo(clientId, { type: "pty_list", ptys: trackedPtys() });
				replayScrollback(clientId, [pty]);
			}
		};
		const replayScrollback = (clientId: string, ptys: PtyInfo[]): void => {
			const ready = clientTerminals(clientId);
			for (const { id: ptyId } of ptys) {
				const session = ptyManager.getSession(ptyId);
				if (session?.source === "local" && ready.has(ptyId)) continue;
				const data = ptyManager.getScrollback(ptyId);
				wsHandler.sendTo(clientId, {
					type: "pty_output",
					ptyId,
					data,
					replace: true,
					...(session?.source === "local" &&
						!session.exited &&
						session.upstream.readyState === 1 && { restored: true }),
				});
				if (session?.exited) {
					wsHandler.sendTo(clientId, {
						type: "pty_exited",
						ptyId,
						exitCode: session.exitCode ?? 0,
					});
				}
				// Snapshot delivery and live subscription share the same synchronous turn.
				if (session?.source === "local") ready.add(ptyId);
			}
		};
		const restoreLocalSessions = Effect.gen(function* () {
			const hosted = yield* localPty.list(config.projectDir);
			const hostedIds = new Set(hosted.map(({ id }) => id));
			for (const { id } of ptyManager.listSessions()) {
				if (ptyManager.getSession(id)?.source !== "local" || hostedIds.has(id))
					continue;
				ptyManager.closeSession(id);
				for (const ready of readyTerminals.values()) ready.delete(id);
				wsHandler.broadcast({ type: "pty_deleted", ptyId: id });
			}
			for (const { id } of hosted) {
				const existing = ptyManager.getSession(id);
				if (existing && existing.upstream.readyState !== 0) continue;
				const session = yield* localPty.attach(id, config.projectDir);
				registerLocalSession(session, true);
			}
		}).pipe(terminalLock.withPermits(1));

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

					const { pty } = createResult.right;
					log.info(
						`client=${clientId} session=${session} Created: ${pty.id} (pid=${pty.pid})`,
					);
					registerLocalSession(createResult.right, false);
				}).pipe(terminalLock.withPermits(1)),
			list: (clientId: string) =>
				Effect.gen(function* () {
					const ready = clientTerminals(clientId);
					const session = wsHandler.getClientSession(clientId) ?? "?";
					yield* restoreLocalSessions;
					const rawPtysResult = yield* Effect.either(
						Effect.tryPromise({
							try: () => client.pty.list(),
							catch: (cause) =>
								new TerminalServiceError({ operation: "list", cause }),
						}),
					);
					const ptys: PtyInfo[] = trackedPtys();
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
					if (readyTerminals.get(clientId) !== ready) return ptys;
					wsHandler.sendTo(clientId, {
						type: "pty_list",
						ptys,
					});
					replayScrollback(
						clientId,
						ptys.filter(
							(pty) => ptyManager.getSession(pty.id)?.source === "local",
						),
					);
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
				Effect.gen(function* () {
					const ready = clientTerminals(clientId);
					yield* restoreLocalSessions;
					if (
						ptyManager.sessionCount === 0 ||
						readyTerminals.get(clientId) !== ready
					)
						return;
					const ptys = trackedPtys();
					wsHandler.sendTo(clientId, {
						type: "pty_list",
						ptys,
					});
					replayScrollback(clientId, ptys);
				}),
			sendInput: (ptyId: string, data: string, clientId?: string) =>
				Effect.try({
					try: () => {
						const session = ptyManager.getSession(ptyId);
						if (!session || session.upstream.readyState !== 1)
							throw new PtyHostError({
								message: `Terminal unavailable: ${ptyId}`,
							});
						ptyManager.sendInput(ptyId, data);
					},
					catch: (cause) =>
						new TerminalServiceError({ operation: "input", ptyId, cause }),
				}).pipe(
					Effect.catchAll((error) =>
						Effect.sync(() => {
							log.warn(
								`PTY input failed ${ptyId}: ${formatErrorDetail(error.cause)}`,
							);
							if (clientId)
								wsHandler.sendTo(
									clientId,
									RelayError.fromCaught(
										error.cause,
										"PTY_INPUT_FAILED",
										"Terminal is unavailable; reconnect or create a new terminal",
									).toSystemError(),
								);
						}),
					),
				),
			close: (ptyId: string) =>
				Effect.gen(function* () {
					const session = ptyManager.getSession(ptyId);
					let local = session?.source === "local";
					if (!session || (local && session.upstream.readyState === 0)) {
						const hosted = yield* localPty.list(config.projectDir);
						if (hosted.some(({ id }) => id === ptyId)) {
							local = true;
							const restored = yield* localPty.attach(ptyId, config.projectDir);
							restored.upstream.close(1000, "Terminal closed");
						}
					}
					ptyManager.closeSession(ptyId);
					for (const ready of readyTerminals.values()) ready.delete(ptyId);
					if (!local) {
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
				}).pipe(terminalLock.withPermits(1)),
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
