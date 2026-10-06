// Connects a PTY session to the upstream OpenCode WebSocket endpoint.
// Extracted from relay-stack.ts so it can be tested and understood independently.

import type { PtyEvent } from "../contracts/ws-rpc.js";
import type { Logger } from "../logger.js";
import type { PtyInfo } from "../shared-types.js";
import { trackedPtyInfo } from "./pty-manager.js";

export interface PtyUpstreamDeps {
	ptyManager: {
		registerSession(ptyId: string, upstream: unknown): void;
		closeSession(ptyId: string): void;
		appendScrollback(ptyId: string, text: string): void;
		markExited(ptyId: string, exitCode: number): void;
		hasSession(ptyId: string): boolean;
		getSession(ptyId: string): { readonly info?: PtyInfo } | undefined;
		publish(event: PtyEvent): void;
	};
	client: {
		getAuthHeaders(): Record<string, string>;
	};
	opencodeUrl: string;
	projectDir: string;
	log: Logger;
	WebSocketClass: typeof import("ws").WebSocket;
	/** Runs once the upstream socket has closed, however it closed. */
	onClose?: () => void;
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
		onClose,
	} = deps;

	const httpUrl = new URL(
		`/pty/${ptyId}/connect?cursor=${cursor}`,
		opencodeUrl,
	);
	const wsUrl = httpUrl.toString().replace(/^http/, "ws");
	const headers = client.getAuthHeaders();

	return new Promise<void>((resolve, reject) => {
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
		let connected = false;

		const connectTimeout = setTimeout(() => {
			// Remove the session on timeout — it was never successfully opened
			ptyManager.closeSession(ptyId);
			reject(new Error(`Timed out connecting to PTY ${ptyId}`));
		}, 10_000);

		// Install message handler BEFORE "open" fires.
		upstream.on("message", (data: RawData) => {
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
			ptyManager.markExited(ptyId, 0);
			// Only announce the exit if the session is still tracked: a closed
			// PTY was already announced removed, and a failed connect was never
			// stored.
			const session = ptyManager.getSession(ptyId);
			if (session) {
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
				clearTimeout(connectTimeout);
				// Remove the failed session
				ptyManager.closeSession(ptyId);
				reject(err);
			}
			log.warn(`Upstream error ${ptyId}: ${err.message}`);
		});

		upstream.on("open", () => {
			connected = true;
			clearTimeout(connectTimeout);
			resolve();
		});
	});
}
