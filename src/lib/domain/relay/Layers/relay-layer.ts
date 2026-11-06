// Composes all Effect-native state Layers into a single merged Layer.
// These provide the state Tags that Effect handler functions use.
//
// External deps provided by caller: ConfigTag, LoggerTag,
// provider instances, persistence, and transport services.

import { Layer } from "effect";
import { DaemonEventBusLive } from "../../daemon/Services/daemon-pubsub.js";
import { makeOpenCodeRuntimeStateLive } from "../../daemon/Services/instance-manager-service.js";
import { AlertsLive, type AlertsTag } from "../Services/alerts.js";
import { InputDraftsLive } from "../Services/input-drafts.js";
import {
	ProjectSettingsLive,
	type ProjectSettingsTag,
} from "../Services/project-settings.js";
import { PtyManagerStateLive } from "../Services/pty-manager-service.js";
import { RelayEventBusLive } from "../Services/relay-event-bus.js";
import {
	RelayStatusSnapshotLive,
	type RelayStatusSnapshotTag,
} from "../Services/relay-status-snapshot.js";
import {
	SessionEventBusLive,
	type SessionEventBusTag,
} from "../Services/session-event-bus.js";
import {
	makeSessionManagerCoordination,
	makeSessionManagerStateLive,
	SessionManagerCoordinationTag,
	type SessionManagerStateTag,
} from "../Services/session-manager-state.js";
import {
	makeOverridesStateLive,
	type OverridesStateTag,
} from "../Services/session-overrides-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
} from "../Services/session-status-poller.js";
import {
	makeSessionTitleServiceLive,
	type SessionTitleServiceTag,
} from "../Services/session-title-service.js";
import { RateLimiterLive, type RateLimiterTag } from "./rate-limiter-layer.js";

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
		/** Daemon relays borrow the project's settings and titles (82tn.16). */
		readonly titlesLayer?: Layer.Layer<
			ProjectSettingsTag | SessionTitleServiceTag,
			never,
			Layer.Services<ReturnType<typeof makeSessionTitleServiceLive>>
		>;
		/** Borrowing relays must leave session overrides and timers with the daemon. */
		readonly overridesStateLayer?: Layer.Layer<OverridesStateTag>;
		/** Daemon relays borrow the project's session manager state from the daemon. */
		readonly sessionManagerStateLayer?: Layer.Layer<
			SessionManagerStateTag | SessionManagerCoordinationTag
		>;
		/** Daemon relays publish to the daemon's one alert feed. */
		readonly alertsLayer?: Layer.Layer<AlertsTag>;
		/** Daemon relays share the project's status snapshot with the daemon. */
		readonly statusSnapshotLayer?: Layer.Layer<RelayStatusSnapshotTag>;
		/** Daemon relays count sends against the daemon's one limiter. */
		readonly rateLimiterLayer?: Layer.Layer<RateLimiterTag>;
	} = {},
) => {
	const sessionEventBusLayer =
		options.sessionEventBusLayer ?? SessionEventBusLive;
	// The session manager itself is the daemon's; a standalone relay's own reads these parts.
	const sessionManagerParts = Layer.mergeAll(
		options.sessionManagerStateLayer ??
			Layer.merge(
				makeSessionManagerStateLive(),
				Layer.effect(
					SessionManagerCoordinationTag,
					makeSessionManagerCoordination(),
				),
			),
		DaemonEventBusLive,
		sessionEventBusLayer,
		options.statusSnapshotLayer ?? RelayStatusSnapshotLive,
	);
	return Layer.mergeAll(
		// Session state
		options.titlesLayer ??
			makeSessionTitleServiceLive().pipe(
				Layer.provideMerge(ProjectSettingsLive),
			),
		sessionManagerParts,
		options.overridesStateLayer ?? makeOverridesStateLive(),
		// Poller state
		makePollerStateLive(),
		makePollerPubSubLive(),
		// Per-relay domain event fanout
		RelayEventBusLive,
		// Committed-event change signal, shared by daemon relays.
		sessionEventBusLayer,
		// Alert and composer-draft fanout (live-only subscriptions)
		options.alertsLayer ?? AlertsLive,
		InputDraftsLive,
		// PTY state
		PtyManagerStateLive,
		// Instance management state
		makeOpenCodeRuntimeStateLive(),
		// Rate limiter (scoped — cleanup fiber runs every 60s)
		options.rateLimiterLayer ??
			RateLimiterLive({
				maxRequests: options.testSendLimit ?? 5,
				windowMs: 10_000,
			}),
	);
};

export const RelayStateLive = makeRelayStateLive();
