// ─── Relay State Layer ──────────────────────────────────────────────────────
// Composes all Effect-native state Layers into a single merged Layer.
// These provide the state Tags that Effect handler functions use.
//
// External deps provided by caller: OpenCodeAPITag, ConfigTag, LoggerTag,
// provider instances, persistence, and transport services.

import { Layer } from "effect";
import { DaemonEventBusLive } from "../../daemon/Services/daemon-pubsub.js";
import { makeInstanceManagerStateLive } from "../../daemon/Services/instance-manager-service.js";
import { ClientMessageSerializationLive } from "../Services/client-message-serialization.js";
import { makePollerManagerStateLive } from "../Services/message-poller.js";
import { PtyManagerStateLive } from "../Services/pty-manager-service.js";
import { RelayEventBusLive } from "../Services/relay-event-bus.js";
import { RelayStatusSnapshotLive } from "../Services/relay-status-snapshot.js";
import { SessionManagerServiceLive } from "../Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../Services/session-manager-state.js";
import { makeOverridesStateLive } from "../Services/session-overrides-state.js";
import { makeSessionRegistryStateLive } from "../Services/session-registry-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
} from "../Services/session-status-poller.js";
import { SessionTitleServiceLive } from "../Services/session-title-service.js";
import { makeWsHandlerStateLive } from "../Services/ws-handler-service.js";
import { RateLimiterLive } from "./rate-limiter-layer.js";

const sessionManagerDepsLive = Layer.mergeAll(
	makeSessionManagerStateLive(),
	DaemonEventBusLive,
	RelayStatusSnapshotLive,
);

const SessionManagerStateAndServiceLive = Layer.provideMerge(
	SessionManagerServiceLive,
	sessionManagerDepsLive,
);

const SessionManagerStateServiceAndTitleLive = Layer.provideMerge(
	SessionTitleServiceLive,
	SessionManagerStateAndServiceLive,
);

/**
 * Composed Layer providing all Effect-native state Tags.
 *
 * All layers here are self-constructing — they create their own Ref, FiberMap,
 * PubSub, etc. No imperative instance is needed.
 *
 * Keep new relay state in self-constructing Layers here, or in a focused
 * service Layer merged here, so relay-stack does not regain prebuilt service
 * instance wiring.
 */
export const RelayStateLive = Layer.mergeAll(
	// Session state
	makeSessionRegistryStateLive(),
	makeOverridesStateLive(),
	SessionManagerStateServiceAndTitleLive,
	// Poller state
	makePollerManagerStateLive(),
	makePollerStateLive(),
	makePollerPubSubLive(),
	// WebSocket handler state
	makeWsHandlerStateLive(),
	ClientMessageSerializationLive,
	// Per-relay domain event fanout
	RelayEventBusLive,
	// PTY state
	PtyManagerStateLive,
	// Instance management state
	makeInstanceManagerStateLive(),
	// Rate limiter (scoped — cleanup fiber runs every 60s)
	RateLimiterLive({ maxRequests: 5, windowMs: 10_000 }),
);
