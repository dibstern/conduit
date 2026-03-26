// ─── Recording Proxy ─────────────────────────────────────────────────────────
// A transparent HTTP proxy that forwards requests to a real OpenCode instance
// and captures every interaction for later replay.

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type { OpenCodeInteraction } from "../e2e/fixtures/recorded/types.js";

/**
 * Returns a WebSocket close code that is safe to pass to `ws.close()`.
 * Codes 1005 and 1006 are reserved by the spec and must not be sent.
 */
function safeCloseCode(code: number): number {
	if (code === 1005 || code === 1006) return 1000;
	return code;
}

export class RecordingProxy {
	private readonly upstreamUrl: string;
	private server: Server | undefined;
	private wss: WebSocketServer | undefined;
	private interactions: OpenCodeInteraction[] = [];
	private lastEventTime: number | undefined;
	private _url = "";
	private activeSseReaders: Set<ReadableStreamDefaultReader<Uint8Array>> =
		new Set();

	constructor(upstreamUrl: string) {
		this.upstreamUrl = upstreamUrl.replace(/\/$/, "");
	}

	/** The proxy's base URL (e.g. `http://127.0.0.1:12345`). Only valid after start(). */
	get url(): string {
		return this._url;
	}

	/** Start the proxy server. */
	async start(): Promise<void> {
		const server = createServer((req, res) => this.handleRequest(req, res));
		this.server = server;

		const wss = new WebSocketServer({ noServer: true });
		this.wss = wss;
		server.on("upgrade", (req, socket, head) =>
			this.handleUpgrade(req, socket, head, wss),
		);

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const addr = server.address() as AddressInfo;
		this._url = `http://127.0.0.1:${String(addr.port)}`;
	}

	/** Stop the proxy server and clean up. */
	async stop(): Promise<void> {
		// Close all open WebSocket connections
		if (this.wss) {
			for (const client of this.wss.clients) {
				client.close();
			}
			this.wss.close();
			this.wss = undefined;
		}

		const server = this.server;
		if (server) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			this.server = undefined;
		}
	}

	/** Return the recorded interactions. */
	getRecording(): OpenCodeInteraction[] {
		return [...this.interactions];
	}

	/** Clear all recorded interactions and abort active SSE streams. */
	reset(): void {
		// Cancel any active SSE readers so zombie pump loops don't
		// push events into the new interactions array.
		for (const reader of this.activeSseReaders) {
			reader.cancel().catch(() => {});
		}
		this.activeSseReaders.clear();
		this.interactions = [];
		this.lastEventTime = undefined;
	}

	// ─── Private: HTTP request handling ──────────────────────────────────────

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const path = req.url ?? "/";
		const method = req.method ?? "GET";

		// Read request body
		const requestBody = await this.readBody(req);

		// Build upstream URL
		const upstreamUrlStr = `${this.upstreamUrl}${path}`;

		// Forward all headers, rewriting Host
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (key === "host") continue;
			if (value !== undefined) {
				headers[key] = Array.isArray(value) ? value.join(", ") : value;
			}
		}

		try {
			const upstreamRes = await fetch(upstreamUrlStr, {
				method,
				headers,
				body: method !== "GET" && method !== "HEAD" ? requestBody : undefined,
				// @ts-expect-error -- Node fetch supports duplex for streaming
				duplex: method !== "GET" && method !== "HEAD" ? "half" : undefined,
				redirect: "manual",
			});

			const contentType = upstreamRes.headers.get("content-type") ?? "";

			if (contentType.includes("text/event-stream")) {
				this.handleSseResponse(upstreamRes, res);
			} else {
				await this.handleRestResponse(
					method,
					path,
					requestBody,
					upstreamRes,
					res,
				);
			}
		} catch (err) {
			res.writeHead(502);
			res.end(`Proxy error: ${String(err)}`);
		}
	}

	private async handleRestResponse(
		method: string,
		path: string,
		requestBody: string | undefined,
		upstreamRes: Response,
		res: ServerResponse,
	): Promise<void> {
		const status = upstreamRes.status;
		const responseBuffer = Buffer.from(await upstreamRes.arrayBuffer());

		// Forward response headers
		for (const [key, value] of upstreamRes.headers) {
			// Skip transfer-encoding since we're sending the full buffer
			if (key.toLowerCase() === "transfer-encoding") continue;
			res.setHeader(key, value);
		}

		res.writeHead(status);
		res.end(responseBuffer);

		// Record the interaction
		let responseBody: unknown;
		try {
			responseBody = JSON.parse(responseBuffer.toString());
		} catch {
			responseBody = responseBuffer.toString();
		}

		let parsedRequestBody: unknown;
		if (requestBody) {
			try {
				parsedRequestBody = JSON.parse(requestBody);
			} catch {
				parsedRequestBody = requestBody;
			}
		}

		this.interactions.push({
			kind: "rest",
			method,
			path,
			...(parsedRequestBody !== undefined
				? { requestBody: parsedRequestBody }
				: {}),
			status,
			responseBody,
		});
	}

	private handleSseResponse(upstreamRes: Response, res: ServerResponse): void {
		// Forward headers
		for (const [key, value] of upstreamRes.headers) {
			if (key.toLowerCase() === "transfer-encoding") continue;
			res.setHeader(key, value);
		}
		res.writeHead(200);

		const body = upstreamRes.body;
		if (!body) {
			res.end();
			return;
		}

		const reader = body.getReader();
		this.activeSseReaders.add(reader);
		const decoder = new TextDecoder();
		let buffer = "";

		const cleanup = (): void => {
			this.activeSseReaders.delete(reader);
			res.end();
		};

		const pump = (): void => {
			reader
				.read()
				.then(({ done, value }) => {
					if (done) {
						// Process any remaining buffer
						if (buffer.trim()) {
							this.processSseBuffer(buffer);
						}
						cleanup();
						return;
					}

					const chunk = decoder.decode(value, { stream: true });
					// Write to client immediately (transparent streaming)
					res.write(Buffer.from(value));

					// Parse SSE data lines from the accumulated buffer
					buffer += chunk;
					const parts = buffer.split("\n\n");
					// Keep the last incomplete part in the buffer
					buffer = parts.pop() ?? "";

					for (const part of parts) {
						this.processSseBuffer(part);
					}

					pump();
				})
				.catch(() => {
					cleanup();
				});
		};

		pump();
	}

	private processSseBuffer(block: string): void {
		for (const line of block.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			const jsonStr = line.slice(6);
			try {
				const parsed = JSON.parse(jsonStr) as {
					type?: string;
					properties?: unknown;
				};
				if (parsed.type) {
					const now = Date.now();
					const delayMs =
						this.lastEventTime !== undefined ? now - this.lastEventTime : 0;
					this.lastEventTime = now;

					this.interactions.push({
						kind: "sse",
						type: parsed.type,
						properties: (parsed.properties as Record<string, unknown>) ?? {},
						delayMs,
					});
				}
			} catch {
				// Skip non-JSON data lines
			}
		}
	}

	// ─── Private: WebSocket upgrade handling ─────────────────────────────────

	private handleUpgrade(
		req: IncomingMessage,
		socket: import("node:stream").Duplex,
		head: Buffer,
		wss: WebSocketServer,
	): void {
		const urlPath = req.url ?? "";

		// Only handle PTY WebSocket connections
		const ptyMatch = /\/pty\/([^/]+)\/connect/.exec(urlPath);
		if (!ptyMatch || !ptyMatch[1]) {
			socket.destroy();
			return;
		}

		const ptyId = ptyMatch[1];
		const queryString = urlPath.split("?")[1] ?? "";
		const params = new URLSearchParams(queryString);
		const cursor = Number(params.get("cursor") ?? "0");

		// Accept the client WebSocket
		wss.handleUpgrade(req, socket, head, (clientWs) => {
			// Connect upstream
			const upstreamWsUrl = `${this.upstreamUrl.replace(/^http/, "ws")}${urlPath}`;

			// Forward relevant headers (skip WebSocket handshake headers)
			const upstreamHeaders: Record<string, string> = {};
			for (const [key, value] of Object.entries(req.headers)) {
				const lk = key.toLowerCase();
				if (
					lk === "host" ||
					lk === "upgrade" ||
					lk === "connection" ||
					lk === "sec-websocket-key" ||
					lk === "sec-websocket-version" ||
					lk === "sec-websocket-extensions"
				) {
					continue;
				}
				if (value !== undefined) {
					upstreamHeaders[key] = Array.isArray(value)
						? value.join(", ")
						: value;
				}
			}

			const upstreamWs = new WebSocket(upstreamWsUrl, {
				headers: upstreamHeaders,
			});

			// Queue client messages until upstream is open
			const pendingClientMessages: { data: Buffer; isBinary: boolean }[] = [];
			let upstreamOpen = false;

			// Record connection open
			this.interactions.push({ kind: "pty-open", ptyId, cursor });

			upstreamWs.on("open", () => {
				upstreamOpen = true;
				// Flush any queued client messages
				for (const msg of pendingClientMessages) {
					upstreamWs.send(msg.data, { binary: msg.isBinary });
				}
				pendingClientMessages.length = 0;
			});

			// Upstream → Client
			upstreamWs.on("message", (data: Buffer, isBinary: boolean) => {
				if (clientWs.readyState === WebSocket.OPEN) {
					clientWs.send(data, { binary: isBinary });
				}

				// Record text frames only; binary frames with 0x00 prefix are NOT recorded
				if (!isBinary) {
					const now = Date.now();
					const delayMs =
						this.lastEventTime !== undefined ? now - this.lastEventTime : 0;
					this.lastEventTime = now;

					this.interactions.push({
						kind: "pty-output",
						ptyId,
						data: data.toString(),
						delayMs,
					});
				}
			});

			// Client → Upstream
			clientWs.on("message", (data: Buffer, isBinary: boolean) => {
				if (upstreamOpen && upstreamWs.readyState === WebSocket.OPEN) {
					upstreamWs.send(data, { binary: isBinary });
				} else {
					pendingClientMessages.push({ data, isBinary });
				}

				// Only record text frames as pty-input
				if (!isBinary) {
					const now = Date.now();
					const delayMs =
						this.lastEventTime !== undefined ? now - this.lastEventTime : 0;
					this.lastEventTime = now;

					this.interactions.push({
						kind: "pty-input",
						ptyId,
						data: data.toString(),
						delayMs,
					});
				}
			});

			// Handle close from either side — record only once per connection
			let closedRecorded = false;

			const recordClose = (code: number, reason: Buffer): void => {
				if (closedRecorded) return;
				closedRecorded = true;

				const now = Date.now();
				const delayMs =
					this.lastEventTime !== undefined ? now - this.lastEventTime : 0;
				this.lastEventTime = now;

				this.interactions.push({
					kind: "pty-close",
					ptyId,
					code,
					reason: reason.toString(),
					delayMs,
				});
			};

			upstreamWs.on("close", (code, reason) => {
				recordClose(code, reason);
				if (clientWs.readyState === WebSocket.OPEN) {
					clientWs.close(safeCloseCode(code), reason);
				}
			});

			clientWs.on("close", (code, reason) => {
				recordClose(code, reason);
				if (upstreamWs.readyState === WebSocket.OPEN) {
					upstreamWs.close(safeCloseCode(code), reason);
				}
			});

			// Handle errors
			upstreamWs.on("error", () => {
				if (clientWs.readyState === WebSocket.OPEN) {
					clientWs.close(1011, "upstream error");
				}
			});

			clientWs.on("error", () => {
				if (upstreamWs.readyState === WebSocket.OPEN) {
					upstreamWs.close(1011, "client error");
				}
			});
		});
	}

	// ─── Private: Utilities ──────────────────────────────────────────────────

	private readBody(req: IncomingMessage): Promise<string | undefined> {
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				if (chunks.length === 0) {
					resolve(undefined);
				} else {
					resolve(Buffer.concat(chunks).toString());
				}
			});
			req.on("error", () => resolve(undefined));
		});
	}
}
