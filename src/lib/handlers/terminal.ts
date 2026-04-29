// ─── Terminal / PTY Handlers ─────────────────────────────────────────────────

import { Effect } from "effect";
import {
	ConfigTag,
	ConnectPtyUpstreamTag,
	LoggerTag,
	OpenCodeAPITag,
	PtyManagerTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import type { PtyInfo, PtyStatus } from "../shared-types.js";
import type { PayloadMap } from "./payloads.js";

/**
 * Create a PTY via the OpenCode API, broadcast pty_created, and connect the
 * upstream WebSocket. Shared between pty_create and terminal_command:create.
 */
const createAndConnectPty = (clientId: string) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;
		const connectPtyUpstream = yield* ConnectPtyUpstreamTag;

		const session = wsHandler.getClientSession(clientId) ?? "?";

		// PTY creation failure sends error to client (intentional recovery)
		const createResult = yield* Effect.either(
			Effect.tryPromise(() => client.pty.create()),
		);
		if (createResult._tag === "Left") {
			log.warn(
				`client=${clientId} session=${session} Failed to create PTY: ${formatErrorDetail(createResult.left)}`,
			);
			wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					createResult.left,
					"PTY_CREATE_FAILED",
					"Failed to create terminal",
				).toSystemError(),
			);
			return;
		}

		const rawResult = createResult.right as Record<string, unknown>;
		const ptyId = String(rawResult["id"] ?? "");
		if (!ptyId) {
			log.warn(
				`client=${clientId} session=${session} Create returned no id: ${JSON.stringify(rawResult)}`,
			);
			wsHandler.sendTo(
				clientId,
				new RelayError("Terminal creation returned no ID", {
					code: "PTY_CREATE_FAILED",
				}).toSystemError(),
			);
			return;
		}

		const pty: PtyInfo = {
			id: ptyId,
			title: String(rawResult["title"] ?? "Terminal"),
			command: String(rawResult["command"] ?? "bash"),
			cwd: String(rawResult["cwd"] ?? config.projectDir),
			status: (rawResult["status"] === "exited"
				? "exited"
				: "running") satisfies PtyStatus,
			pid: Number(rawResult["pid"] ?? 0),
		};

		log.info(
			`client=${clientId} session=${session} Created: ${ptyId} (pid=${pty.pid})`,
		);
		// Notify browser FIRST (like claude-relay: term_created before data)
		wsHandler.broadcast({ type: "pty_created", pty });

		// THEN connect upstream (handler installed before "open", no data loss)
		const connectResult = yield* Effect.either(
			Effect.tryPromise(() => connectPtyUpstream(ptyId)),
		);
		if (connectResult._tag === "Left") {
			log.warn(
				`client=${clientId} session=${session} Failed to connect upstream WS: ${ptyId}: ${formatErrorDetail(connectResult.left)}`,
			);
			// Clean up the ghost tab — we already broadcast pty_created
			wsHandler.broadcast({ type: "pty_deleted", ptyId });
			wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					connectResult.left,
					"PTY_CONNECT_FAILED",
					"Failed to connect to terminal",
				).toSystemError(),
			);
		} else {
			log.info(
				`client=${clientId} session=${session} Connected upstream WS: ${ptyId}`,
			);
		}
	});

export const handleTerminalCommand = (
	clientId: string,
	payload: PayloadMap["terminal_command"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const ptyManager = yield* PtyManagerTag;
		const connectPtyUpstream = yield* ConnectPtyUpstreamTag;

		const { action } = payload;
		const session = wsHandler.getClientSession(clientId) ?? "?";

		if (action === "create") {
			log.info(
				`client=${clientId} session=${session} terminal_command create → delegating to pty_create`,
			);
			yield* createAndConnectPty(clientId);
		} else if (action === "close" || action === "delete") {
			const ptyId = payload.ptyId ?? "";
			if (ptyId) {
				ptyManager.closeSession(ptyId);
				yield* Effect.tryPromise(() => client.pty.delete(ptyId));
				wsHandler.broadcast({ type: "pty_deleted", ptyId });
			}
		} else if (action === "list") {
			const ptys = yield* Effect.tryPromise(() => client.pty.list());
			wsHandler.sendTo(clientId, {
				type: "pty_list",
				ptys: ptys as unknown as PtyInfo[],
			});
			// Ensure upstream WS connections exist for running PTYs
			for (const pty of ptys) {
				const pid = String(pty.id ?? "");
				if (
					pid &&
					!ptyManager.hasSession(pid) &&
					(pty as Record<string, unknown>)["status"] === "running"
				) {
					const reconnectResult = yield* Effect.either(
						Effect.tryPromise(() => connectPtyUpstream(pid, -1)),
					);
					if (reconnectResult._tag === "Right") {
						log.info(
							`client=${clientId} session=${session} Reconnected upstream WS: ${pid}`,
						);
					} else {
						log.warn(
							`client=${clientId} session=${session} Failed to reconnect upstream: ${pid}: ${formatErrorDetail(reconnectResult.left)}`,
						);
					}
				}
			}
		}
	});

export const handlePtyCreate = (
	clientId: string,
	_payload: PayloadMap["pty_create"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		log.info(
			`client=${clientId} session=${wsHandler.getClientSession(clientId) ?? "?"} Creating PTY session...`,
		);
		yield* createAndConnectPty(clientId);
	});

export const handlePtyInput = (
	_clientId: string,
	payload: PayloadMap["pty_input"],
) =>
	Effect.gen(function* () {
		const ptyManager = yield* PtyManagerTag;

		const { ptyId, data } = payload;
		if (ptyId && data) {
			ptyManager.sendInput(ptyId, data);
		}
	});

export const handlePtyResize = (
	clientId: string,
	payload: PayloadMap["pty_resize"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const { ptyId } = payload;
		const cols = payload.cols ?? 80;
		const rows = payload.rows ?? 24;
		if (ptyId) {
			const resizeResult = yield* Effect.either(
				Effect.tryPromise(() => client.pty.resize(ptyId, rows, cols)),
			);
			if (resizeResult._tag === "Left") {
				// Non-fatal — log but don't error to browser
				log.warn(
					`client=${clientId} session=${wsHandler.getClientSession(clientId) ?? "?"} Resize failed ${ptyId}: ${formatErrorDetail(resizeResult.left)}`,
				);
			}
		}
	});

export const handlePtyClose = (
	_clientId: string,
	payload: PayloadMap["pty_close"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const ptyManager = yield* PtyManagerTag;

		const { ptyId } = payload;
		if (ptyId) {
			ptyManager.closeSession(ptyId);
			yield* Effect.tryPromise(() => client.pty.delete(ptyId));
			wsHandler.broadcast({ type: "pty_deleted", ptyId });
		}
	});
