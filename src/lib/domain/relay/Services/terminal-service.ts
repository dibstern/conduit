import { Context, Data, Effect, Layer } from "effect";
import { formatErrorDetail, RelayError } from "../../../errors.js";
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
> = Layer.effect(
	OpenCodeTerminalServiceTag,
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;
		const ptyManager = yield* PtyManagerTag;
		const connectPtyUpstream = yield* ConnectPtyUpstreamTag;

		return {
			create: (clientId: string) =>
				Effect.gen(function* () {
					const session = wsHandler.getClientSession(clientId) ?? "?";
					const createResult = yield* Effect.either(
						Effect.tryPromise({
							try: () => client.pty.create(),
							catch: (cause) =>
								new TerminalServiceError({ operation: "create", cause }),
						}),
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

					const ptyResult = toPtyInfo(createResult.right, config.projectDir);
					if (ptyResult._tag === "MissingId") {
						log.warn(
							`client=${clientId} session=${session} Create returned no id: ${JSON.stringify(ptyResult.raw)}`,
						);
						wsHandler.sendTo(
							clientId,
							new RelayError("Terminal creation returned no ID", {
								code: "PTY_CREATE_FAILED",
							}).toSystemError(),
						);
						return;
					}

					const { pty } = ptyResult;
					log.info(
						`client=${clientId} session=${session} Created: ${pty.id} (pid=${pty.pid})`,
					);
					wsHandler.broadcast({ type: "pty_created", pty });

					const connectResult = yield* Effect.either(
						Effect.tryPromise({
							try: () => connectPtyUpstream(pty.id),
							catch: (cause) =>
								new TerminalServiceError({
									operation: "connect",
									ptyId: pty.id,
									cause,
								}),
						}),
					);
					if (connectResult._tag === "Left") {
						log.warn(
							`client=${clientId} session=${session} Failed to connect upstream WS: ${pty.id}: ${formatErrorDetail(connectResult.left.cause)}`,
						);
						wsHandler.broadcast({ type: "pty_deleted", ptyId: pty.id });
						wsHandler.sendTo(
							clientId,
							RelayError.fromCaught(
								connectResult.left.cause,
								"PTY_CONNECT_FAILED",
								"Failed to connect to terminal",
							).toSystemError(),
						);
					} else {
						log.info(
							`client=${clientId} session=${session} Connected upstream WS: ${pty.id}`,
						);
					}
				}),
			list: (clientId: string) =>
				Effect.gen(function* () {
					const session = wsHandler.getClientSession(clientId) ?? "?";
					const rawPtys = yield* Effect.tryPromise({
						try: () => client.pty.list(),
						catch: (cause) =>
							new TerminalServiceError({ operation: "list", cause }),
					});
					const ptys: PtyInfo[] = [];
					for (const rawPty of rawPtys) {
						const ptyResult = toPtyInfo(rawPty, config.projectDir);
						if (ptyResult._tag === "Created") {
							ptys.push(ptyResult.pty);
						} else {
							log.warn(
								`client=${clientId} session=${session} List returned PTY with no id: ${JSON.stringify(ptyResult.raw)}`,
							);
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
					ptyManager.closeSession(ptyId);
					yield* Effect.tryPromise({
						try: () => client.pty.delete(ptyId),
						catch: (cause) =>
							new TerminalServiceError({
								operation: "delete",
								ptyId,
								cause,
							}),
					});
					wsHandler.broadcast({ type: "pty_deleted", ptyId });
				}),
			resize: (clientId: string, ptyId: string, rows: number, cols: number) =>
				Effect.gen(function* () {
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
