// Connects a PTY session to the upstream OpenCode WebSocket endpoint.
// Extracted from relay-stack.ts so it can be tested and understood independently.

import type { PtyEvent } from "../contracts/ws-rpc.js";
import type { Logger } from "../logger.js";
import { type PtySessionState, trackedPtyInfo } from "./pty-manager.js";

export interface PtyUpstreamDeps {
	ptyManager: {
		registerSession(ptyId: string, upstream: unknown): void;
		closeSession(ptyId: string): void;
		appendScrollback(ptyId: string, text: string): void;
		markExited(ptyId: string, exitCode: number): void;
		hasSession(ptyId: string): boolean;
		getSession(
			ptyId: string,
		):
			| Pick<PtySessionState, "source" | "upstream" | "info" | "exited">
			| undefined;
		publish(event: PtyEvent): void;
	};
	client: {
		getAuthHeaders(): Record<string, string>;
	};
	opencodeUrl: string;
	projectDir: string;
	log: Logger;
	WebSocketClass: typeof import("ws").WebSocket;
	onClose?: () => void;
	/** Interrupt a pending socket acquisition when the relay's scope closes. */
	signal?: AbortSignal;
}

type RawData = import("ws").RawData;

/**
 * Open an upstream WebSocket to OpenCode's `/pty/:id/connect` endpoint and wire
 * it to the relay's PTY manager, whose feed every PTY subscriber reads.
 *
 * @param deps   - Explicit dependencies (ptyManager, wsHandler, client, etc.)
 * @param ptyId  - The PTY session identifier
 * @param cursor - 0 to replay the entire PTY buffer (new PTYs), -1 to skip
 *                 buffered data (reconnecting to an existing PTY)
 */
export async function connectPtyUpstream(
	deps: PtyUpstreamDeps,
	ptyId: string,
	cursor: number = 0,
): Promise<void> {
	const {
		ptyManager,
		client,
		opencodeUrl,
		projectDir,
		log,
		WebSocketClass,
		signal,
		onClose,
	} = deps;

	const httpUrl = new URL(
		`/pty/${ptyId}/connect?cursor=${cursor}`,
		opencodeUrl,
	);
	const wsUrl = httpUrl.toString().replace(/^http/, "ws");
	const headers = client.getAuthHeaders();

	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(`PTY ${ptyId} attachment interrupted`));
			return;
		}
		const upstream = new WebSocketClass(wsUrl, {
			headers,
			// Disable per-message compression for PTY connections.
			// Bun's WS may negotiate permessage-deflate with Node's ws, and
			// decompression bugs or flush mismatches can corrupt binary PTY data.
			perMessageDeflate: false,
			// Skip UTF-8 validation for TEXT frames. Terminal data can contain
			// 8-bit characters (C1 control codes) that are valid in terminal
			// protocols but technically invalid in strict UTF-8. Without this,
			// the ws library would close the connection on such frames.
			skipUTF8Validation: true,
		});

		// Register session BEFORE any events can fire. This mirrors the
		// original pattern where the PtySession object was created before
		// the WebSocket — prevents the race condition where OpenCode sends
		// replay data in the same TCP segment as the upgrade response
		// (Node.js ws processes both synchronously).
		ptyManager.registerSession(ptyId, upstream);
		const current = () => {
			const session = ptyManager.getSession(ptyId);
			return session?.source === "opencode" && session.upstream === upstream;
		};
		if (!current()) {
			// Registration refused a late provider attachment to a local terminal.
			upstream.on("error", () => {});
			upstream.terminate();
			onClose?.();
			resolve();
			return;
		}
		let connected = false;
		const disconnect = () => {
			const session = ptyManager.getSession(ptyId);
			// Discovery owns the row. A failed socket must retain its scrollback.
			if (current() && session) session.upstream = undefined;
			upstream.terminate();
		};

		const connectTimeout = setTimeout(() => {
			cleanup();
			disconnect();
			reject(new Error(`Timed out connecting to PTY ${ptyId}`));
		}, 10_000);
		const abort = () => {
			cleanup();
			disconnect();
			reject(new Error(`PTY ${ptyId} attachment interrupted`));
		};
		const cleanup = () => {
			clearTimeout(connectTimeout);
			signal?.removeEventListener("abort", abort);
		};
		signal?.addEventListener("abort", abort, { once: true });

		// Install message handler BEFORE "open" fires.
		upstream.on("message", (data: RawData) => {
			if (!current()) return;
			// OpenCode sends cursor metadata as binary: 0x00 + JSON {"cursor":N}.
			// Always convert to Buffer first and check byte 0.
			let buf: Buffer;
			if (Buffer.isBuffer(data)) {
				buf = data;
			} else if (typeof data === "string") {
				buf = Buffer.from(data);
			} else {
				buf = Buffer.from(data as ArrayBuffer);
			}

			if (buf.length > 0 && buf[0] === 0x00) return;
			const text = buf.toString();
			if (!text) return;

			// Buffer scrollback via PtyManager (FIFO, 50 KB cap)
			ptyManager.appendScrollback(ptyId, text);

			ptyManager.publish({ _tag: "output", ptyId, data: text });
		});

		upstream.on("close", () => {
			cleanup();
			if (!connected)
				reject(new Error(`PTY ${ptyId} closed before connecting`));
			// An obsolete socket must not mark a removed or replaced session exited.
			const session = ptyManager.getSession(ptyId);
			if (current() && session && !session.exited) {
				ptyManager.markExited(ptyId, 0);
				ptyManager.publish({
					_tag: "upsert",
					item: trackedPtyInfo(
						{ id: ptyId, status: "exited" },
						projectDir,
						session.info,
					),
				});
			}
			log.info(`Upstream closed: ${ptyId}`);
			onClose?.();
		});

		upstream.on("error", (err: Error) => {
			if (!connected) {
				cleanup();
				disconnect();
				reject(err);
			}
			log.warn(`Upstream error ${ptyId}: ${err.message}`);
		});

		upstream.on("open", () => {
			connected = true;
			cleanup();
			resolve();
		});
	});
}
