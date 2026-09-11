/**
 * A WebSocket stand-in for stories of components that mount the real connection
 * lifecycle.
 *
 * Why this exists (conduit-test-732b): ChatLayout calls `connect(slug)` on
 * mount, which opens a real WebSocket. Storybook is served by a static file
 * server, so the upgrade never completes, `wsState.status` never reaches
 * "connected", and ConnectOverlay — `fixed inset-0 bg-bg`, gated on
 * `connected && displayNone` — covers the entire viewport. Every Layout/ChatLayout
 * baseline was therefore a pixel-for-pixel copy of
 * Overlays/ConnectOverlay::Connecting: three stories, zero coverage of the
 * layout they are named after, and three green tests saying otherwise.
 *
 * Faking the socket rather than assigning `wsState.status` directly is
 * deliberate. The status is set by the real `open` handler, which also resets
 * the attempt counter, clears relay state and arms the protocol-version check;
 * poking the store would skip all of it and leave the component in a state the
 * app can never actually be in.
 *
 * The `protocol_version` frame is not garnish. On open the app arms a 10-second
 * timer that raises a "stale daemon" banner if no such frame arrives — a time
 * bomb that would make any baseline captured near it nondeterministic. Sending
 * the frame disarms it through the ordinary code path.
 */

import { WS_PROTOCOL_VERSION } from "../../shared-types.js";

type Listener = (event?: unknown) => void;

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
			// A macrotask, not a microtask: `doConnect` attaches its listeners
			// synchronously after the constructor returns, so firing sooner would
			// open a socket nobody is listening to.
			setTimeout(() => {
				if (this.readyState !== OpenSocket.CONNECTING) return;
				this.readyState = OpenSocket.OPEN;
				this.emit("open");
				this.emit(
					"message",
					new MessageEvent("message", {
						data: JSON.stringify({
							type: "protocol_version",
							version: WS_PROTOCOL_VERSION,
						}),
					}),
				);
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

		send(_data: unknown): void {}

		close(): void {
			if (this.readyState === OpenSocket.CLOSED) return;
			this.readyState = OpenSocket.CLOSED;
			this.emit("close");
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
