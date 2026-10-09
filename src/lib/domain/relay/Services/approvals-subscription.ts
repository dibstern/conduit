// Approvals Subscription (ni8.9)
// The concrete SubscriptionSource for the pending permission requests and
// questions of every session in a project. It replaces the permission_request,
// permission_resolved, ask_user, ask_user_resolved and ask_user_error pushes:
// the card a browser shows is now a row in `pending_approvals`, and its
// resolution is that row leaving the pending set.
//
// Scope is the project, as for the shell. The browser shows approvals from
// sessions it is not viewing (the attention banner) and a subagent's approvals
// inline in its parent, so a per-session scope would drop cases the UI handles.
//
// The approval projector stamps each row with the read-model version it moved
// at, so a live window is `WHERE version in (after, through]`: an asked row is
// an upsert, a resolved one a removal. Resume is a REBASE, like the shell's:
// the pending set is a handful of rows, and a session delete cascades its
// approvals away without leaving a version to find. That one case comes off the
// advance (`removedSessionIds`), mapped back to approval ids through the
// approvals this subscription has announced.

import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Option, Schema, Stream } from "effect";
import {
	type ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import type { PendingApprovalRow } from "../../../persistence/read-model-types.js";
import { type Approval, ApprovalSchema } from "../../../shared-types.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import { SessionEventBusTag } from "./session-event-bus.js";

export type ApprovalsSubscriptionError = ReadQueryEffectError | SqlError;

const decodeApproval = Schema.decodeUnknownOption(ApprovalSchema);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string | null): unknown => {
	if (text === null) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

// Claude records questions in the browser's shape; OpenCode records its own,
// which says `multiple` and leaves `custom` to default on (see
// mapQuestionFields in bridges/question-bridge.ts).
const normalizeQuestions = (raw: unknown): unknown =>
	Array.isArray(raw)
		? raw.map((question: unknown) =>
				isRecord(question)
					? {
							question: question["question"] ?? "",
							header: question["header"] ?? "",
							options: Array.isArray(question["options"])
								? question["options"]
								: [],
							multiSelect:
								question["multiSelect"] ?? question["multiple"] ?? false,
							custom: question["custom"] ?? true,
						}
					: question,
			)
		: raw;

/** A row as the browser's card needs it, or nothing if the row cannot make one. */
const toApproval = (row: PendingApprovalRow): Approval | undefined => {
	const input = parseJson(row.input);
	const details = parseJson(row.details);
	const base =
		row.type === "permission"
			? {
					_tag: "permission",
					sessionId: row.session_id,
					requestId: row.id,
					toolName: row.tool_name ?? "",
					toolInput: isRecord(input) ? input : {},
				}
			: {
					_tag: "question",
					sessionId: row.session_id,
					toolId: row.id,
					questions: normalizeQuestions(input),
				};
	// A card without its extras beats no card at all.
	return decodeApproval({
		...(isRecord(details) ? details : {}),
		...base,
	}).pipe(
		Option.orElse(() => decodeApproval(base)),
		Option.getOrUndefined,
	);
};

/**
 * Subscribe to the project's pending approvals: the pending set, a
 * `synchronized` boundary, then upserts as approvals are raised and removes as
 * they are resolved or their session is deleted. Removal ids are the item's
 * requestId (permission) or toolId (question).
 */
export const subscribeApprovals = (
	options: { readonly resumeFromSequence?: number } = {},
): Stream.Stream<
	Envelope<Approval>,
	ApprovalsSubscriptionError,
	ReadQueryEffectTag | SessionEventBusTag
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			// The pending approvals this subscriber holds, by owning session: the
			// only way to name what a cascaded session delete took with it.
			const announced = new Map<string, string>();
			return stream<Approval, ApprovalsSubscriptionError>({
				bus,
				source: {
					name: "approvals",
					read: (range) =>
						Effect.map(readQuery.readPendingApprovals(range), (answer) => {
							if (range === undefined) announced.clear();
							const rows = [];
							const removed = [];
							for (const row of answer.rows) {
								const item =
									row.status === "pending" ? toApproval(row) : undefined;
								if (item === undefined) {
									announced.delete(row.id);
									if (range !== undefined)
										removed.push({ id: row.id, version: row.version });
									continue;
								}
								announced.set(row.id, row.session_id);
								rows.push({ item, version: row.version });
							}
							return { rows, removed, version: answer.version };
						}),
					// The projector moves an approval's session with it, so an advance
					// naming no session cannot have moved one.
					route: (advance) => {
						const gone = new Set(advance.removedSessionIds);
						const removed = [...announced]
							.filter(([, sessionId]) => gone.has(sessionId))
							.map(([id]) => id);
						for (const id of removed) announced.delete(id);
						return { moved: advance.sessionIds.length > 0, removed };
					},
					resume: "rebase",
				},
				...(options.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence }),
			});
		}),
	);
