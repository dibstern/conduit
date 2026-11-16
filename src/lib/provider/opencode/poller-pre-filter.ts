import type { BrowserMessage } from "../../shared-types.js";

/**
 * Classifies a batch of poller events.
 * Returns whether the batch contains any content activity
 * (messages that represent actual agent work, not just metadata).
 */
export function classifyPollerBatch(events: readonly BrowserMessage[]): {
	readonly hasContentActivity: boolean;
} {
	return { hasContentActivity: events.length > 0 };
}
