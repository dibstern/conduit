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

import {
	Context,
	Duration,
	Effect,
	Exit,
	Layer,
	Ref,
	Schedule,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import type { SessionDetailEnvelope } from "../../contracts/ws-rpc.js";
import {
	markControlSocketOpen,
	trackControlSocket,
} from "./connection-status.svelte.js";
import { makeResumeLedger, type ResumeLedger, resumeStream } from "./resume.js";
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
const wsRpcClient = RpcClient.make(WsRpcGroup, { flatten: true });

export type WsRpcClient = Effect.Success<typeof wsRpcClient>;

// Subscriptions are handed out already resuming, and already on the right
// socket, because both are transport decisions a consumer should not be able to
// get wrong. A consumer that reached for `sockets.stream("SubscribeSessionDetail", ...)`
// would get a stream that dies on the first drop; there is no reason to leave
// that door open, so ni8.9/10/11/14 add a member here rather than a call site.
const makeSubscriptions = (
	projectSlug: string,
	sockets: { readonly control: WsRpcClient; readonly stream: WsRpcClient },
) => ({
	/** Cached snapshots, including an automatic recap finishing after the turn. */
	recaps: (options: { readonly sessionId: string; readonly turnId: string }) =>
		resumeStream(() => sockets.control("SubscribeRecaps", options)),
	/** The session list. Low-rate, so it rides the control socket. */
	shell: (
		options: {
			readonly resumeFromSequence?: number;
			readonly onTransportDrop?: () => void;
		} = {},
	) =>
		resumeStream(
			(resumeFromSequence, resumeBase, resumePoint) =>
				sockets.control("SubscribeShell", {
					...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
					...(resumeBase === undefined ? {} : { resumeBase }),
					...(resumePoint === undefined ? {} : { resumePoint }),
				}),
			{
				ledger: makeResumeLedger(),
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
				sockets.control("SubscribeApprovals", {
					projectSlug,
					...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
				}),
			options,
		),
	/** One session's transcript. Hot, so it rides the stream socket. */
	sessionDetail: (options: {
		readonly sessionId: string;
		readonly resumeFromSequence?: number;
		/** What the view resumed from has applied; the caller keeps it with
		 *  the view, so a resume from its high-water mark is checked too. */
		readonly ledger?: ResumeLedger;
		/** A snapshot saved by an earlier page load, delivered first. */
		readonly saved?: SessionDetailEnvelope | undefined;
		/** Called after starting the detail RPC, before its first envelope. */
		readonly onSubscribe?: () => void;
	}) =>
		resumeStream(
			(resumeFromSequence, resumeBase, resumePoint) =>
				Stream.unwrap(
					Effect.map(
						sockets.stream(
							"SubscribeSessionDetail",
							{
								sessionId: options.sessionId,
								...(resumeFromSequence === undefined
									? {}
									: { resumeFromSequence }),
								...(resumeBase === undefined ? {} : { resumeBase }),
								...(resumePoint === undefined ? {} : { resumePoint }),
							},
							{ asQueue: true },
						),
						(queue) => {
							options.onSubscribe?.();
							return Stream.fromQueue(queue);
						},
					),
				).pipe(decodeSessionDetail),
			{
				from: options.resumeFromSequence,
				ledger: options.ledger ?? makeResumeLedger(),
				saved: options.saved,
			},
		),
	/** One session's todo list. Low-rate, so it rides the control socket. */
	todos: (options: { readonly sessionId: string }) =>
		resumeStream((resumeFromSequence) =>
			sockets.control("SubscribeSessionTodos", {
				sessionId: options.sessionId,
				...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
			}),
		),
	/** The family (root and descendants) of one session. Session-row metadata
	 *  at shell rate, not a hot stream, so it rides the control socket. */
	family: (options: { readonly sessionId: string }) =>
		resumeStream((resumeFromSequence) =>
			sockets.control("SubscribeSessionFamily", {
				sessionId: options.sessionId,
				...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
			}),
		),
	/**
	 * The project's terminals. Hot, so it rides the stream socket. PTYs carry no
	 * sequence, so every re-issue is a cold snapshot with each scrollback ring.
	 */
	ptys: () =>
		resumeStream(() => sockets.stream("SubscribePtys", { projectSlug })),
	/** Default model, visibility, default approval mode, Claude overrides.
	 *  Not in the read model, so a re-issue re-snapshots instead of resuming. */
	projectSettings: () =>
		resumeStream(() =>
			sockets.control("SubscribeProjectSettings", { projectSlug }),
		),
	/** This draft's OpenCode inventory also retains its borrowed instance. */
	draftModels: (instanceId: string) =>
		resumeStream(() =>
			sockets.control("SubscribeDraftModels", { projectSlug, instanceId }),
		),
	/** Done/error alerts for sessions no tab is viewing. Live-only: a re-issue
	 *  never replays one, so a reconnect cannot re-fire a ding. */
	alerts: () =>
		resumeStream(() => sockets.control("SubscribeAlerts", { projectSlug })),
	/** One session's composer draft as other tabs type it. Live-only. */
	inputDraft: (options: { readonly sessionId: string }) =>
		resumeStream(() =>
			sockets.control("SubscribeInputDraft", {
				sessionId: options.sessionId,
			}),
		),
	/**
	 * The daemon's instance list and usage. Both ride the control socket.
	 */
	instances: () =>
		resumeStream(() => sockets.control("SubscribeInstances", {})),
	usage: () => resumeStream(() => sockets.control("SubscribeUsage", {})),
	/** The daemon's protocol, build and restart state, plus a revision that
	 *  moves when the cross-project session lists go stale. */
	serverStatus: (options: { readonly onTransportDrop?: () => void } = {}) =>
		resumeStream(() => sockets.control("SubscribeServerStatus", {}), options),
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
	readonly wake?: {
		readonly version: number;
		readonly wait: (after: number) => Effect.Effect<void>;
		readonly signal: EventTarget;
	};
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
const reconnectSchedule = Schedule.min([
	Schedule.exponential("100 millis", 1.5),
	Schedule.spaced("1 second"),
]);

// A redial may reach a daemon from another build, whose RPC wire this tab may
// not decode. Every redial after a socket has opened first asks the server's
// build over plain HTTP (registered by server-status, which owns the reload);
// the check resolves only when this tab may dial. The first dial skips it: the
// daemon that served this page is the one it dials.
let redialBuildCheck: () => Promise<void> = async () => {};
export const setRedialBuildCheck = (check: () => Promise<void>) => {
	redialBuildCheck = check;
};

const connectWebSocket: WsRpcConnect = ({ url, trafficClass, wake }) => {
	let wakeVersion = wake?.version ?? 0;
	let currentSocket: WebSocket | undefined;
	let opened = false;
	const onCreate = (socket: WebSocket) => {
		currentSocket = socket;
		wakeVersion = wake?.version ?? 0;
		socket.addEventListener("open", () => {
			opened = true;
		});
	};
	const checkedUrl = Effect.promise(async () => {
		if (opened) await redialBuildCheck();
		return url;
	});
	const onWake = () => {
		// Ignore healthy wakes, but keep a wake during CLOSING: tab visibility
		// may close a stale socket before its asynchronous close event arrives.
		if (currentSocket?.readyState === 1) wakeVersion = wake?.version ?? 0;
	};
	const retrySchedule = reconnectSchedule.pipe(
		Schedule.modifyDelay(({ duration: delay }) =>
			Effect.suspend(() => {
				if (wake === undefined) return Effect.succeed(delay);
				if (wake.version !== wakeVersion) {
					wakeVersion = wake.version;
					return Effect.succeed(Duration.zero);
				}
				// The schedule driver sleeps after this callback. Race the wait here
				// and return zero so an event can interrupt a delay already in flight.
				return Effect.race(Effect.sleep(delay), wake.wait(wakeVersion)).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							wakeVersion = wake.version;
						}),
					),
					Effect.as(Duration.zero),
				);
			}),
		),
	);
	return Effect.andThen(
		wake === undefined
			? Effect.void
			: Effect.acquireRelease(
					Effect.sync(() => wake.signal.addEventListener("wake", onWake)),
					() =>
						Effect.sync(() => wake.signal.removeEventListener("wake", onWake)),
				),
		Layer.build(
			RpcClient.layerProtocolSocket({ retryPolicy: retrySchedule }).pipe(
				Layer.provide(
					Layer.effect(Socket.Socket, Socket.makeWebSocket(checkedUrl)).pipe(
						Layer.provide(
							Layer.succeed(Socket.WebSocketConstructor, (url) => {
								const socket = new globalThis.WebSocket(url);
								onCreate(socket);
								if (trafficClass === "control") trackControlSocket(socket);
								return socket;
							}),
						),
					),
				),
				// The protocol clears its stored error before onConnect. A caller
				// reacting to `connected` can therefore issue requests immediately.
				Layer.provide(
					Layer.succeed(RpcClient.ConnectionHooks, {
						onConnect:
							trafficClass === "control"
								? Effect.sync(markControlSocketOpen)
								: Effect.void,
						onDisconnect: Effect.void,
					}),
				),
				Layer.provide(RpcSerialization.layerJson),
			),
		).pipe(Effect.flatMap((protocol) => Effect.provide(wsRpcClient, protocol))),
	);
};

export class WsRpcClients extends Context.Service<
	WsRpcClients,
	{
		/** Skip both sockets' current redial wait without closing healthy sockets. */
		readonly wake: Effect.Effect<void>;
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
>()("WsRpcClients") {}

type SocketPair = Pick<WsRpcSockets, "control" | "stream">;

const make = (connect: WsRpcConnect) =>
	Effect.gen(function* () {
		// The layer's scope — i.e. the app-lifetime runtime. Disposing the runtime
		// closes the pair opened below.
		const appScope = yield* Effect.scope;
		const wakes = new EventTarget();
		let wakeVersion = 0;
		const notifyWake = () => {
			wakeVersion++;
			wakes.dispatchEvent(new Event("wake"));
		};
		const wake = {
			signal: wakes,
			get version() {
				return wakeVersion;
			},
			wait: (after: number) =>
				Effect.callback<void>((resume) => {
					const cleanup = Effect.sync(() =>
						wakes.removeEventListener("wake", onWake),
					);
					const onWake = () => resume(cleanup);
					wakes.addEventListener("wake", onWake);
					// The race's child may start after the wake already fired.
					if (wakeVersion !== after) onWake();
					return cleanup;
				}),
		};
		const onVisible = () => {
			if (globalThis.document?.visibilityState === "visible") notifyWake();
		};
		globalThis.document?.addEventListener("visibilitychange", onVisible);
		globalThis.window?.addEventListener("online", notifyWake);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				globalThis.document?.removeEventListener("visibilitychange", onVisible);
				globalThis.window?.removeEventListener("online", notifyWake);
			}),
		);
		const current = yield* Ref.make<SocketPair | undefined>(undefined);
		// Serialises get-or-open, so two concurrent callers cannot race four
		// sockets open.
		const lock = yield* Semaphore.make(1);

		const pair = lock.withPermits(1)(
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const existing = yield* Ref.get(current);
					if (existing) return existing;
					// Only acquisition is interruptible; a failed or interrupted open
					// closes its own scope, so a half-open pair is never published.
					const scope = yield* Scope.fork(appScope, "sequential");
					const url = makeWsRpcUrl();
					const [control, stream] = yield* restore(
						Effect.all([
							connect({ url, trafficClass: "control", wake }),
							connect({ url, trafficClass: "stream", wake }),
						]).pipe(Scope.provide(scope)),
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
			wake: Effect.sync(notifyWake),
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
): Layer.Layer<WsRpcClients> => Layer.effect(WsRpcClients, make(connect));

/** The shared client over real WebSockets. Mounted by the transport runtime. */
export const WsRpcClientsLayer = makeWsRpcClientsLayer(connectWebSocket);
