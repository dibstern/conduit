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
	"tool.input_updated",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"session.status",
] as const satisfies readonly CanonicalEventType[];

/**
 * Canonical event types that the Claude path explicitly does NOT produce
 * via the ClaudeEventTranslator because they are OpenCode-specific or
 * handled elsewhere in the Claude SDK pipeline. Each entry MUST have a
 * comment explaining why it's excluded.
 */
const CLAUDE_NOT_APPLICABLE_TYPES = [
	"session.created", // Emitted directly in prompt.ts via eventStore.append(), not via translator
	"session.renamed", // Title changes handled by auto-rename in prompt.ts
	"session.provider_changed", // Provider switching is a relay-level concept
	"permission.asked", // Routed through requestPermission(), not push()
	"permission.resolved", // Routed through resolvePermission(), not push()
	"question.asked", // Routed through requestQuestion(), not push()
	"question.resolved", // Routed through resolveQuestion(), not push()
] as const satisfies readonly CanonicalEventType[];

// ─── Compile-time exhaustiveness check ──────────────────────────────────
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
