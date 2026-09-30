import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { applySessionCommand } from "./session-command.js";
import { SessionManagerError } from "./session-manager-error.js";
import type { SetSessionSettledOptions } from "./session-manager-service.js";

/**
 * Rename a session through Conduit's event store for Claude rows, otherwise via the API.
 */
export const renameSession = (sessionId: string, title: string) =>
	applySessionCommand({
		type: "session.renamed",
		data: { sessionId, title },
	}).pipe(
		Effect.mapError(
			(cause) => new SessionManagerError({ operation: "renameSession", cause }),
		),
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.renameSession", { attributes: { sessionId } }),
	);

export const markSessionRead = (sessionId: string) =>
	applySessionCommand({
		type: "session.read",
		data: { sessionId },
	}).pipe(
		Effect.mapError(
			(cause) =>
				new SessionManagerError({ operation: "markSessionRead", cause }),
		),
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.markSessionRead", { attributes: { sessionId } }),
	);

export const markSessionUnread = (sessionId: string) =>
	applySessionCommand({
		type: "session.unread",
		data: { sessionId },
	}).pipe(
		Effect.mapError(
			(cause) =>
				new SessionManagerError({ operation: "markSessionUnread", cause }),
		),
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.markSessionUnread", { attributes: { sessionId } }),
	);

const readSessionForTriage = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;
		if (!(yield* runner.isRecovered())) {
			yield* runner
				.recover()
				.pipe(Effect.provideService(SqlClient.SqlClient, sql));
		}
		return yield* readQuery.getSession(sessionId);
	});

export const setSessionSettled = (
	sessionId: string,
	{ settled, automatic = false }: SetSessionSettledOptions,
) =>
	Effect.gen(function* () {
		const row = yield* readSessionForTriage(sessionId);
		if (!row) return false;
		if (settled && row.pinned_at !== null) {
			return yield* Effect.fail(
				new Error("Session is pinned and must be unpinned first"),
			);
		}
		const unsnoozed = settled && !automatic && row.snoozed_at !== null;
		if (unsnoozed) {
			yield* applySessionCommand({
				type: "session.unsnoozed",
				data: { sessionId },
			});
		}
		if ((row.settled_at !== null) === settled) return unsnoozed;
		yield* applySessionCommand(
			settled
				? { type: "session.settled", data: { sessionId, automatic } }
				: { type: "session.unsettled", data: { sessionId } },
		);
		return true;
	}).pipe(
		Effect.mapError(
			(cause) =>
				new SessionManagerError({ operation: "setSessionSettled", cause }),
		),
		Effect.withSpan("session.setSessionSettled", { attributes: { sessionId } }),
	);

export const setSessionPinned = (sessionId: string, pinned: boolean) =>
	Effect.gen(function* () {
		const row = yield* readSessionForTriage(sessionId);
		if (!row) return false;
		const unsnoozed = pinned && row.snoozed_at !== null;
		if (unsnoozed) {
			yield* applySessionCommand({
				type: "session.unsnoozed",
				data: { sessionId },
			});
		}
		if ((row.pinned_at !== null) === pinned) return unsnoozed;
		// A session is never both pinned and settled, so a pin brings it back.
		if (pinned && row.settled_at !== null) {
			yield* applySessionCommand({
				type: "session.unsettled",
				data: { sessionId },
			});
		}
		yield* applySessionCommand({
			type: pinned ? "session.pinned" : "session.unpinned",
			data: { sessionId },
		});
		return true;
	}).pipe(
		Effect.mapError(
			(cause) =>
				new SessionManagerError({ operation: "setSessionPinned", cause }),
		),
		Effect.withSpan("session.setSessionPinned", { attributes: { sessionId } }),
	);

export const setSessionAutoSettleDisabled = (
	sessionId: string,
	disabled: boolean,
) =>
	Effect.gen(function* () {
		const row = yield* readSessionForTriage(sessionId);
		if (!row || (row.auto_settle_disabled_at != null) === disabled)
			return false;
		yield* applySessionCommand({
			type: "session.auto_settle_set",
			data: { sessionId, disabled },
		});
		return true;
	}).pipe(
		Effect.mapError(
			(cause) =>
				new SessionManagerError({
					operation: "setSessionAutoSettleDisabled",
					cause,
				}),
		),
	);

export const snoozeSession = (sessionId: string, until: number | null) =>
	Effect.gen(function* () {
		const row = yield* readSessionForTriage(sessionId);
		if (!row) return false;
		if (row.pinned_at !== null) {
			return yield* Effect.fail(new Error("Unpin the session first"));
		}
		if (row.settled_at !== null) {
			return yield* Effect.fail(new Error("Un-settle the session first"));
		}
		const readQuery = yield* ReadQueryEffectTag;
		const pending = yield* readQuery.countPendingApprovalsBySession();
		if (pending.some((approval) => approval.session_id === sessionId)) {
			return yield* Effect.fail(new Error("Session is waiting on you"));
		}
		if (until !== null && (!Number.isFinite(until) || until <= Date.now())) {
			return yield* Effect.fail(new Error("Snooze time must be in the future"));
		}
		if (
			row.snoozed_at !== null &&
			row.woken_at === null &&
			row.snoozed_until === until
		)
			return false;
		yield* applySessionCommand({
			type: "session.snoozed",
			data: { sessionId, until },
		});
		return true;
	}).pipe(
		Effect.mapError(
			(cause) => new SessionManagerError({ operation: "snoozeSession", cause }),
		),
		Effect.withSpan("session.snoozeSession", { attributes: { sessionId } }),
	);

export const unsnoozeSession = (sessionId: string) =>
	Effect.gen(function* () {
		const row = yield* readSessionForTriage(sessionId);
		if (!row || row.snoozed_at === null) return false;
		yield* applySessionCommand({
			type: "session.unsnoozed",
			data: { sessionId },
		});
		return true;
	}).pipe(
		Effect.mapError(
			(cause) =>
				new SessionManagerError({ operation: "unsnoozeSession", cause }),
		),
		Effect.withSpan("session.unsnoozeSession", { attributes: { sessionId } }),
	);
