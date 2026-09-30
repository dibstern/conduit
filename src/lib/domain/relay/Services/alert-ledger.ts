// At-least-once delivery with recipient-side deduplication. A pending claim is
// retryable after abandonment; only successful sends become delivered receipts.
// The daemon is the single owner of each project store. Live attempts are tracked
// process-wide, including across ledger instances sharing that store.

import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Effect, Layer } from "effect";

/** An immutable originating turn, message, question, or permission identity. */
export interface SessionAlert {
	readonly sessionId: string;
	readonly originId: string;
	readonly kind: "done" | "error" | "ask_user" | "permission_request";
	readonly detail?: string;
	readonly recipientId?: string;
}

const activeClaims = new Set<string>();

export interface AlertLedger {
	/**
	 * Attempt delivery unless already delivered or currently in flight.
	 * Abandoned pending claims are retried; a crash after sending but before
	 * recording success can deliver twice. Recipients deduplicate the alert id.
	 */
	readonly deliver: <E, R>(
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

	const deliver = <E, R>(
		alert: SessionAlert,
		send: Effect.Effect<void, E, R>,
	): Effect.Effect<boolean, E | SqlError, R> =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const claimId = randomUUID();
				activeClaims.add(claimId);
				return claimId;
			}),
			(claimId) =>
				Effect.gen(function* () {
					const anchor = alert.originId;
					const key = keyOf(alert);
					const existing = yield* sql<{
						state: string;
						claim_id: string | null;
					}>`
					SELECT state, claim_id FROM sent_alerts
					WHERE session_id = ${alert.sessionId} AND alert_key = ${key}
						AND anchor = ${anchor}`;
					const previous = existing[0];
					if (
						previous?.state === "delivered" ||
						(previous?.claim_id && activeClaims.has(previous.claim_id))
					)
						return false;
					const claimed = yield* sql<{ session_id: string }>`
					INSERT INTO sent_alerts (session_id, alert_key, anchor, sent_at, state, claim_id)
					VALUES (${alert.sessionId}, ${key}, ${anchor}, ${Date.now()}, 'pending', ${claimId})
					ON CONFLICT (session_id, alert_key, anchor) DO UPDATE SET
						anchor = excluded.anchor, sent_at = excluded.sent_at,
						state = 'pending', claim_id = excluded.claim_id
					WHERE (sent_alerts.state = 'pending' AND sent_alerts.claim_id IS ${previous?.claim_id ?? null})
					RETURNING session_id`;
					if (claimed.length === 0) return false;
					// The push adapter cannot cancel its network promise. Keep ownership
					// through settlement even if this fiber is interrupted.
					yield* send.pipe(
						Effect.onError(() =>
							sql`DELETE FROM sent_alerts WHERE claim_id = ${claimId}`.pipe(
								Effect.catchAll((cause) =>
									Effect.logError(
										`Could not release pending alert; replay can retry: ${cause}`,
									),
								),
							),
						),
						Effect.zipRight(
							sql`UPDATE sent_alerts SET state = 'delivered', sent_at = ${Date.now()}
						WHERE claim_id = ${claimId}`,
						),
						Effect.uninterruptible,
					);
					return true;
				}),
			(claimId) =>
				Effect.sync(() => {
					activeClaims.delete(claimId);
				}),
		);

	return { deliver } satisfies AlertLedger;
});

export const AlertLedgerLive: Layer.Layer<
	AlertLedgerTag,
	never,
	SqlClient.SqlClient
> = Layer.effect(AlertLedgerTag, makeAlertLedger);
