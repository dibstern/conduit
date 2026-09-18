// ─── Alert Ledger ────────────────────────────────────────────────────────────
// Fire-once for the ding (ni8.23, decision 3.1 = F).
//
// notification_event used to carry two things under one name: a BADGE, which is
// state and must be re-derivable on every reload, and a DING, which is an alert
// and must fire exactly once and never on replay. The badge became three derived
// columns on the session row. This is the other half.
//
// Why it has to be durable. Three pipeline paths can observe the same completed
// turn — the SSE stream, the message poller, and the status poller's safety-net
// done — and the existing defence is an in-memory Set consumed per busy cycle.
// That Set is empty after a restart, which is precisely when the SSE reconnect
// reconciliation re-reads sessions that finished while the daemon was down. An
// in-memory guard therefore protects against the duplicate that is merely
// annoying and not against the replay that wakes someone up at 3am.
//
// The shape is deliberately narrow: `fireOnce` runs the send itself, so a caller
// cannot claim without sending or send without claiming, and a send that fails
// gives the claim back. A ledger row is a statement that the user was told;
// leaving one behind for a push that never left the process would silence every
// retry and leave nothing anywhere saying the alert was lost.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Effect, Layer } from "effect";

/**
 * What the ding is about.
 *
 * `kind` is the push-worthy message type. `detail` is the alert's own stable
 * identity where it has one — a permission's request id, a question's tool id,
 * an error's text — and is what keeps two questions live at the same time from
 * pushing each other out of the ledger. Alerts without a detail ("done") are
 * about the session as a whole and supersede each other by turn.
 */
export interface SessionAlert {
	readonly sessionId: string;
	readonly kind: "done" | "error" | "ask_user" | "permission_request";
	readonly detail?: string;
	readonly recipientId?: string;
}

export interface AlertLedger {
	/**
	 * Fire this alert if nobody has. Returns whether `send` ran.
	 *
	 * The claim is taken before `send` and released if `send` fails, is
	 * interrupted, or dies — the ledger only keeps rows for alerts that were
	 * actually delivered to the push layer.
	 */
	readonly fireOnce: <E, R>(
		alert: SessionAlert,
		send: Effect.Effect<void, E, R>,
	) => Effect.Effect<boolean, E | SqlError, R>;
}

export class AlertLedgerTag extends Context.Tag("AlertLedger")<
	AlertLedgerTag,
	AlertLedger
>() {}

export const makeAlertLedger: Effect.Effect<
	AlertLedger,
	never,
	SqlClient.SqlClient
> = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	/** Which alert this is, independent of when. */
	const keyOf = (alert: SessionAlert) => {
		const key =
			alert.detail === undefined ? alert.kind : `${alert.kind}:${alert.detail}`;
		return alert.recipientId === undefined
			? key
			: JSON.stringify([key, alert.recipientId]);
	};

	/**
	 * When the alert is about.
	 *
	 * The session's latest turn: every path that notices one completed turn
	 * computes the same string, and the next turn computes a different one. A
	 * session with no turn rows falls back to its last message time, and a
	 * session with neither anchors on 0 — which fires, deliberately. A ding that
	 * repeats is a nuisance; a ding that never arrives is the bug.
	 */
	const anchorOf = (alert: SessionAlert) =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				turnId: string | null;
				lastMessageAt: number | null;
			}>`
				SELECT
					(SELECT id FROM turns WHERE session_id = ${alert.sessionId}
						ORDER BY requested_at DESC, rowid DESC LIMIT 1) AS turnId,
					(SELECT last_message_at FROM sessions WHERE id = ${alert.sessionId})
						AS lastMessageAt`;
			const row = rows[0];
			return row?.turnId ?? `m${row?.lastMessageAt ?? 0}`;
		});

	/**
	 * Take the claim, atomically.
	 *
	 * The UPDATE's WHERE is what makes this a claim rather than an upsert: it
	 * runs only when the stored anchor names a DIFFERENT alert, so re-observing
	 * the alert already sent returns no row and the caller stays quiet.
	 */
	const claim = (alert: SessionAlert, anchor: string) =>
		Effect.map(
			sql<{ session_id: string }>`
				INSERT INTO sent_alerts (session_id, alert_key, anchor, sent_at)
				VALUES (${alert.sessionId}, ${keyOf(alert)}, ${anchor}, ${Date.now()})
				ON CONFLICT (session_id, alert_key) DO UPDATE
					SET anchor = excluded.anchor, sent_at = excluded.sent_at
					WHERE sent_alerts.anchor <> excluded.anchor
				RETURNING session_id`,
			(rows) => rows.length > 0,
		);

	const release = (alert: SessionAlert, anchor: string) =>
		sql`DELETE FROM sent_alerts
			WHERE session_id = ${alert.sessionId} AND alert_key = ${keyOf(alert)}
				AND anchor = ${anchor}`;

	const fireOnce = <E, R>(
		alert: SessionAlert,
		send: Effect.Effect<void, E, R>,
	): Effect.Effect<boolean, E | SqlError, R> =>
		Effect.gen(function* () {
			const anchor = yield* anchorOf(alert);
			const claimed = yield* claim(alert, anchor);
			if (!claimed) return false;
			yield* send.pipe(
				Effect.onError(() =>
					release(alert, anchor).pipe(
						// The retry is gone and the user was not told. Nothing else in
						// the system will ever mention it, so say so here.
						Effect.catchAll((cause) =>
							Effect.logError(
								`alert ledger could not release the ${alert.kind} claim for ${alert.sessionId}; this alert will not be retried: ${cause}`,
							),
						),
					),
				),
			);
			return true;
		});

	return { fireOnce } satisfies AlertLedger;
});

export const AlertLedgerLive: Layer.Layer<
	AlertLedgerTag,
	never,
	SqlClient.SqlClient
> = Layer.effect(AlertLedgerTag, makeAlertLedger);
