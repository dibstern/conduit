// ─── Shared WS-RPC Client ───────────────────────────────────────────────────
// One RPC client pair per project, carried over exactly two WebSockets:
//
//   control — unary calls plus low-rate subscriptions (the shell)
//   stream  — hot per-session streams: session detail now, PTY in ni8.9
//
// The split is about BLAST RADIUS. A socket drop fails every in-flight entry on
// that socket, so the sockets are split along the axis where blast radius
// actually differs: a hot stream going down must not also fail the unrelated
// request a user just made. (ni8.7 measured socket-wide head-of-line blocking
// and disproved it — the socket forks each inbound message into its own fiber,
// so a full mailbox blocks only its own stream. Do not reinstate that argument.)
//
// Two is a ceiling, not a starting point: subscriptions added by ni8.9/10/11/14
// join one of these two classes instead of opening a third socket.
//
// Stream buffering is left at the RpcClient default of 16. Do not wrap the
// client to change it — the per-call override stays available to ni8.9's PTY
// consumer.

import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import {
	Context,
	Effect,
	ExecutionStrategy,
	Exit,
	Layer,
	Ref,
	Scope,
} from "effect";
import { WsRpcGroup } from "./ws-rpc.js";

export interface WsRpcLocation {
	readonly protocol: string;
	readonly host: string;
}

export const makeWsRpcUrl = (
	projectSlug: string,
	location: WsRpcLocation = globalThis.location,
): string => {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/p/${encodeURIComponent(projectSlug)}/rpc`;
};

/** Which of the two sockets a caller's traffic belongs on. */
export type TrafficClass = "control" | "stream";

// The client description, reused by every transport below: an Effect is a
// description, so providing it twice yields two independent clients.
const wsRpcClient = RpcClient.make(WsRpcGroup);

export type WsRpcClient = Effect.Effect.Success<typeof wsRpcClient>;

export interface WsRpcSockets {
	/** Unary calls and low-rate subscriptions. The 49 helpers move here in S-6. */
	readonly control: WsRpcClient;
	/** Hot per-session streams: session detail now, PTY in ni8.9. */
	readonly stream: WsRpcClient;
}

/**
 * Opens one client over one transport, for the lifetime of the ambient scope.
 * Two adapters satisfy this: the live WebSocket one below, and the in-memory
 * one the unit tests supply.
 */
export type WsRpcConnect = (options: {
	readonly url: string;
	readonly trafficClass: TrafficClass;
}) => Effect.Effect<WsRpcClient, never, Scope.Scope>;

// Both classes dial the same endpoint; the traffic class picks the socket, not
// the destination. Each call builds its own layers, so each yields its own
// WebSocket.
//
// `Layer.build`, not `Effect.provide`: the protocol owns the WebSocket — its
// writer and the fiber reading it are acquired in the layer's scope — and
// `Effect.provide` would give that layer a scope of its own that closes the
// moment the client is constructed, leaving a client whose socket is already
// gone. Building into the ambient scope ties the socket to the pair instead.
const connectWebSocket: WsRpcConnect = ({ url }) =>
	Layer.build(
		RpcClient.layerProtocolSocket().pipe(
			Layer.provide(Socket.layerWebSocket(url)),
			Layer.provide(Socket.layerWebSocketConstructorGlobal),
			Layer.provide(RpcSerialization.layerJson),
		),
	).pipe(Effect.flatMap((protocol) => Effect.provide(wsRpcClient, protocol)));

export class WsRpcClients extends Context.Tag("WsRpcClients")<
	WsRpcClients,
	{
		/**
		 * The socket pair for `projectSlug`, opened on first use and reused
		 * afterwards. A different slug replaces the pair, so the browser never
		 * holds more than one pair — the app talks to one project at a time.
		 * Replacing it closes the old sockets, which fails anything still in
		 * flight on them; nothing in the frontend addresses two slugs at once.
		 *
		 * Opening cannot fail in a way a caller could act on, so there is no
		 * error channel: `WsRpcConnect` is typed `never` because the WebSocket
		 * layer defers the connection, so the only way to not get a pair back is
		 * a defect — a bug, or a browser refusing to construct the socket at all.
		 * A failed attempt leaves the cache empty, so the recovery a caller would
		 * have written by hand (retry) is just calling this again.
		 */
		readonly forProject: (
			projectSlug: string,
		) => Effect.Effect<WsRpcSockets, never, never>;
	}
>() {}

interface OpenPair {
	readonly projectSlug: string;
	readonly sockets: WsRpcSockets;
	readonly close: Effect.Effect<void>;
}

const make = (connect: WsRpcConnect) =>
	Effect.gen(function* () {
		// The layer's scope — i.e. the app-lifetime runtime. Disposing the runtime
		// closes every pair opened below.
		const appScope = yield* Effect.scope;
		const current = yield* Ref.make<OpenPair | undefined>(undefined);
		// Serialises get-or-open, so two concurrent callers cannot race four
		// sockets open for one project.
		const lock = yield* Effect.makeSemaphore(1);

		const open = (
			projectSlug: string,
			scope: Scope.CloseableScope,
		): Effect.Effect<OpenPair> =>
			Effect.gen(function* () {
				const url = makeWsRpcUrl(projectSlug);
				const [control, stream] = yield* Effect.all([
					connect({ url, trafficClass: "control" }),
					connect({ url, trafficClass: "stream" }),
				]).pipe(Scope.extend(scope));
				return {
					projectSlug,
					sockets: { control, stream },
					close: Scope.close(scope, Exit.void),
				};
			});

		return {
			// ni8.5.9 (T-3) hangs client-side resume here: the high-water-mark ref
			// belongs beside the pair opened above, so every subscription — now and
			// in ni8.9/10/11/14 — inherits re-issue-on-protocol-error for free.
			forProject: (projectSlug: string) =>
				lock.withPermits(1)(
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							const existing = yield* Ref.get(current);
							if (existing?.projectSlug === projectSlug) {
								return existing.sockets;
							}
							// Drop the cache before anything can fail. A closed or half-open
							// pair must never stay reachable, and an empty cache costs only a
							// reopen on the next call.
							yield* Ref.set(current, undefined);
							if (existing) {
								yield* existing.close;
							}
							// Closing and publication must finish even if the caller cancels.
							// Only acquisition is interruptible; its entire handoff is covered
							// by cleanup, including a successful connect interrupted on return.
							const scope = yield* Scope.fork(
								appScope,
								ExecutionStrategy.sequential,
							);
							const next = yield* restore(open(projectSlug, scope)).pipe(
								Effect.onExit((exit) =>
									Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
								),
							);
							yield* Ref.set(current, next);
							return next.sockets;
						}),
					),
				),
		};
	});

/** The shared client over a caller-supplied transport. Test seam. */
export const makeWsRpcClientsLayer = (
	connect: WsRpcConnect,
): Layer.Layer<WsRpcClients> => Layer.scoped(WsRpcClients, make(connect));

/** The shared client over real WebSockets. Mounted by the transport runtime. */
export const WsRpcClientsLayer = makeWsRpcClientsLayer(connectWebSocket);
