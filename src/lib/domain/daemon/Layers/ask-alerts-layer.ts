// Ask alerts (82tn.12): one daemon owner reads every project's pending asks
// and tells every tab (the alert feed) and every device (push) once per ask,
// whichever provider raised it and whichever project a tab views. The pending
// set is the read model 82tn.11 built; this owner keeps no copy of it beyond
// the ids it has already told about, and the alert ledger keeps push to once
// across restarts.

import {
	Duration,
	Effect,
	Layer,
	Option,
	PubSub,
	Schedule,
	Stream,
} from "effect";
import * as Failure from "../../../effect/failure-classification.js";
import { createLogger } from "../../../logger.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import { sendPushForEventEffect } from "../../../relay/sse-wiring.js";
import type { Approval } from "../../../shared-types.js";
import {
	AlertLedgerTag,
	makeAlertLedger,
} from "../../relay/Services/alert-ledger.js";
import { AlertsTag } from "../../relay/Services/alerts.js";
import {
	approvalId,
	subscribeEveryProjectApprovals,
} from "../../relay/Services/approvals-subscription.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { PushManagerTag } from "../../server/Services/push-service.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";

/** An ask answered within this window (an auto-approval) is never announced. */
const ASK_GRACE = Duration.seconds(1);

export const AskAlertsLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const registry = yield* ProjectRegistryTag;
		const alerts = yield* AlertsTag;
		const store = yield* PersistenceStore;
		const bus = yield* SessionEventBusTag;
		const readQuery = yield* makeReadQueryEffect.pipe(Effect.provide(store));
		const ledger = yield* makeAlertLedger.pipe(Effect.provide(store));
		const sender = yield* (yield* PushManagerTag).getLegacyManager;
		const log = createLogger("daemon");
		const scope = yield* Effect.scope;
		const pending = new Set<string>();
		const told = new Set<string>();

		const tell = (approval: Approval, id: string) =>
			Effect.gen(function* () {
				yield* Effect.sleep(ASK_GRACE);
				if (!pending.has(id) || told.has(id)) return;
				told.add(id);
				yield* PubSub.publish(alerts, {
					_tag: "alert",
					kind: approval._tag,
					alertId: id,
					sessionId: approval.sessionId,
					...(approval._tag === "permission" &&
						approval.toolName !== "" && { message: approval.toolName }),
				});
				if (Option.isNone(sender)) return;
				const session = yield* readQuery.getSession(approval.sessionId);
				yield* sendPushForEventEffect(sender.value, approval, log, {
					sessionId: approval.sessionId,
					...(session?.project_id != null && { slug: session.project_id }),
				}).pipe(Effect.provideService(AlertLedgerTag, ledger));
			}).pipe(
				Effect.catchCause((cause) =>
					Failure.isInterruptedOnly(cause)
						? Effect.failCause(cause)
						: Effect.logWarning("ask alert failed", {
								id,
								cause: Failure.renderCause(cause),
							}),
				),
				Effect.forkIn(scope),
			);

		const announce = (approval: Approval) => {
			const id = approvalId(approval);
			pending.add(id);
			return told.has(id) ? Effect.void : tell(approval, id);
		};

		yield* subscribeEveryProjectApprovals(
			Effect.map(
				allProjects.pipe(Effect.provideService(ProjectRegistryTag, registry)),
				(projects) => projects.map((project) => project.slug),
			),
		).pipe(
			Stream.runForEach((envelope) => {
				switch (envelope._tag) {
					case "snapshot": {
						const ids = new Set(envelope.rows.map(approvalId));
						for (const id of pending) if (!ids.has(id)) pending.delete(id);
						for (const id of told) if (!ids.has(id)) told.delete(id);
						return Effect.forEach(envelope.rows, announce, { discard: true });
					}
					case "upsert":
						return announce(envelope.item);
					case "remove":
						return Effect.sync(() => {
							pending.delete(envelope.id);
							told.delete(envelope.id);
						});
					default:
						return Effect.void;
				}
			}),
			Effect.provideService(ReadQueryEffectTag, readQuery),
			Effect.provideService(SessionEventBusTag, bus),
			Effect.tapCause((cause) =>
				Effect.logWarning("ask alerts feed ended", Failure.renderCause(cause)),
			),
			Effect.retry({ schedule: Schedule.spaced(Duration.seconds(1)) }),
			Effect.forkIn(scope),
		);
	}),
);
