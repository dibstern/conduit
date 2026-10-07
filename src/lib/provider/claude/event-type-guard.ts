// src/lib/provider/claude/event-type-guard.ts
/**
 * Compile-time exhaustiveness guard for canonical event types.
 *
 * When a new CanonicalEventType is added to CANONICAL_EVENT_TYPES, this
 * file will cause a type error unless the new type is explicitly listed
 * in one of the sets below. This prevents silent event-handling gaps
 * between the OpenCode SSE path and the Claude SDK path.
 */
import type { CanonicalEventType } from "../../persistence/events.js";

/**
 * Canonical event types that the Claude event translator PRODUCES.
 * If the translator should emit a new event type, add it here AND
 * add the actual emission code in claude-event-translator.ts.
 */
const CLAUDE_PRODUCED_TYPES = [
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"turn.model_resolved",
	"session.status",
	"session.compaction",
	"session.permission_mode_changed",
	"session.goal_changed", // Goal tracker translates SDK facts and transcript settlement through the event sink
] as const satisfies readonly CanonicalEventType[];

/**
 * Canonical event types that the Claude path explicitly does NOT produce
 * via the ClaudeEventTranslator because they are OpenCode-specific or
 * handled elsewhere in the Claude SDK pipeline. Each entry MUST have a
 * comment explaining why it's excluded.
 */
const CLAUDE_NOT_APPLICABLE_TYPES = [
	"message.snapshot", // OpenCode REST reconciliation only
	"message.removed", // OpenCode SSE rewind/removal only
	"message.part.removed", // OpenCode SSE part removal only
	"file.attached", // OpenCode REST/SSE file part transport; Claude attachments use a different provider path
	"tool.input_updated", // Historical event — no longer emitted after tool input buffering changed (buffered tool.started replaces it)
	"session.created", // Emitted directly in prompt.ts via eventStore.append(), not via translator
	"session.renamed", // Title changes handled by auto-rename in prompt.ts
	"session.deleted", // Relay-owned lifecycle event appended directly by SessionManager
	"session.forked", // Fork lineage is recorded by the relay, not the Claude event translator
	"session.provider_changed", // Provider switching is a relay-level concept
	"session.provider_cleanup_failed", // Relay-owned cleanup diagnostic
	"session.handoff_delivered", // Server-owned handoff completion receipt; adapters do not emit it
	"session.usage_limited", // Runtime interception emits the signal; continuation owns canonical intake.
	"session.cut_off_dismissed", // Continuation owns Dismiss; the adapter does not produce it.
	"session.resumed", // Continuation owns resume decisions; the adapter only runs the turn.
	"session.model_changed", // Relay-owned model settings, appended by the relay's session settings module
	"session.variant_changed", // Same
	"session.context_window_changed", // Same
	"session.settled", // Relay-owned triage state
	"session.unsettled", // Relay-owned triage state
	"session.pinned", // Relay-owned triage state
	"session.unpinned", // Relay-owned triage state
	"session.snoozed", // Relay-owned triage state
	"session.auto_settle_set", // Relay-owned triage state
	"session.unsnoozed", // Relay-owned triage state
	"session.read", // Retired read state (hk9m.7); kept so historical stores decode
	"session.unread", // Same
	"permission.asked", // Recorded by the sink's requestPermission(), not push()
	"permission.resolved", // Same
	"question.asked", // Recorded by the sink's requestQuestion(), not push()
	"question.resolved", // Same, or by the turn that answers a recovered question
] as const satisfies readonly CanonicalEventType[];

// All canonical event types MUST appear in exactly one of the two arrays.
// If this type errors, a new CanonicalEventType was added without updating
// this file. Fix: add the new type to either CLAUDE_PRODUCED_TYPES or
// CLAUDE_NOT_APPLICABLE_TYPES with a comment explaining the decision.

type ProducedType = (typeof CLAUDE_PRODUCED_TYPES)[number];
type NotApplicableType = (typeof CLAUDE_NOT_APPLICABLE_TYPES)[number];
type CoveredType = ProducedType | NotApplicableType;

// This will error if CanonicalEventType has a member not in CoveredType:
type _AssertExhaustive = CanonicalEventType extends CoveredType
	? true
	: {
			ERROR: "New CanonicalEventType not listed in event-type-guard.ts";
			missing: Exclude<CanonicalEventType, CoveredType>;
		};

// Force the compiler to evaluate the type (dead code elimination removes this)
const _exhaustiveCheck: _AssertExhaustive = true;

// Re-export for runtime access if needed
export const CLAUDE_PRODUCED = new Set<string>(CLAUDE_PRODUCED_TYPES);
export const CLAUDE_NOT_APPLICABLE = new Set<string>(
	CLAUDE_NOT_APPLICABLE_TYPES,
);
