// ─── Session State Projection Notifier (port) ───────────────────────────────
// Declared here, next to the projection runner that calls it, and implemented
// in the relay -- the only layer that knows about sockets. Defining it the
// other way round would point a dependency arrow from persistence at the relay,
// which nothing else in the tree does and which would be the first such edge.

import { Context, type Effect } from "effect";
import type { CanonicalEventType } from "../events.js";

export interface SessionStateProjectionNotifier {
	/**
	 * A projection of `eventType` for `sessionId` has just been committed.
	 * Never called during replay: recovery projects the whole log, and state no
	 * client has ever seen is not news.
	 *
	 * The error channel is `never` on purpose. The projection runner calls this
	 * after a successful commit, so a notifier that failed loudly would turn a
	 * cosmetic staleness into a failed projection.
	 */
	readonly sessionStateProjected: (
		sessionId: string,
		eventType: CanonicalEventType,
	) => Effect.Effect<void>;
}

export class SessionStateProjectionNotifierTag extends Context.Tag(
	"SessionStateProjectionNotifier",
)<SessionStateProjectionNotifierTag, SessionStateProjectionNotifier>() {}
