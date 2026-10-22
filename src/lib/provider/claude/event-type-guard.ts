import type { LiveEventType } from "../../contracts/stored-event.js";

/** Claude SDK translation coverage; other event owners are recorded as reasons. */
export const CLAUDE_EVENT_CLASSIFICATION = {
	"run.requested": {
		produced: false,
		reason: "Committed by the provider command outbox",
	},
	"run.started": {
		produced: false,
		reason: "Emitted at the runtime input acceptance boundary",
	},
	"message.created": { produced: true },
	"text.delta": { produced: true },
	"text.surfaced": {
		produced: false,
		reason:
			"Daemon-owned surfacing verdict; never emitted by a provider adapter",
	},
	"thinking.start": { produced: true },
	"thinking.delta": { produced: true },
	"thinking.end": { produced: true },
	"tool.started": { produced: true },
	"tool.running": { produced: true },
	"tool.completed": { produced: true },
	"turn.completed": { produced: true },
	"message.completed": {
		produced: false,
		reason:
			"Persistence separates late message accounting from the run terminal",
	},
	"turn.error": { produced: true },
	"turn.interrupted": { produced: true },
	"turn.notice": {
		produced: false,
		reason: "Conduit-owned processing silence notice",
	},
	"turn.model_resolved": { produced: true },
	"session.status": { produced: true },
	"session.compaction": { produced: true },
	"session.permission_mode_changed": { produced: true },
	"session.goal_changed": { produced: true },
	"session.workspace_started": { produced: true },
	"message.snapshot": {
		produced: false,
		reason: "OpenCode REST reconciliation only",
	},
	"message.removed": {
		produced: false,
		reason: "OpenCode SSE message removal; not SDK translation",
	},
	"message.part.removed": {
		produced: false,
		reason: "OpenCode SSE part removal only",
	},
	"file.attached": {
		produced: false,
		reason:
			"OpenCode REST/SSE file part transport; Claude attachments use a different provider path",
	},
	"session.created": {
		produced: false,
		reason:
			"Root sessions are created by SessionManager; subagent sessions are seeded by Claude event persistence, outside SDK translation",
	},
	"session.renamed": {
		produced: false,
		reason:
			"Title changes are recorded by Session Title and SessionManager triage through session commands",
	},
	"session.deleted": {
		produced: false,
		reason:
			"Relay-owned lifecycle event recorded by SessionManager through session commands",
	},
	"session.forked": {
		produced: false,
		reason:
			"Fork lineage is recorded by the relay, not the Claude event translator",
	},
	"session.rewound": {
		produced: false,
		reason: "Relay-owned pending transcript cut, with no Claude SDK mutation",
	},
	"session.rewind_undone": {
		produced: false,
		reason: "Relay-owned restoration of a pending cut",
	},
	"session.rewind_committed": {
		produced: false,
		reason: "Relay-owned cut committed at send admission or upstream removal",
	},
	"session.provider_changed": {
		produced: false,
		reason: "Provider switching is a relay-level concept",
	},
	"session.provider_cleanup_failed": {
		produced: false,
		reason: "Relay-owned cleanup diagnostic",
	},
	"session.handoff_delivered": {
		produced: false,
		reason: "Server-owned handoff completion receipt; adapters do not emit it",
	},
	"session.usage_limited": {
		produced: false,
		reason:
			"Runtime interception emits the signal; continuation owns canonical intake.",
	},
	"session.cut_off_dismissed": {
		produced: false,
		reason: "Continuation owns Dismiss; the adapter does not produce it.",
	},
	"session.resumed": {
		produced: false,
		reason:
			"Continuation owns resume decisions; the adapter only runs the turn.",
	},
	"session.resume_scheduled": {
		produced: false,
		reason:
			"Continuation records scheduled resumes and re-arms after a usage probe",
	},
	"session.resume_cancelled": {
		produced: false,
		reason: "Continuation records cancellation of scheduled resumes",
	},
	"session.model_changed": {
		produced: false,
		reason:
			"Relay-owned model settings, appended by the relay's session settings module",
	},
	"session.workspace_changed": {
		produced: false,
		reason:
			"Conduit-originated, recorded by Session Workspace through the session-command seam",
	},
	"session.setup_started": {
		produced: false,
		reason:
			"Daemon setup lifecycle, recorded through the session-command seam.",
	},
	"session.setup_output": {
		produced: false,
		reason:
			"Daemon setup lifecycle; merged setup output never comes from a provider.",
	},
	"session.setup_finished": {
		produced: false,
		reason:
			"Daemon setup lifecycle, including failures, timeout and interrupted-setup recovery.",
	},
	"session.workspace_hint_changed": {
		produced: false,
		reason:
			"Relay-owned write-path inference; never emitted by the provider translator.",
	},
	"session.variant_changed": {
		produced: false,
		reason:
			"Relay-owned effort settings, appended by the session settings module",
	},
	"session.context_window_changed": {
		produced: false,
		reason:
			"Relay-owned context window settings, appended by the session settings module",
	},
	"session.settled": { produced: false, reason: "Relay-owned triage state" },
	"session.unsettled": { produced: false, reason: "Relay-owned triage state" },
	"session.archived": { produced: false, reason: "Relay-owned triage state" },
	"session.unarchived": { produced: false, reason: "Relay-owned triage state" },
	"session.pinned": { produced: false, reason: "Relay-owned triage state" },
	"session.unpinned": { produced: false, reason: "Relay-owned triage state" },
	"session.snoozed": { produced: false, reason: "Relay-owned triage state" },
	"session.auto_settle_set": {
		produced: false,
		reason: "Relay-owned triage state",
	},
	"session.unsnoozed": { produced: false, reason: "Relay-owned triage state" },
	"permission.asked": {
		produced: false,
		reason: "Recorded by the sink's requestPermission(), not push()",
	},
	"permission.resolved": {
		produced: false,
		reason: "Recorded by the sink's requestPermission(), not push()",
	},
	"question.asked": {
		produced: false,
		reason: "Recorded by the sink's requestQuestion(), not push()",
	},
	"question.resolved": {
		produced: false,
		reason:
			"Recorded by the sink's requestQuestion(), or by the turn that answers a recovered question",
	},
	"input.admitted": {
		produced: false,
		reason: "Relay-owned: the Session Inbox commits it when a send is admitted",
	},
	"input.sent": {
		produced: false,
		reason:
			"Relay-owned: the Session Inbox records turn handoff or steering delivery",
	},
	"input.requeued": {
		produced: false,
		reason: "Inbox recovery after a declined or failed steer",
	},
	"input.cancelled": {
		produced: false,
		reason:
			"Relay-owned: the Session Inbox commits it when a queued input is removed",
	},
	"interrupt.requested": {
		produced: false,
		reason: "Committed by the provider control outbox",
	},
	"session.end_requested": {
		produced: false,
		reason: "Committed by the provider control outbox",
	},
	"input.interrupt_requested": {
		produced: false,
		reason:
			"Relay-owned: the Session Inbox commits it before interrupting a turn",
	},
} as const satisfies Record<
	LiveEventType,
	| { readonly produced: true }
	| { readonly produced: false; readonly reason: string }
>;
