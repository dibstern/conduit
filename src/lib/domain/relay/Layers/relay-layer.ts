// ─── Relay State Layer ──────────────────────────────────────────────────────
// Composes all Effect-native state Layers into a single merged Layer.
// These provide the state Tags that Effect handler functions use.
//
// Bridge Tags (for old imperative consumers) are still provided via
// Layer.succeed(Tag, instance) in relay-stack.ts during the transition.
// They are deleted incrementally as consumers move to Effect-owned services.
//
// External deps provided by caller: OpenCodeAPITag, ConfigTag, LoggerTag,
// and all bridge Tags.

import { Layer } from "effect";
import { DaemonEventBusLive } from "../../daemon/Services/daemon-pubsub.js";
import { makeInstanceManagerStateLive } from "../../daemon/Services/instance-manager-service.js";
import { ClientMessageSerializationLive } from "../Services/client-message-serialization.js";
import { makePollerManagerStateLive } from "../Services/message-poller.js";
import { PtyManagerStateLive } from "../Services/pty-manager-service.js";
import { RelayEventBusLive } from "../Services/relay-event-bus.js";
import { SessionManagerServiceLive } from "../Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../Services/session-manager-state.js";
import { makeOverridesStateLive } from "../Services/session-overrides-state.js";
import { makeSessionRegistryStateLive } from "../Services/session-registry-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
} from "../Services/session-status-poller.js";
import { makeWsHandlerStateLive } from "../Services/ws-handler-service.js";
import { RateLimiterLive } from "./rate-limiter-layer.js";

const sessionManagerDepsLive = Layer.mergeAll(
	makeSessionManagerStateLive(),
	DaemonEventBusLive,
);

const SessionManagerStateAndServiceLive = Layer.provideMerge(
	SessionManagerServiceLive,
	sessionManagerDepsLive,
);

/**
 * Composed Layer providing all Effect-native state Tags.
 *
 * All layers here are self-constructing — they create their own Ref, FiberMap,
 * PubSub, etc. No imperative instance is needed.
 *
 * Consumers of remaining bridge Tags (PollerManagerTag,
 * etc.) still get them from Layer.succeed() in relay-stack.ts. Those bridge
 * layers are merged alongside RelayStateLive when creating the full runtime.
 */
export const RelayStateLive = Layer.mergeAll(
	// Session state
	makeSessionRegistryStateLive(),
	makeOverridesStateLive(),
	SessionManagerStateAndServiceLive,
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
