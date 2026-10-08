// One sidebar row per top-level session: everything the sidebar shows for its
// family, as the session and approval projectors last left it. The projector's
// writer, the sidebar read and the differential test share this schema, and
// `changeSidebarRow` alone decides whether a row's version moves.

import { Schema } from "effect";
import { SessionInfoSchema } from "../shared-types.js";

export const SidebarRowSchema = Schema.Struct({
	/** The read-model version of the row's last visible change. */
	version: Schema.Number,
	/** The root's `updated_at` as of that change: the sidebar's recency order. */
	lastActivity: Schema.Number,
	/**
	 * The family sessions whose activity rolls into the root (none under a
	 * side thread), for background work applied when the row is read.
	 */
	members: Schema.Array(Schema.String),
	/** The root's snooze columns: whether it has woken depends on read time. */
	snooze: Schema.Struct({
		snoozed_at: Schema.NullOr(Schema.Number),
		snoozed_until: Schema.NullOr(Schema.Number),
		woken_at: Schema.NullOr(Schema.Number),
		woken_reason: Schema.NullOr(
			Schema.Literal("approval", "question", "error", "turn"),
		),
	}),
	/**
	 * The root's summary with its family rolled up, without what is applied at
	 * read time: background work and snooze state. Its attention and
	 * processing are what the stored state alone gives.
	 */
	session: SessionInfoSchema.omit(
		"updatedAt",
		"backgroundWork",
		"backgroundTasks",
		"compacting",
		"retrying",
		"snoozedAt",
		"snoozedUntil",
		"wokenAt",
		"wokeBecause",
	),
});

export type SidebarRow = typeof SidebarRowSchema.Type;

const encodeShown = Schema.encodeSync(
	SidebarRowSchema.omit("version", "lastActivity"),
);
// Encoding puts keys in schema order, so equal content compares equal however
// each side was built.
const shown = (row: SidebarRow) => JSON.stringify(encodeShown(row));

/**
 * The row to store for a family, given what is stored and what the family now
 * computes to. Only a change the sidebar shows moves the version and takes the
 * new last-activity time; anything else, such as a streamed chunk touching the
 * root's `updated_at`, keeps the stored row, so it neither resends nor
 * reorders the sidebar.
 */
export const changeSidebarRow = (
	stored: SidebarRow | undefined,
	next: SidebarRow,
): { readonly row: SidebarRow; readonly changed: boolean } =>
	stored !== undefined && shown(stored) === shown(next)
		? { row: stored, changed: false }
		: { row: next, changed: true };
