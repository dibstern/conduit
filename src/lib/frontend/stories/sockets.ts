/**
 * A WebSocket stand-in for stories of components that mount the real connection
 * lifecycle.
 *
 * ChatLayout opens RPC WebSockets on mount. Storybook is served by a
 * static file server, so upgrades never complete, `connectionState.status` never reaches
 * "connected", and ConnectOverlay — `fixed inset-0 bg-bg`, gated on
 * `connected && displayNone` — covers the entire viewport. Every Layout/ChatLayout
 * baseline was therefore a pixel-for-pixel copy of
 * Overlays/ConnectOverlay::Connecting: three stories, zero coverage of the
 * layout they are named after, and three green tests saying otherwise.
 *
 * Faking the socket rather than assigning `connectionState.status` directly is
 * deliberate. The status is set by the real `open` handler, which also resets
 * the attempt counter and clears relay state; poking the store would skip all
 * of it and leave the component in a state the app can never actually be in.
 */

type Listener = (event?: unknown) => void;

// Module scope, not per socket: the RPC client outlives a story and keeps the
// socket an earlier story opened, so a story cannot swap in a failing one.
const failingRequests = new Set<string>();

/**
 * Answers every `tag` request on the fake sockets with a WsRpcError until the
 * returned cleanup runs.
 */
export function failRpc(tag: string): () => void {
	failingRequests.add(tag);
	return () => failingRequests.delete(tag);
}

/**
 * Replaces `globalThis.WebSocket` with a socket that opens on the next tick and
 * stays open. Returns a cleanup that restores the original, suitable for
 * returning straight from a story's `beforeEach`.
 */
export function connectedSocket(): () => void {
	const RealWebSocket = globalThis.WebSocket;

	class OpenSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;

		readonly url: string;
		readyState: number = OpenSocket.CONNECTING;

		private readonly listeners = new Map<string, Set<Listener>>();

		constructor(url: string | URL) {
			this.url = String(url);
			// Open after the RPC transport has attached its listeners.
			setTimeout(() => {
				if (this.readyState !== OpenSocket.CONNECTING) return;
				this.readyState = OpenSocket.OPEN;
				this.emit("open");
			}, 0);
		}

		addEventListener(event: string, listener: Listener): void {
			const existing = this.listeners.get(event);
			if (existing) existing.add(listener);
			else this.listeners.set(event, new Set([listener]));
		}

		removeEventListener(event: string, listener: Listener): void {
			this.listeners.get(event)?.delete(listener);
		}

		send(data: unknown): void {
			if (new URL(this.url).pathname !== "/rpc" || typeof data !== "string")
				return;
			const request: {
				_tag?: string;
				id?: string;
				tag?: string;
				payload?: { projectSlug?: string };
			} = JSON.parse(data);
			if (request._tag === "Ping") {
				this.emit(
					"message",
					new MessageEvent("message", {
						data: JSON.stringify({ _tag: "Pong" }),
					}),
				);
			}
			if (
				request._tag === "Request" &&
				failingRequests.has(request.tag ?? "")
			) {
				this.emit(
					"message",
					new MessageEvent("message", {
						data: JSON.stringify({
							_tag: "Exit",
							requestId: request.id,
							exit: {
								_tag: "Failure",
								cause: {
									_tag: "Fail",
									error: { _tag: "WsRpcError", message: "Story failure" },
								},
							},
						}),
					}),
				);
			}
			if (request._tag === "Request" && request.tag === "AttachProject") {
				this.emit(
					"message",
					new MessageEvent("message", {
						data: JSON.stringify({
							_tag: "Exit",
							requestId: request.id,
							exit: {
								_tag: "Success",
								value: { projectSlug: request.payload?.projectSlug ?? null },
							},
						}),
					}),
				);
			}
		}

		close(): void {
			if (this.readyState === OpenSocket.CLOSED) return;
			this.readyState = OpenSocket.CLOSED;
			this.emit(
				"close",
				new CloseEvent("close", { code: 1000, wasClean: true }),
			);
		}

		private emit(event: string, payload?: unknown): void {
			for (const listener of this.listeners.get(event) ?? []) listener(payload);
		}
	}

	globalThis.WebSocket = OpenSocket as unknown as typeof WebSocket;
	return () => {
		globalThis.WebSocket = RealWebSocket;
	};
}
