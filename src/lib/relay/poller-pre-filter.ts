import type { RelayMessage } from "../shared-types.js";

/**
 * Message types that are pure metadata / bookkeeping and don't
 * represent actual agent content activity.
 */
export const METADATA_TYPES: ReadonlySet<RelayMessage["type"]> = new Set<
	RelayMessage["type"]
>([
	"session_list",
	"session_forked",
	"model_info",
	"default_model_info",
	"project_list",
	"connection_status",
	"client_count",
	"instance_list",
	"instance_update",
	"notification_event",
	"input_sync",
	"pty_list",
	"variant_info",
	"context_window_info",
	"permission_mode_info",
]);

/**
 * Classifies a batch of poller events.
 * Returns whether the batch contains any content activity
 * (messages that represent actual agent work, not just metadata).
 */
export function classifyPollerBatch(events: readonly RelayMessage[]): {
	readonly hasContentActivity: boolean;
} {
	const hasContentActivity = events.some(
		(msg) => !METADATA_TYPES.has(msg.type),
	);
	return { hasContentActivity };
}
