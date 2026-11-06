import { existsSync } from "node:fs";
import { Clock, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";
import {
	autoSettleIdleWindowMs,
	DEFAULT_AUTO_ARCHIVE_AFTER_DAYS,
	DEFAULT_AUTO_DELETE_ARCHIVED_AFTER_DAYS,
} from "../../../daemon/config-persistence.js";
import * as Failure from "../../../effect/failure-classification.js";
import { ENV } from "../../../env.js";
import { PortWatcher } from "../../persistence/Services/port-watcher.js";
import { SessionManagerServiceTag } from "../../relay/Services/session-manager-service.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import {
	hasColdAutoArchiveCandidate,
	hasColdAutoDeleteCandidate,
	hasColdAutoSettleCandidate,
} from "../Services/daemon-session-reader.js";
import { persistenceStoreContext } from "../Services/project-read-database.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { ProjectServices } from "../Services/project-services.js";

export const AutoSettleLive = () =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const configRef = yield* DaemonConfigRefTag;
			const registry = yield* ProjectRegistryTag;
			const projectServices = yield* ProjectServices;
			const managers = yield* SessionManagerServiceTag;
			const bus = yield* DaemonEventBusTag;
			const storeContext = yield* persistenceStoreContext;
			const watcher = yield* PortWatcher;
			const missingDirectories = new Set<string>();

			const sweep = Effect.gen(function* () {
				const config = yield* Ref.get(configRef);
				const archiveDays = config.autoArchiveAfterDays;
				const idleWindowMs = autoSettleIdleWindowMs(config.autoSettleAfterDays);
				const deleteDays = config.autoDeleteArchivedAfterDays;
				const deleteWindowMs =
					(deleteDays ?? DEFAULT_AUTO_DELETE_ARCHIVED_AFTER_DAYS) * 86_400_000;
				const archiveWindowMs =
					(archiveDays ?? DEFAULT_AUTO_ARCHIVE_AFTER_DAYS) * 86_400_000;
				const now = yield* Clock.currentTimeMillis;
				const projects = yield* allProjects.pipe(
					Effect.provideService(ProjectRegistryTag, registry),
				);
				for (const project of projects) {
					yield* Effect.gen(function* () {
						const mainFolder = project.folders[0];
						if (!existsSync(mainFolder)) {
							if (!missingDirectories.has(mainFolder)) {
								missingDirectories.add(mainFolder);
								yield* Effect.logDebug(
									"Skipping background work for missing project directory",
									{
										projectSlug: project.slug,
										mainFolder,
									},
								);
							}
							// End the project's start (its pollers), even when settlement is disabled.
							yield* projectServices.close(project.slug);
							return;
						}
						missingDirectories.delete(mainFolder);
						if (
							idleWindowMs === null &&
							archiveDays === null &&
							deleteDays === null
						)
							return;
						// An unopened project opens only when a persisted session is due.
						const due =
							Option.isSome(yield* projectServices.opened(project.slug)) ||
							(idleWindowMs !== null &&
								(yield* hasColdAutoSettleCandidate(
									project,
									now,
									idleWindowMs,
								).pipe(Effect.provide(storeContext)))) ||
							(archiveDays !== null &&
								(yield* hasColdAutoArchiveCandidate(
									project,
									now,
									archiveWindowMs,
								).pipe(Effect.provide(storeContext)))) ||
							(deleteDays !== null &&
								(yield* hasColdAutoDeleteCandidate(
									project,
									now,
									deleteWindowMs,
								).pipe(Effect.provide(storeContext))));
						if (!due) return;
						yield* projectServices.open(project.slug);
						const manager = managers.forProject(project.slug);
						// 8.7: until the first scan and one hold have passed, servers are unknown and
						// auto-settle waits.
						const settled =
							idleWindowMs === null || !watcher.known()
								? 0
								: yield* manager.settleIdleSessions(idleWindowMs, now);
						const archived =
							archiveDays === null
								? 0
								: yield* manager.archiveIdleSessions(archiveWindowMs, now);
						const deleted =
							deleteDays === null
								? 0
								: yield* manager.deleteArchivedSessions(deleteWindowMs, now);
						const count = settled + archived + deleted;
						if (count > 0)
							yield* PubSub.publish(bus, DaemonEvent.DaemonSessionsChanged());
					}).pipe(
						Effect.catchCause((cause) =>
							Failure.isInterruptedOnly(cause)
								? Effect.failCause(cause)
								: Effect.logWarning("automatic settlement failed for project", {
										projectSlug: project.slug,
										cause: Failure.renderCause(cause),
									}),
						),
					);
				}
			}).pipe(
				Effect.catchCause((cause) =>
					Failure.isInterruptedOnly(cause)
						? Effect.failCause(cause)
						: Effect.logWarning(
								"automatic settlement sweep failed",
								Failure.renderCause(cause),
							),
				),
			);

			yield* Stream.tick(ENV.autoSettleSweepIntervalMs).pipe(
				Stream.runForEach(() => sweep),
				Effect.forkScoped,
			);
		}),
	);
