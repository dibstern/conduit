// Composes all Effect-native state Layers into a single merged Layer.
// These provide the state Tags that Effect handler functions use.
//
// External deps provided by caller: OpenCodeAPITag, ConfigTag, LoggerTag,
// provider instances, persistence, and transport services.

import { Layer } from "effect";
import { DaemonEventBusLive } from "../../daemon/Services/daemon-pubsub.js";
import { makeOpenCodeRuntimeStateLive } from "../../daemon/Services/instance-manager-service.js";
import { AlertsLive } from "../Services/alerts.js";
import { InputDraftsLive } from "../Services/input-drafts.js";
import { makePollerManagerStateLive } from "../Services/message-poller.js";
import { ProjectSettingsLive } from "../Services/project-settings.js";
import { PtyManagerStateLive } from "../Services/pty-manager-service.js";
import { RelayEventBusLive } from "../Services/relay-event-bus.js";
import { RelayStatusSnapshotLive } from "../Services/relay-status-snapshot.js";
import {
	SessionEventBusLive,
	type SessionEventBusTag,
} from "../Services/session-event-bus.js";
import { SessionManagerServiceLive } from "../Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../Services/session-manager-state.js";
import { makeOverridesStateLive } from "../Services/session-overrides-state.js";
import { makeSessionRegistryStateLive } from "../Services/session-registry-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
} from "../Services/session-status-poller.js";
import { makeSessionTitleServiceLive } from "../Services/session-title-service.js";
import { RateLimiterLive } from "./rate-limiter-layer.js";

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
export const makeRelayStateLive = (
	options: {
		/** Process-fake benchmark capacity; ordinary relays retain five sends/10s. */
		readonly testSendLimit?: number;
		/** Daemon relays borrow the daemon bus; standalone relays own a local bus. */
		readonly sessionEventBusLayer?: Layer.Layer<SessionEventBusTag>;
	} = {},
) => {
	const sessionEventBusLayer =
		options.sessionEventBusLayer ?? SessionEventBusLive;
	const sessionManagerStateAndServiceLive = SessionManagerServiceLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
				sessionEventBusLayer,
				RelayStatusSnapshotLive,
			),
		),
	);
	return Layer.mergeAll(
		// Session state
		makeSessionRegistryStateLive(),
		Layer.provideMerge(
			makeSessionTitleServiceLive(),
			Layer.mergeAll(
				ProjectSettingsLive,
				Layer.provideMerge(
					sessionManagerStateAndServiceLive,
					makeOverridesStateLive(),
				),
			),
		),
		// Poller state
		makePollerManagerStateLive(),
		makePollerStateLive(),
		makePollerPubSubLive(),
		// Per-relay domain event fanout
		RelayEventBusLive,
		// Committed-event change signal, shared by daemon relays.
		sessionEventBusLayer,
		// Per-relay alert and composer-draft fanout (live-only subscriptions)
		AlertsLive,
		InputDraftsLive,
		// PTY state
		PtyManagerStateLive,
		// Instance management state
		makeOpenCodeRuntimeStateLive(),
		// Rate limiter (scoped — cleanup fiber runs every 60s)
		RateLimiterLive({
			maxRequests: options.testSendLimit ?? 5,
			windowMs: 10_000,
		}),
	);
};

export const RelayStateLive = makeRelayStateLive();
