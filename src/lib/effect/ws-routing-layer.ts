// ─── WebSocket Routing Layer ────────────────────────────────────────────────
// Scoped Layer that handles WebSocket upgrade routing.
//
// Attaches an HTTP server "upgrade" listener that:
//   1. Validates the URL matches /p/{slug}/ws
//   2. Authenticates WS upgrade requests (cookies, PIN headers)
//   3. Calls ensureRelayStarted(slug) for lazy relay startup
//   4. Waits up to 10s for the relay to become ready
//   5. Writes HTTP/1.1 503\r\n\r\n on relay wait failure
//   6. Checks shuttingDown from DaemonConfigRefTag
//
// Dependencies:
//   - DaemonConfigRefTag — runtime config (shuttingDown, etc.)
//   - HttpServerRefTag — Ref<http.Server | null> from relay-factory-layer
//   - AuthManagerTag — WS auth validation
//   - ProjectRegistryTag — ensureRelayStarted, waitForRelay, touchLastUsed
//
// The upgrade listener is registered as a scoped resource: when the Layer's
// scope closes, the listener is removed from the HTTP server.
//
// (AP-32)

// NOTE: The following imports are commented out until Task 11/12 wires
// the full upgrade handler. They document the dependencies the handler
// will need:
//
// import type http from "node:http";
// import type net from "node:net";
// import { parseCookies } from "../server/http-utils.js";
// import {
// 	isStarting, startRelay, touchLastUsed, waitForRelay,
// } from "./project-registry-service.js";

import { Effect, Layer } from "effect";
import { AuthManagerTag } from "./auth-middleware.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { HttpServerRefTag } from "./relay-factory-layer.js";

// ─── WebSocketRoutingLive ──────────────────────────────────────────────────

/**
 * Scoped Layer that attaches the WebSocket upgrade handler to the HTTP server.
 *
 * The handler authenticates requests, lazy-starts relays, waits for relay
 * readiness, and hands off to the relay's WS handler on success.
 *
 * Finalizer removes the upgrade listener to prevent leaks in tests.
 */
export const WebSocketRoutingLive: Layer.Layer<
	never,
	never,
	DaemonConfigRefTag | HttpServerRefTag | AuthManagerTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const _configRef = yield* DaemonConfigRefTag;
		const _httpServerRef = yield* HttpServerRefTag;
		const _auth = yield* AuthManagerTag;

		// The HTTP server may not be ready yet at Layer build time —
		// the upgrade handler reads it lazily from the Ref.
		// This is a structural stub: the actual upgrade handler will be
		// wired to the relay infrastructure in Task 11/12.

		yield* Effect.logInfo("WebSocket routing layer initialized");

		// NOTE: The full upgrade handler (attaching to httpServer.on("upgrade"))
		// requires deep integration with the imperative relay registry
		// (ensureRelayStarted, waitForRelay returning ProjectRelay with wsHandler).
		// That wiring is deferred to Task 11/12.
		//
		// When ready, the handler will:
		// 1. Read server from HttpServerRefTag
		// 2. Attach "upgrade" listener
		// 3. Inside listener:
		//    a. Parse /p/{slug}/ws from URL
		//    b. Check auth via AuthManagerTag (cookies + PIN header)
		//    c. Check shuttingDown from DaemonConfigRefTag
		//    d. ensureRelayStarted(slug)
		//    e. waitForRelay(slug, 10_000)
		//    f. touchLastUsed(slug)
		//    g. relay.wsHandler.handleUpgrade(req, socket, head)
		//    h. On failure: socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n")

		yield* Effect.addFinalizer(() =>
			Effect.logInfo("WebSocket routing layer torn down"),
		);
	}).pipe(
		Effect.annotateLogs("component", "ws-routing"),
		Effect.withSpan("WebSocketRoutingLive"),
	),
);
