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

import type { Avatar, AvatarChoice } from "../../contracts/user-avatar.js";

type Listener = (event?: unknown) => void;

// Module scope, not per socket: the RPC client outlives a story and keeps the
// socket an earlier story opened, so a story's configuration must reach sockets
// it did not create.
const failingRequests = new Set<string>();
const replies = new Map<string, (payload: unknown) => unknown>();
let sessionProject: string | null = null;
let avatar: Avatar = {
	choice: { kind: "initial" },
	name: "David",
	macPicture: null,
};

export function seedStoryAvatar(value: Avatar): void {
	avatar = value;
}

/** Unary fixtures use the same socket boundary as the app. */
export function replyRpc(
	tag: string,
	reply: (payload: unknown) => unknown,
): () => void {
	replies.set(tag, reply);
	return () => {
		replies.delete(tag);
	};
}

/**
 * Answers every `tag` request on the fake sockets with a WsRpcError until the
 * returned cleanup runs.
 */
export function failRpc(tag: string): () => void {
	failingRequests.add(tag);
	return () => failingRequests.delete(tag);
}

// Opens for sockets dialed while `opens` was false, run by the next connectedSocket().
const waiting = new Set<() => void>();
let opens = true;

/**
 * Replaces `globalThis.WebSocket` with a socket that opens on the next tick and
 * stays open, and opens any socket `connectingSocket()` left dialing. Returns a
 * cleanup that restores the original, suitable for returning straight from a
 * story's `beforeEach`. `project` is the project AttachProject reports for a
 * session route, whose transcript then opens empty and settled; null means the
 * session does not exist.
 */
export function connectedSocket(project: string | null = null): () => void {
	const restore = fakeSocket(project, true);
	for (const open of waiting) setTimeout(open, 0);
	return restore;
}

/**
 * Replaces `globalThis.WebSocket` with a socket that stays connecting until a
 * later `connectedSocket()` opens it. The RPC client keeps the first socket a
 * story file dials, so a file whose components dial on mount, but only some of
 * whose stories connect, needs this: a real socket to the Vitest server never
 * opens nor closes, and would pin every later story in the file to it.
 */
export function connectingSocket(): () => void {
	return fakeSocket(null, false);
}

function fakeSocket(project: string | null, opensNow: boolean): () => void {
	const RealWebSocket = globalThis.WebSocket;
	const previouslyOpens = opens;
	sessionProject = project;
	opens = opensNow;

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
			const open = () => {
				waiting.delete(open);
				if (this.readyState !== OpenSocket.CONNECTING) return;
				this.readyState = OpenSocket.OPEN;
				this.emit("open");
			};
			// Open after the RPC transport has attached its listeners.
			if (opens) setTimeout(open, 0);
			else waiting.add(open);
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
				payload?: {
					projectSlug?: string;
					sessionId?: string;
					choice?: AvatarChoice;
				};
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
				return;
			}
			if (
				request._tag === "Request" &&
				(request.tag === "GetAvatar" || request.tag === "SetAvatar")
			) {
				if (request.tag === "SetAvatar" && request.payload?.choice)
					avatar = { ...avatar, choice: request.payload.choice };
				this.emit(
					"message",
					new MessageEvent("message", {
						data: JSON.stringify({
							_tag: "Exit",
							requestId: request.id,
							exit: { _tag: "Success", value: avatar },
						}),
					}),
				);
			}
			const reply = replies.get(request.tag ?? "");
			if (request._tag === "Request" && reply) {
				const respond = (exit: unknown) =>
					this.emit(
						"message",
						new MessageEvent("message", {
							data: JSON.stringify({
								_tag: "Exit",
								requestId: request.id,
								exit,
							}),
						}),
					);
				try {
					const value = reply(request.payload ?? {});
					if (value instanceof Promise)
						void value.then(
							(result: unknown) => respond({ _tag: "Success", value: result }),
							(error: unknown) =>
								respond({ _tag: "Failure", cause: { _tag: "Fail", error } }),
						);
					else respond({ _tag: "Success", value });
				} catch (error) {
					respond({ _tag: "Failure", cause: { _tag: "Fail", error } });
				}
				return;
			}
			// A session that exists opens on an empty transcript, already settled.
			if (
				request._tag === "Request" &&
				request.tag === "SubscribeSessionDetail" &&
				sessionProject
			) {
				this.emit(
					"message",
					new MessageEvent("message", {
						data: JSON.stringify({
							_tag: "Chunk",
							requestId: request.id,
							values: [
								{ _tag: "snapshot", rows: [], sequence: 1, hasMore: false },
								{ _tag: "synchronized" },
							],
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
								value: request.payload?.sessionId
									? { projectSlug: sessionProject, sessionSlug: sessionProject }
									: {
											projectSlug: request.payload?.projectSlug ?? null,
											sessionSlug: null,
										},
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
		sessionProject = null;
		opens = previouslyOpens;
	};
}
