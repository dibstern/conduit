// One RPC client pair for the whole app, carried over exactly two WebSockets:
//
//   control — unary calls plus low-rate subscriptions (the shell)
//   stream  — hot streams: session detail and the project's PTYs (ni8.11)
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
// client to change it — the per-call override stays available to the PTY
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
	Schedule,
	Scope,
} from "effect";
import {
	markControlSocketOpen,
	trackControlSocket,
} from "./connection-status.svelte.js";
import { resumeStream } from "./resume.js";
import { decodeSessionDetail } from "./session-detail-wire.js";
import { WsRpcGroup } from "./ws-rpc.js";

export interface WsRpcLocation {
	readonly protocol: string;
	readonly host: string;
}

export const makeWsRpcUrl = (
	location: WsRpcLocation = globalThis.location,
): string => {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/rpc`;
};

/** Which of the two sockets a caller's traffic belongs on. */
export type TrafficClass = "control" | "stream";

// The client description, reused by every transport below: an Effect is a
// description, so providing it twice yields two independent clients.
const wsRpcClient = RpcClient.make(WsRpcGroup);

export type WsRpcClient = Effect.Effect.Success<typeof wsRpcClient>;

// Subscriptions are handed out already resuming, and already on the right
// socket, because both are transport decisions a consumer should not be able to
// get wrong. A consumer that reached for `sockets.stream.SubscribeSessionDetail`
// would get a stream that dies on the first drop; there is no reason to leave
// that door open, so ni8.9/10/11/14 add a member here rather than a call site.
const makeSubscriptions = (
	projectSlug: string,
	sockets: { readonly control: WsRpcClient; readonly stream: WsRpcClient },
) => ({
	/** The session list. Low-rate, so it rides the control socket. */
	shell: (
		options: {
			readonly resumeFromSequence?: number;
			readonly onTransportDrop?: () => void;
		} = {},
	) =>
		resumeStream(
			(resumeFromSequence) =>
				sockets.control.SubscribeShell({
					projectSlug,
					...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
				}),
			{
				...(options.resumeFromSequence === undefined
					? {}
					: { from: options.resumeFromSequence }),
				...(options.onTransportDrop === undefined
					? {}
					: { onTransportDrop: options.onTransportDrop }),
			},
		),
	/** The project's pending permissions and questions, on the control socket. */
	approvals: (options: { readonly onTransportDrop?: () => void } = {}) =>
		resumeStream(
			(resumeFromSequence) =>
				sockets.control.SubscribeApprovals({
					projectSlug,
					...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
				}),
			options,
		),
	/** One session's transcript. Hot, so it rides the stream socket. */
	sessionDetail: (options: {
		readonly sessionId: string;
		readonly resumeFromSequence?: number;
	}) =>
		resumeStream(
			(resumeFromSequence) =>
				sockets.stream
					.SubscribeSessionDetail({
						projectSlug,
						sessionId: options.sessionId,
						textSuffixes: true,
						...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
					})
					.pipe(decodeSessionDetail),
			{ from: options.resumeFromSequence },
		),
	/** One session's todo list. Low-rate, so it rides the control socket. */
	todos: (options: { readonly sessionId: string }) =>
		resumeStream((resumeFromSequence) =>
			sockets.control.SubscribeSessionTodos({
				projectSlug,
				sessionId: options.sessionId,
				...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
			}),
		),
	/** The family (root and descendants) of one session. Session-row metadata
	 *  at shell rate, not a hot stream, so it rides the control socket. */
	family: (options: { readonly sessionId: string }) =>
		resumeStream((resumeFromSequence) =>
			sockets.control.SubscribeSessionFamily({
				projectSlug,
				sessionId: options.sessionId,
				...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
			}),
		),
	/**
	 * The project's terminals. Hot, so it rides the stream socket. PTYs carry no
	 * sequence, so every re-issue is a cold snapshot with each scrollback ring.
	 */
	ptys: () => resumeStream(() => sockets.stream.SubscribePtys({ projectSlug })),
	/** Default model, visibility, default approval mode, Claude overrides.
	 *  Not in the read model, so a re-issue re-snapshots instead of resuming. */
	projectSettings: () =>
		resumeStream(() =>
			sockets.control.SubscribeProjectSettings({ projectSlug }),
		),
	/** Done/error alerts for sessions no tab is viewing. Live-only: a re-issue
	 *  never replays one, so a reconnect cannot re-fire a ding. */
	alerts: () =>
		resumeStream(() => sockets.control.SubscribeAlerts({ projectSlug })),
	/** One session's composer draft as other tabs type it. Live-only. */
	inputDraft: (options: { readonly sessionId: string }) =>
		resumeStream(() =>
			sockets.control.SubscribeInputDraft({
				projectSlug,
				sessionId: options.sessionId,
			}),
		),
	/**
	 * The daemon's instance and project lists. Daemon-global, so neither takes
	 * the project; low-rate, so both ride the control socket.
	 */
	instances: () => resumeStream(() => sockets.control.SubscribeInstances({})),
	usage: () => resumeStream(() => sockets.control.SubscribeUsage({})),
	projects: () => resumeStream(() => sockets.control.SubscribeProjects({})),
	/** The daemon's protocol, build and restart state, plus a revision that
	 *  moves when the cross-project session lists go stale. */
	serverStatus: (options: { readonly onTransportDrop?: () => void } = {}) =>
		resumeStream(() => sockets.control.SubscribeServerStatus({}), options),
});

/** Every stream subscription the frontend has, resume already applied. */
export type WsRpcSubscriptions = ReturnType<typeof makeSubscriptions>;

export interface WsRpcSockets {
	/** Unary calls and low-rate subscriptions. The 49 helpers move here in S-6. */
	readonly control: WsRpcClient;
	/** Hot streams: session detail and the project's PTYs. */
	readonly stream: WsRpcClient;
	/** Subscriptions over the pair, each resuming from its own high-water mark. */
	readonly subscriptions: WsRpcSubscriptions;
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
//
// Redials are capped at one second, not the library's five. Every unary read
// waits for the control socket to be back (session-list.svelte.ts re-runs them
// on `synchronized`), so after a restart the five-second cap meant up to five
// seconds of stale panels. One local daemon can absorb the extra dials.
const reconnectSchedule = Schedule.exponential("100 millis", 1.5).pipe(
	Schedule.union(Schedule.spaced("1 second")),
);

// After a drop the protocol refuses every request until its own `onOpen` clears
// the stored error, which runs after the raw "open" event. Reporting connected
// from that hook, not the raw event, means a caller that reacts to `connected`
// (ChatLayout loading the file tree) is never refused.
const controlSocket = (url: string) =>
	Layer.effect(
		Socket.Socket,
		Effect.map(
			Socket.makeWebSocket(url),
			(socket): Socket.Socket => ({
				...socket,
				runRaw: (handler, options) =>
					socket.runRaw(handler, {
						onOpen: Effect.zipRight(
							options?.onOpen ?? Effect.void,
							Effect.sync(markControlSocketOpen),
						),
					}),
			}),
		),
	).pipe(
		Layer.provide(
			Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
				const socket = new globalThis.WebSocket(url, protocols);
				trackControlSocket(socket);
				return socket;
			}),
		),
	);

const connectWebSocket: WsRpcConnect = ({ url, trafficClass }) =>
	Layer.build(
		RpcClient.layerProtocolSocket({ retrySchedule: reconnectSchedule }).pipe(
			Layer.provide(
				trafficClass === "control"
					? controlSocket(url)
					: Socket.layerWebSocket(url).pipe(
							Layer.provide(Socket.layerWebSocketConstructorGlobal),
						),
			),
			Layer.provide(RpcSerialization.layerJson),
		),
	).pipe(Effect.flatMap((protocol) => Effect.provide(wsRpcClient, protocol)));

export class WsRpcClients extends Context.Tag("WsRpcClients")<
	WsRpcClients,
	{
		/**
		 * The app's one socket pair, opened on first use and kept for the
		 * runtime's lifetime, with subscriptions bound to `projectSlug`. The
		 * server routes by payload, not by connection, so every project shares
		 * the pair. A project switch must not reopen it: closing the pair fails
		 * every in-flight call and flips `connected`, which re-runs the effects
		 * that issued those calls (the switch-projects ping-pong).
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

type SocketPair = Pick<WsRpcSockets, "control" | "stream">;

const make = (connect: WsRpcConnect) =>
	Effect.gen(function* () {
		// The layer's scope — i.e. the app-lifetime runtime. Disposing the runtime
		// closes the pair opened below.
		const appScope = yield* Effect.scope;
		const current = yield* Ref.make<SocketPair | undefined>(undefined);
		// Serialises get-or-open, so two concurrent callers cannot race four
		// sockets open.
		const lock = yield* Effect.makeSemaphore(1);

		const pair = lock.withPermits(1)(
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const existing = yield* Ref.get(current);
					if (existing) return existing;
					// Only acquisition is interruptible; a failed or interrupted open
					// closes its own scope, so a half-open pair is never published.
					const scope = yield* Scope.fork(
						appScope,
						ExecutionStrategy.sequential,
					);
					const url = makeWsRpcUrl();
					const [control, stream] = yield* restore(
						Effect.all([
							connect({ url, trafficClass: "control" }),
							connect({ url, trafficClass: "stream" }),
						]).pipe(Scope.extend(scope)),
					).pipe(
						Effect.onExit((exit) =>
							Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
						),
					);
					const next = { control, stream };
					yield* Ref.set(current, next);
					return next;
				}),
			),
		);

		return {
			forProject: (projectSlug: string) =>
				Effect.map(pair, (sockets) => ({
					...sockets,
					subscriptions: makeSubscriptions(projectSlug, sockets),
				})),
		};
	});

/** The shared client over a caller-supplied transport. Test seam. */
export const makeWsRpcClientsLayer = (
	connect: WsRpcConnect,
): Layer.Layer<WsRpcClients> => Layer.scoped(WsRpcClients, make(connect));

/** The shared client over real WebSockets. Mounted by the transport runtime. */
export const WsRpcClientsLayer = makeWsRpcClientsLayer(connectWebSocket);
