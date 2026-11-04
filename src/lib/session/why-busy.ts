/**
 * Why a session is busy (82tn.56): Session Activity's one answer with the open tool calls under it.
 * It adds no busy source: the view opens only while the busy indicator (the row's attention) reads
 * busy, every reason comes from the row's Session Activity view (CONTRACT.md 8.1, 2734), and tool
 * rows only list what is open.
 */
import {
	type BackgroundTask,
	backgroundTaskText,
	type HistoryMessage,
	type SessionAttention,
	type SessionInfo,
} from "../shared-types.js";

/** One thing the session holds open, with when it started. */
export interface WhyBusyItem {
	readonly label: string;
	readonly since?: number;
}

export type WhyBusyReason =
	| {
			readonly kind: "needs-you";
			readonly approvals: number;
			readonly questions: number;
	  }
	| {
			readonly kind: "run";
			readonly origin: "input" | "wake";
			/** The task that woke a wake Run, when known. */
			readonly task?: string;
			/** Inputs waiting behind the Run (the pending tray). */
			readonly queued: number;
	  }
	| {
			readonly kind: "background";
			readonly activity: "work" | "monitoring" | "serving";
			readonly tasks: readonly WhyBusyItem[];
			readonly servers: readonly WhyBusyItem[];
	  }
	| { readonly kind: "checking"; readonly stale: readonly WhyBusyItem[] }
	| { readonly kind: "members" };

export interface OpenToolCall {
	readonly callId: string;
	readonly tool: string;
	readonly since?: number;
}

export interface WhyBusy {
	readonly reasons: readonly WhyBusyReason[];
	readonly tools: readonly OpenToolCall[];
}

export type WhyBusyRow = Pick<
	SessionInfo,
	| "attention"
	| "processing"
	| "activity"
	| "wakeRun"
	| "pendingPermissionCount"
	| "pendingQuestionCount"
	| "backgroundTasks"
	| "servers"
	| "staleTasks"
>;

export interface WhyBusyDetail {
	readonly pending: readonly unknown[];
	readonly messages: readonly HistoryMessage[];
}

/** The indicator's tiers that read busy: what runs, and what waits on the user. */
const BUSY: ReadonlySet<SessionAttention> = new Set([
	"needs-approval",
	"needs-reply",
	"working",
	"monitoring",
]);

const rank = { idle: 0, background: 1, working: 2 } as const;

const itemsOf = (tasks: readonly BackgroundTask[] = []): WhyBusyItem[] =>
	tasks.map((task) => ({
		label: backgroundTaskText(task),
		since: task.firstSeenAt,
	}));

/** Open tool calls, once each: not ended, and not ended by the run (82tn.45). */
const openToolsOf = (messages: readonly HistoryMessage[]): OpenToolCall[] =>
	[
		...new Map(
			messages
				.flatMap((message) => message.parts ?? [])
				.filter(
					(part) =>
						part.type === "tool" &&
						(part.state?.status === "pending" ||
							part.state?.status === "running") &&
						part.state.outcome !== "endedByRun",
				)
				.map((part) => {
					const callId = part.callID ?? part.id;
					const since = part.time?.start;
					return [
						callId,
						{
							callId,
							tool: part.tool ?? "tool",
							...(since === undefined ? {} : { since }),
						},
					] as const;
				})
				.reverse(),
		).values(),
	].reverse();

/** Undefined while the busy indicator reads calm, so the view never shows beside a calm glyph. */
export const whyBusy = (
	row: WhyBusyRow,
	detail: WhyBusyDetail,
): WhyBusy | undefined => {
	const activity = row.activity;
	if (!activity || !BUSY.has(row.attention ?? "idle")) return undefined;
	const reasons: WhyBusyReason[] = [];
	if (activity.needsYou)
		reasons.push({
			kind: "needs-you",
			approvals: row.pendingPermissionCount ?? 0,
			questions: row.pendingQuestionCount ?? 0,
		});
	// CONTRACT.md 147 gives queued inputs to the inbox, not to SessionActivity (2734): they show only
	// under the active Run, which counts from Queued, never as a busy reason of their own.
	if (activity.foreground === "working")
		reasons.push({
			kind: "run",
			origin: row.wakeRun ? "wake" : "input",
			...(row.wakeRun?.task === undefined ? {} : { task: row.wakeRun.task }),
			queued: detail.pending.length,
		});
	if (activity.background === "unknown")
		reasons.push({ kind: "checking", stale: itemsOf(row.staleTasks) });
	else if (activity.background !== "none")
		reasons.push({
			kind: "background",
			activity: activity.background,
			tasks: itemsOf(row.backgroundTasks),
			servers: (row.servers ?? []).map((server) => ({
				label: `${server.command} :${server.port}`,
				since: server.startedAt,
			})),
		});
	// The indicator rolls up side threads and subagents (rollUpActivity); the row's own view does not.
	const own =
		activity.foreground === "working" || activity.background === "work"
			? "working"
			: activity.background === "none"
				? "idle"
				: "background";
	const rolled = row.processing
		? "working"
		: row.attention === "monitoring"
			? "background"
			: "idle";
	if (rank[rolled] > rank[own]) reasons.push({ kind: "members" });
	return { reasons, tools: openToolsOf(detail.messages) };
};
