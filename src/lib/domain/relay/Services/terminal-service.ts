import {
	Context,
	Data,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Queue,
	Schedule,
	Semaphore,
} from "effect";
import type { Account } from "../../../contracts/account.js";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/provider-instance.js";
import type { PtyEvent, PtyRow } from "../../../contracts/ws-rpc.js";
import * as Failure from "../../../effect/failure-classification.js";
import { DEFAULT_CONFIG_DIR } from "../../../env.js";
import { formatErrorDetail } from "../../../errors.js";
import { makeClaudeTerminalEnv } from "../../../provider/claude/claude-sdk-env.js";
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
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import {
	ConfigTag,
	ConnectPtyUpstreamTag,
	LoggerTag,
	PtyManagerTag,
	WebSocketHandlerTag,
} from "./services.js";
import { SessionWorkspaceTag } from "./session-workspace.js";

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
	create(
		clientId: string,
		cwd?: string,
		account?: Account,
	): Effect.Effect<void, TerminalServiceError>;
	/** Restore hosted PTYs, discover OpenCode's, and re-attach running ones. */
	list(): Effect.Effect<PtyInfo[], TerminalServiceError>;
	/** Every tracked PTY with its scrollback. Synchronous, so a subscriber can
	 *  read it in the same turn it subscribes and miss nothing in between. */
	snapshot(): PtyRow[];
	subscribe(listener: (event: PtyEvent) => void): () => void;
	/** Invalidate discovery; one relay-scoped worker reconciles the provider set. */
	onOpenCodePtysChanged(instanceId: string): void;
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

export class OpenCodeTerminalServiceTag extends Context.Service<
	OpenCodeTerminalServiceTag,
	OpenCodeTerminalService
>()("OpenCodeTerminalService") {}

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
		allProjects?: boolean,
	): Effect.Effect<ReadonlyArray<PtyInfo>, TerminalServiceError>;
	attach(
		ptyId: string,
		cwd: string,
	): Effect.Effect<LocalPtySession, TerminalServiceError>;
	create(options: {
		readonly cwd: string;
		readonly projectDir?: string;
		readonly cols?: number | undefined;
		readonly rows?: number | undefined;
		readonly env?: Readonly<Record<string, string | undefined>>;
	}): Effect.Effect<LocalPtySession, TerminalServiceError>;
}

export class LocalPtyServiceTag extends Context.Service<
	LocalPtyServiceTag,
	LocalPtyService
>()("LocalPtyService") {}

export const LocalPtyServiceLive: Layer.Layer<
	LocalPtyServiceTag,
	never,
	ConfigTag | LoggerTag
> = Layer.effect(
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
			list: (cwd, allProjects = false) =>
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
						return (await host.list(cwd, allProjects)).map(({ pty }) => pty);
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
		const openCodeId = MANAGED_OPENCODE_ACCOUNT_ID;
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
		const terminalLock = yield* Semaphore.make(1);
		const openCodeLock = yield* Semaphore.make(1);
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
				if (existing?.source === "local" && existing.upstream?.readyState !== 0)
					continue;
				const session = yield* localPty.attach(id, config.projectDir);
				registerLocalSession(session, true);
			}
		}).pipe(terminalLock.withPermits(1));

		const reconcile = Effect.gen(function* () {
			const client = yield* instances.useIfRunning(openCodeId);
			if (Option.isNone(client)) return false;
			yield* restoreLocalSessions;
			const discovered = yield* Effect.tryPromise({
				try: () => client.value.pty.list(),
				catch: (cause) =>
					new TerminalServiceError({ operation: "list", cause }),
			});
			const listedIds = new Set<string>();
			for (const raw of discovered) {
				const existing = ptyManager.getSession(String(raw["id"] ?? ""));
				const result = toPtyInfo(
					{ ...existing?.info, ...raw },
					config.projectDir,
				);
				if (result._tag === "MissingId") {
					log.warn(
						`List returned PTY with no id: ${JSON.stringify(result.raw)}`,
					);
					continue;
				}
				const pty = result.pty;
				listedIds.add(pty.id);
				if (existing?.source === "local") continue;
				const previous = existing?.info;
				const previousExited = existing?.exited;
				const session =
					existing ??
					ptyManager.registerSession(pty.id, undefined, "opencode", pty);
				session.exited = pty.status === "exited";
				session.exitCode = session.exited ? (session.exitCode ?? 0) : null;
				session.info = pty;
				if (
					!existing ||
					previousExited !== session.exited ||
					previous?.title !== pty.title ||
					previous?.command !== pty.command ||
					previous?.cwd !== pty.cwd ||
					previous?.pid !== pty.pid
				) {
					ptyManager.publish({ _tag: "upsert", item: pty });
				}
			}
			for (const { id } of ptyManager.listSessions()) {
				if (
					ptyManager.getSession(id)?.source === "opencode" &&
					!listedIds.has(id)
				) {
					ptyManager.closeSession(id);
					ptyManager.publish({ _tag: "remove", id });
				}
			}
			for (const pty of trackedPtys()) {
				const session = ptyManager.getSession(pty.id);
				if (
					session?.source === "opencode" &&
					pty.status === "running" &&
					(!session.upstream || session.upstream.readyState === 3)
				) {
					yield* connectPtyUpstream(pty.id, -1).pipe(
						Effect.catch((cause) =>
							Effect.sync(() => {
								log.warn(
									`Failed to connect PTY ${pty.id}: ${formatErrorDetail(cause)}`,
								);
							}),
						),
					);
				}
			}
			return true;
		}).pipe(openCodeLock.withPermits(1), Effect.scoped);

		const changes = yield* Queue.dropping<void>(1);
		let completed = yield* Deferred.make<boolean>();
		yield* Effect.addFinalizer(() =>
			Deferred.interrupt(completed).pipe(
				Effect.andThen(Queue.shutdown(changes)),
			),
		);

		const terminal: OpenCodeTerminalService = {
			create: (clientId: string, cwd = config.projectDir, account) =>
				Effect.gen(function* () {
					const session = wsHandler.getClientSession(clientId) ?? "?";
					const createResult = yield* Effect.result(
						localPty.create({
							cwd,
							...(account?.driver === "claude"
								? { env: makeClaudeTerminalEnv({ configDir: account.folder }) }
								: {}),
							...(cwd !== config.projectDir
								? { projectDir: config.projectDir }
								: {}),
						}),
					);
					if (createResult._tag === "Failure") {
						log.warn(
							`client=${clientId} session=${session} Failed to create PTY: ${formatErrorDetail(createResult.failure.cause)}`,
						);
						return yield* createResult.failure;
					}

					const { pty } = createResult.success;
					log.info(
						`client=${clientId} session=${session} Created: ${pty.id} (pid=${pty.pid})`,
					);
					registerLocalSession(createResult.success, false);
				}).pipe(Effect.uninterruptible, terminalLock.withPermits(1), (create) =>
					Effect.gen(function* () {
						// Match cleanup's launch lock so a successful spawn is visible
						// to its final host read before the directory can be removed.
						const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
						const worktrees = yield* Effect.serviceOption(WorktreeServiceTag);
						const spawn =
							worktrees._tag === "Some"
								? worktrees.value.withCheckoutUse(create)
								: create;
						return yield* workspace._tag === "Some"
							? workspace.value.withLaunch(spawn)
							: spawn;
					}),
				),
			list: () =>
				Effect.gen(function* () {
					const batch = completed;
					Queue.offerUnsafe(changes, undefined);
					if (!(yield* Deferred.await(batch))) yield* restoreLocalSessions;
					return trackedPtys();
				}),
			snapshot: () =>
				trackedPtys().map((pty) => ({
					pty,
					scrollback: ptyManager.getScrollback(pty.id),
				})),
			subscribe: (listener) => ptyManager.subscribe(listener),
			onOpenCodePtysChanged: (instanceId) => {
				if (instanceId === openCodeId) Queue.offerUnsafe(changes, undefined);
			},
			sendInput: (ptyId: string, data: string) =>
				Effect.try({
					try: () => {
						const session = ptyManager.getSession(ptyId);
						if (
							!session ||
							session.exited ||
							session.upstream?.readyState !== 1
						)
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
					const local = yield* Effect.gen(function* () {
						const session = ptyManager.getSession(ptyId);
						let local = session?.source === "local";
						if (!session || (local && session.upstream?.readyState === 0)) {
							const hosted = yield* localPty.list(config.projectDir);
							if (hosted.some(({ id }) => id === ptyId)) {
								local = true;
								const restored = yield* localPty.attach(
									ptyId,
									config.projectDir,
								);
								restored.upstream.close(1000, "Terminal closed");
							}
						}
						if (local) {
							ptyManager.closeSession(ptyId);
							ptyManager.publish({ _tag: "remove", id: ptyId });
						}
						return local;
					}).pipe(terminalLock.withPermits(1));
					if (local) return;
					yield* callOpenCodePty("delete", ptyId, (pty) =>
						pty.delete(ptyId),
					).pipe(openCodeLock.withPermits(1));
					yield* terminal.list();
				}),
			resize: (clientId: string, ptyId: string, rows: number, cols: number) =>
				Effect.gen(function* () {
					const session = ptyManager.getSession(ptyId);
					if (session?.source === "local") {
						session.upstream?.resize?.(cols, rows);
						return;
					}
					const resizeResult = yield* Effect.result(
						callOpenCodePty("resize", ptyId, (pty) =>
							pty.resize(ptyId, rows, cols),
						),
					);
					if (resizeResult._tag === "Failure") {
						log.warn(
							`client=${clientId} session=${wsHandler.getClientSession(clientId) ?? "?"} Resize failed ${ptyId}: ${formatErrorDetail(resizeResult.failure.cause)}`,
						);
					}
				}),
		};
		const attempt = Effect.gen(function* () {
			yield* Queue.clear(changes);
			const next = yield* Deferred.make<boolean>();
			const batch = completed;
			completed = next;
			return yield* reconcile.pipe(
				Effect.onExit((exit) => {
					if (Exit.isFailure(exit) && Failure.isInterrupted(exit.cause))
						return Deferred.interrupt(batch);
					if (Exit.isFailure(exit))
						log.debug(
							`OpenCode PTY reconciliation unavailable: ${formatErrorDetail(exit.cause)}`,
						);
					// A failed read returns cached rows to this batch, but remains dirty
					// inside the worker's retry. A stopped provider pauses retry.
					return Deferred.succeed(
						batch,
						Exit.isSuccess(exit) ? exit.value : true,
					);
				}),
			);
		});
		yield* Effect.forkScoped(
			Queue.take(changes).pipe(
				Effect.andThen(
					// Each retry leases the instance and so renews its idle grace;
					// unbounded retries would keep a broken instance alive forever.
					// The next lifecycle signal re-arms discovery.
					attempt.pipe(
						Effect.retry(
							Schedule.max([
								Schedule.exponential("1 second"),
								Schedule.recurs(5),
							]),
						),
						Effect.ignore,
					),
				),
				Effect.forever,
			),
			{ uninterruptible: "inherit" },
		);

		return terminal;
	}),
);
