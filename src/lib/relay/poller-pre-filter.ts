import type { RelayMessage } from "../shared-types.js";

/**
 * Message types that are pure metadata / bookkeeping and don't
 * represent actual agent content activity.
 */
const METADATA_TYPES: ReadonlySet<string> = new Set([
	"session_list",
	"session_switched",
	"session_forked",
	"history_page",
	"model_info",
	"default_model_info",
	"model_list",
	"agent_list",
	"command_list",
	"project_list",
	"file_list",
	"file_content",
	"file_tree",
	"connection_status",
	"client_count",
	"instance_list",
	"instance_status",
	"instance_update",
	"notification_event",
	"input_sync",
	"update_available",
	"pty_list",
	"scan_result",
	"variant_info",
	"proxy_detected",
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
