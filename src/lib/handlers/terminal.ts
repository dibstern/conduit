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
import { resolveSessionForLog } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

/**
 * Create a PTY via the OpenCode API, broadcast pty_created, and connect the
 * upstream WebSocket. Shared between pty_create and terminal_command:create.
 */
async function createAndConnectPty(
	deps: HandlerDeps,
	clientId: string,
): Promise<void> {
	const session = resolveSessionForLog(deps, clientId);
	let createResult: Record<string, unknown>;
	try {
		createResult = (await deps.client.pty.create()) as Record<string, unknown>;
	} catch (createErr) {
		deps.log.warn(
			`client=${clientId} session=${session} Failed to create PTY: ${formatErrorDetail(createErr)}`,
		);
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				createErr,
				"PTY_CREATE_FAILED",
				"Failed to create terminal",
			).toSystemError(),
		);
		return;
	}

	const ptyId = String(createResult["id"] ?? "");
	if (!ptyId) {
		deps.log.warn(
			`client=${clientId} session=${session} Create returned no id: ${JSON.stringify(createResult)}`,
		);
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("Terminal creation returned no ID", {
				code: "PTY_CREATE_FAILED",
			}).toSystemError(),
		);
		return;
	}

	const pty: PtyInfo = {
		id: ptyId,
		title: String(createResult["title"] ?? "Terminal"),
		command: String(createResult["command"] ?? "bash"),
		cwd: String(createResult["cwd"] ?? deps.config.projectDir),
		status: (createResult["status"] === "exited"
			? "exited"
			: "running") satisfies PtyStatus,
		pid: Number(createResult["pid"] ?? 0),
	};

	deps.log.info(
		`client=${clientId} session=${session} Created: ${ptyId} (pid=${pty.pid})`,
	);
	// Notify browser FIRST (like claude-relay: term_created before data)
	deps.wsHandler.broadcast({ type: "pty_created", pty });

	// THEN connect upstream (handler installed before "open", no data loss)
	try {
		await deps.connectPtyUpstream(ptyId);
		deps.log.info(
			`client=${clientId} session=${session} Connected upstream WS: ${ptyId}`,
		);
	} catch (connectErr) {
		deps.log.warn(
			`client=${clientId} session=${session} Failed to connect upstream WS: ${ptyId}: ${formatErrorDetail(connectErr)}`,
		);
		// Clean up the ghost tab — we already broadcast pty_created
		deps.wsHandler.broadcast({ type: "pty_deleted", ptyId });
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				connectErr,
				"PTY_CONNECT_FAILED",
				"Failed to connect to terminal",
			).toSystemError(),
		);
	}
}

export async function handleTerminalCommand(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["terminal_command"],
): Promise<void> {
	const { action } = payload;
	const session = resolveSessionForLog(deps, clientId);
	if (action === "create") {
		deps.log.info(
			`client=${clientId} session=${session} terminal_command create → delegating to pty_create`,
		);
		await createAndConnectPty(deps, clientId);
	} else if (action === "close" || action === "delete") {
		const ptyId = payload.ptyId ?? "";
		if (ptyId) {
			deps.ptyManager.closeSession(ptyId);
			await deps.client.pty.delete(ptyId);
			deps.wsHandler.broadcast({ type: "pty_deleted", ptyId });
		}
	} else if (action === "list") {
		const ptys = await deps.client.pty.list();
		deps.wsHandler.sendTo(clientId, {
			type: "pty_list",
			// The REST API returns full PTY objects; the index-typed return
			// type in opencode-client is intentionally loose.
			ptys: ptys as unknown as PtyInfo[],
		});
		// Ensure upstream WS connections exist for running PTYs
		for (const pty of ptys) {
			const pid = String(pty.id ?? "");
			if (
				pid &&
				!deps.ptyManager.hasSession(pid) &&
				(pty as Record<string, unknown>)["status"] === "running"
			) {
				try {
					await deps.connectPtyUpstream(pid, -1);
					deps.log.info(
						`client=${clientId} session=${session} Reconnected upstream WS: ${pid}`,
					);
				} catch (err) {
					deps.log.warn(
						`client=${clientId} session=${session} Failed to reconnect upstream: ${pid}: ${formatErrorDetail(err)}`,
					);
				}
			}
		}
	}
}

export async function handlePtyCreate(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["pty_create"],
): Promise<void> {
	deps.log.info(
		`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Creating PTY session...`,
	);
	await createAndConnectPty(deps, clientId);
}

export async function handlePtyInput(
	deps: HandlerDeps,
	_clientId: string,
	payload: PayloadMap["pty_input"],
): Promise<void> {
	const { ptyId, data } = payload;
	if (ptyId && data) {
		deps.ptyManager.sendInput(ptyId, data);
	}
}

export async function handlePtyResize(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["pty_resize"],
): Promise<void> {
	const { ptyId } = payload;
	const cols = payload.cols ?? 80;
	const rows = payload.rows ?? 24;
	if (ptyId) {
		try {
			await deps.client.pty.resize(ptyId, rows, cols);
		} catch (resizeErr) {
			// Non-fatal — log but don't error to browser
			deps.log.warn(
				`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Resize failed ${ptyId}: ${formatErrorDetail(resizeErr)}`,
			);
		}
	}
}

export async function handlePtyClose(
	deps: HandlerDeps,
	_clientId: string,
	payload: PayloadMap["pty_close"],
): Promise<void> {
	const { ptyId } = payload;
	if (ptyId) {
		deps.ptyManager.closeSession(ptyId);
		await deps.client.pty.delete(ptyId);
		deps.wsHandler.broadcast({ type: "pty_deleted", ptyId });
	}
}

// ─── Effect-based handler implementations ──────────────────────────────────
// These will replace the above functions once the dispatch table is rewired
// in Task 5.3. Until then they coexist alongside the original handlers.

/**
 * Create a PTY via the OpenCode API, broadcast pty_created, and connect the
 * upstream WebSocket. Effect version of createAndConnectPty.
 */
const createAndConnectPtyEffect = (clientId: string) =>
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

export const handleTerminalCommandEffect = (
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
			yield* createAndConnectPtyEffect(clientId);
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

export const handlePtyCreateEffect = (
	clientId: string,
	_payload: PayloadMap["pty_create"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		log.info(
			`client=${clientId} session=${wsHandler.getClientSession(clientId) ?? "?"} Creating PTY session...`,
		);
		yield* createAndConnectPtyEffect(clientId);
	});

export const handlePtyInputEffect = (
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

export const handlePtyResizeEffect = (
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

export const handlePtyCloseEffect = (
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
