import { Context, Data, Effect, Layer, Option } from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import type { PtyEvent, PtyRow } from "../../../contracts/ws-rpc.js";
import { DEFAULT_CONFIG_DIR } from "../../../env.js";
import { formatErrorDetail } from "../../../errors.js";
import {
	type PtyUpstream,
	trackedPtyInfo,
} from "../../../relay/pty-manager.js";
import type { PtyInfo, PtyStatus } from "../../../shared-types.js";
import {
	isPtyHostUnavailable,
	PtyHostClient,
} from "../../../terminal/pty-host-client.js";
import { PtyHostError } from "../../../terminal/pty-host-protocol.js";
import { isRecord } from "../../../utils.js";
import {
	type OpenCodeClient,
	OpenCodeInstancesTag,
} from "../../daemon/Services/opencode-instances-service.js";
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
	create(clientId: string): Effect.Effect<void, TerminalServiceError>;
	/** Restore hosted PTYs, discover OpenCode's, and re-attach running ones. */
	list(): Effect.Effect<PtyInfo[], TerminalServiceError>;
	/** Every tracked PTY with its scrollback. Synchronous, so a subscriber can
	 *  read it in the same turn it subscribes and miss nothing in between. */
	snapshot(): PtyRow[];
	subscribe(listener: (event: PtyEvent) => void): () => void;
	sendInput(
		ptyId: string,
		data: string,
	): Effect.Effect<void, TerminalServiceError>;
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

export const OpenCodeTerminalServiceLive: Layer.Layer<
	OpenCodeTerminalServiceTag,
	never,
	| OpenCodeInstancesTag
	| WebSocketHandlerTag
	| LoggerTag
	| ConfigTag
	| PtyManagerTag
	| ConnectPtyUpstreamTag
	| LocalPtyServiceTag
> = Layer.effect(
	OpenCodeTerminalServiceTag,
	Effect.gen(function* () {
		const instances = yield* OpenCodeInstancesTag;
		const openCodeId = defaultInstanceIdForDriver("opencode");
		const callOpenCodePty = (
			operation: TerminalOperation,
			ptyId: string,
			call: (pty: OpenCodeClient["pty"]) => Promise<unknown>,
		) =>
			instances.use(openCodeId).pipe(
				Effect.flatMap((client) =>
					Effect.tryPromise({
						try: () => call(client.pty),
						catch: (cause) => cause,
					}),
				),
				Effect.mapError(
					(cause) => new TerminalServiceError({ operation, ptyId, cause }),
				),
				Effect.scoped,
			);
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;
		const ptyManager = yield* PtyManagerTag;
		const connectPtyUpstream = yield* ConnectPtyUpstreamTag;
		const localPty = yield* LocalPtyServiceTag;
		const terminalLock = yield* Effect.makeSemaphore(1);
		const trackedPtys = () =>
			ptyManager
				.listSessions()
				.map((pty) =>
					trackedPtyInfo(
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
			const current = () =>
				ptyManager.getSession(pty.id)?.upstream === upstream;
			ptyManager.registerSession(pty.id, upstream, "local", pty);
			if (!restoring) ptyManager.publish({ _tag: "upsert", item: pty });
			// A re-attached host replays its scrollback synchronously on `onData`;
			// that replay rebuilds the ring and is announced once, below.
			let replaying = restoring;
			session.onData((data) => {
				if (!current()) return;
				ptyManager.appendScrollback(pty.id, data);
				if (!replaying)
					ptyManager.publish({ _tag: "output", ptyId: pty.id, data });
			});
			session.onExit((exitCode) => {
				if (!current()) return;
				ptyManager.markExited(pty.id, exitCode);
				if (!replaying)
					ptyManager.publish({
						_tag: "upsert",
						item: { ...pty, status: "exited" },
					});
			});
			session.onDisconnect?.(() => {
				if (!current()) return;
				// The connection is unavailable; only host discovery can establish
				// whether this shell survived. Keep the proxy attachable (state 0).
				ptyManager.markExited(pty.id, -1);
				ptyManager.publish({
					_tag: "upsert",
					item: { ...pty, status: "exited" },
				});
			});
			replaying = false;
			if (!restoring) return;
			const exited = ptyManager.getSession(pty.id)?.exited === true;
			ptyManager.publish({
				_tag: "upsert",
				item: { ...pty, status: exited ? "exited" : "running" },
			});
			ptyManager.publish({
				_tag: "output",
				ptyId: pty.id,
				data: ptyManager.getScrollback(pty.id),
				replace: true,
			});
		};
		const restoreLocalSessions = Effect.gen(function* () {
			const hosted = yield* localPty.list(config.projectDir);
			const hostedIds = new Set(hosted.map(({ id }) => id));
			for (const { id } of ptyManager.listSessions()) {
				if (ptyManager.getSession(id)?.source !== "local" || hostedIds.has(id))
					continue;
				ptyManager.closeSession(id);
				ptyManager.publish({ _tag: "remove", id });
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
						return yield* createResult.left;
					}

					const { pty } = createResult.right;
					log.info(
						`client=${clientId} session=${session} Created: ${pty.id} (pid=${pty.pid})`,
					);
					registerLocalSession(createResult.right, false);
				}).pipe(terminalLock.withPermits(1)),
			list: () =>
				Effect.gen(function* () {
					yield* restoreLocalSessions;
					// Discovery never forces OpenCode: no running instance, no PTYs.
					const rawPtysResult = yield* Effect.either(
						instances.ifRunning(openCodeId).pipe(
							Effect.flatMap(
								Option.match({
									onNone: () => Effect.succeed([]),
									onSome: (client) =>
										Effect.tryPromise({
											try: () => client.pty.list(),
											catch: (cause) =>
												new TerminalServiceError({ operation: "list", cause }),
										}),
								}),
							),
							Effect.scoped,
						),
					);
					const ptys: PtyInfo[] = trackedPtys();
					if (rawPtysResult._tag === "Left") {
						log.debug(
							`OpenCode PTY list unavailable: ${formatErrorDetail(rawPtysResult.left.cause)}`,
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
									`List returned PTY with no id: ${JSON.stringify(ptyResult.raw)}`,
								);
							}
						}
					}
					for (const pty of ptys) {
						const ptyId = pty.id;
						if (!ptyManager.hasSession(ptyId) && pty.status === "running") {
							const reconnectResult = yield* Effect.either(
								connectPtyUpstream(ptyId, -1).pipe(
									Effect.mapError(
										(cause) =>
											new TerminalServiceError({
												operation: "connect",
												ptyId,
												cause,
											}),
									),
								),
							);
							if (reconnectResult._tag === "Right") {
								log.info(`Reconnected upstream WS: ${ptyId}`);
							} else {
								log.warn(
									`Failed to reconnect upstream: ${ptyId}: ${formatErrorDetail(reconnectResult.left.cause)}`,
								);
							}
						}
					}
					return ptys;
				}),
			snapshot: () =>
				trackedPtys().map((pty) => ({
					pty,
					scrollback: ptyManager.getScrollback(pty.id),
				})),
			subscribe: (listener) => ptyManager.subscribe(listener),
			sendInput: (ptyId: string, data: string) =>
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
					Effect.tapError((error) =>
						Effect.sync(() =>
							log.warn(
								`PTY input failed ${ptyId}: ${formatErrorDetail(error.cause)}`,
							),
						),
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
					if (!local) {
						yield* callOpenCodePty("delete", ptyId, (pty) => pty.delete(ptyId));
					}
					ptyManager.publish({ _tag: "remove", id: ptyId });
				}).pipe(terminalLock.withPermits(1)),
			resize: (clientId: string, ptyId: string, rows: number, cols: number) =>
				Effect.gen(function* () {
					const session = ptyManager.getSession(ptyId);
					if (session?.source === "local") {
						session.upstream.resize?.(cols, rows);
						return;
					}
					const resizeResult = yield* Effect.either(
						callOpenCodePty("resize", ptyId, (pty) =>
							pty.resize(ptyId, rows, cols),
						),
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
