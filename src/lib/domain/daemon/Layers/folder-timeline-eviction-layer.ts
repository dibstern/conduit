import { randomUUID } from "node:crypto";
import { Effect, Layer, Ref, Schedule, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { DEFAULT_SNAPSHOT_BUDGET } from "../../../contracts/session-diff.js";
import { createLogger } from "../../../logger.js";
import { bindEventStoreEffect } from "../../../persistence/effect/bind-event-store-effect.js";
import {
	EventStoreEffectTag,
	UnboundEventStoreEffectTag,
} from "../../../persistence/effect/event-store-effect.js";
import { loadLedgerView } from "../../../persistence/effect/run-ledger-arm.js";
import {
	AlertsTag,
	publishAlert,
} from "../../project-services/Services/alerts.js";
import { LoggerTag } from "../../project-services/Services/services.js";
import { applySessionCommand } from "../../project-services/Services/session-command.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import {
	FolderTimeline,
	FolderTimelineEviction,
} from "../Services/folder-timeline.js";
import { SessionGit } from "../Services/session-git.js";

const PASS_INTERVAL = "5 minutes";
/** A pass that evicts goes down to this share of the budget, so the next run does not trip it again. */
const TARGET = 0.9;
const NAMED_IN_ALERT = 3;

interface Candidate {
	readonly id: string;
	readonly projectId: string;
	readonly title: string;
	readonly settledAt: number | null;
}

const readableSize = (bytes: number) =>
	bytes < 1024 * 1024
		? `${Math.ceil(bytes / 1024)} KB`
		: `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Folder Timeline's eviction: the one place that decides which sessions'
 * captures leave the disk, and removes them. A session is eligible when the
 * Run Ledger says nothing may act (8.3 `anythingMayAct`) and it is settled or
 * every worktree it owns is merged. Its events stay (ADR-0013).
 */
export const FolderTimelineEvictionLive = Layer.effect(
	FolderTimelineEviction,
	Effect.gen(function* () {
		const timeline = yield* FolderTimeline;
		const git = yield* SessionGit;
		const sql = yield* SqlClient.SqlClient;
		const config = yield* DaemonConfigRefTag;
		const alerts = yield* AlertsTag;
		const store = yield* UnboundEventStoreEffectTag;
		const context =
			yield* Effect.context<
				Exclude<
					Effect.Services<ReturnType<typeof applySessionCommand>>,
					EventStoreEffectTag | LoggerTag
				>
			>();
		const log = createLogger("folder-timeline");
		const passes = yield* Semaphore.make(1);
		const alerting = yield* Ref.make(false);

		const budget = Effect.map(
			Ref.get(config),
			(current) => current.snapshotBudget ?? DEFAULT_SNAPSHOT_BUDGET,
		);
		// CONTRACT.md 8.3 (2849-2853) lists anythingMayAct's readers; eviction is not
		// among them. Its nearest reading: a session where anything may act keeps
		// its captures (gap, reported).
		const mayAct = (sessionId: string) =>
			loadLedgerView(sessionId).pipe(
				Effect.map((view) => view?.anythingMayAct ?? true),
				Effect.provideService(SqlClient.SqlClient, sql),
			);

		/** When the session became eligible and why, or undefined while it is not. */
		const eligibility = (candidate: Candidate) =>
			Effect.gen(function* () {
				if (yield* mayAct(candidate.id)) return undefined;
				const owned = ((yield* git.read(candidate.id))?.folders ?? []).filter(
					(folder) => folder.shared !== true,
				);
				const mergedAt =
					owned.length > 0 &&
					owned.every(
						(folder) =>
							folder.missing !== true && folder.mergedAt !== undefined,
					)
						? Math.max(...owned.map((folder) => folder.mergedAt ?? 0))
						: undefined;
				if (
					candidate.settledAt !== null &&
					(mergedAt === undefined || candidate.settledAt <= mergedAt)
				)
					return { reason: "settled" as const, at: candidate.settledAt };
				return mergedAt === undefined
					? undefined
					: { reason: "merged" as const, at: mergedAt };
			});

		/** Appends the eviction unless, under the write permit, the session may act again or unsettled. */
		const append = (candidate: Candidate, reason: "settled" | "merged") =>
			Effect.gen(function* () {
				let applied = false;
				yield* applySessionCommand(
					{
						type: "folder_timeline.evicted",
						data: { sessionId: candidate.id, reason },
					},
					{
						beforeWrite: Effect.gen(function* () {
							const [row] = yield* sql<{ settled_at: number | null }>`
								SELECT settled_at FROM sessions WHERE id = ${candidate.id}`;
							applied =
								row !== undefined &&
								(reason === "merged" || row.settled_at !== null) &&
								!(yield* mayAct(candidate.id));
							return applied;
						}),
					},
				).pipe(
					Effect.provideService(
						EventStoreEffectTag,
						bindEventStoreEffect(store, candidate.projectId),
					),
					Effect.provideService(LoggerTag, log),
					Effect.provide(context),
				);
				return applied;
			});

		// Sessions with a capture newer than their last eviction: what holds bytes.
		// Starting from the rare capture events keeps this off a per-session walk
		// of the events index, which costs hundreds of ms on a cold boot.
		const candidates = sql<{
			id: string;
			project_id: string;
			title: string | null;
			settled_at: number | null;
		}>`SELECT s.id, s.project_id, s.title, s.settled_at FROM sessions s
			WHERE s.id IN (SELECT session_id FROM events WHERE type = 'run.changes_captured')
				AND EXISTS (SELECT 1 FROM events c
				WHERE c.session_id = s.id AND c.type = 'run.changes_captured'
					AND c.sequence > COALESCE((SELECT MAX(e.sequence) FROM events e
						WHERE e.session_id = s.id AND e.type = 'folder_timeline.evicted'), 0))`.pipe(
			Effect.map((rows) =>
				rows.map(
					(row): Candidate => ({
						id: row.id,
						projectId: row.project_id,
						title: row.title ?? row.id,
						settledAt: row.settled_at,
					}),
				),
			),
		);

		const pass = Effect.gen(function* () {
			let total = yield* timeline.diskUse;
			const sized = yield* Effect.forEach(
				yield* candidates.pipe(Effect.orDie),
				(candidate) =>
					Effect.map(timeline.storeBytes(candidate.id), (bytes) => ({
						...candidate,
						bytes,
					})),
			);
			const evicted = new Set<string>();
			if (total > (yield* budget).budgetBytes) {
				const eligible = (yield* Effect.forEach(sized, (candidate) =>
					Effect.map(eligibility(candidate), (found) =>
						found === undefined ? [] : [{ ...candidate, ...found }],
					),
				))
					.flat()
					.sort((a, b) => a.at - b.at);
				for (const candidate of eligible) {
					// Re-read: a budget raised mid-pass ends it.
					if (total <= (yield* budget).budgetBytes * TARGET) break;
					if (
						yield* timeline.evict(
							candidate.id,
							append(candidate, candidate.reason),
						)
					) {
						evicted.add(candidate.id);
						total -= candidate.bytes;
						yield* Effect.logInfo("Evicted session captures", {
							sessionId: candidate.id,
							reason: candidate.reason,
							bytes: candidate.bytes,
						});
					}
				}
			}
			const over = total > (yield* budget).alertBytes;
			// One alert per stretch over the threshold, not one per pass.
			if (over && !(yield* Ref.getAndSet(alerting, true))) {
				const largest = sized
					.filter((candidate) => !evicted.has(candidate.id))
					.sort((a, b) => b.bytes - a.bytes)
					.slice(0, NAMED_IN_ALERT)
					.map(
						(candidate) =>
							`${candidate.title} (${readableSize(candidate.bytes)})`,
					);
				yield* publishAlert({
					_tag: "alert",
					kind: "warning",
					alertId: randomUUID(),
					message: `Turn diff snapshots use ${readableSize(total)}, over the ${readableSize((yield* budget).alertBytes)} alert, and nothing more can be evicted yet. Largest: ${largest.join(", ")}.`,
				}).pipe(Effect.provideService(AlertsTag, alerts));
			}
			if (!over) yield* Ref.set(alerting, false);
		});
		const runPass = passes
			.withPermits(1)(pass)
			.pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Snapshot eviction pass failed", { cause }),
				),
			);

		// Recovery: an eviction recorded before a crash finishes now. A capture
		// after the eviction made a new store, which stays.
		const unfinished = yield* sql<{ id: string }>`
			SELECT s.id FROM sessions s
			WHERE s.id IN (SELECT session_id FROM events WHERE type = 'folder_timeline.evicted')
				AND (SELECT MAX(e.sequence) FROM events e
				WHERE e.session_id = s.id AND e.type = 'folder_timeline.evicted')
				> COALESCE((SELECT MAX(c.sequence) FROM events c
					WHERE c.session_id = s.id AND c.type = 'run.changes_captured'), 0)`.pipe(
			Effect.orDie,
		);
		yield* Effect.forEach(
			unfinished,
			({ id }) =>
				Effect.gen(function* () {
					if ((yield* timeline.storeBytes(id)) === 0) return;
					yield* timeline.evict(id, Effect.succeed(true));
					yield* Effect.logInfo("Finished an interrupted eviction", {
						sessionId: id,
					});
				}),
			{ discard: true },
		);

		yield* runPass.pipe(
			Effect.repeat(Schedule.spaced(PASS_INTERVAL)),
			Effect.forkScoped,
		);
		return { pass: runPass };
	}),
);
