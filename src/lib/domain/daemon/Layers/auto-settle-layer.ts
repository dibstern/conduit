import { existsSync } from "node:fs";
import { Clock, Effect, Layer, Option, PubSub, Ref, Schedule } from "effect";
import {
	DEFAULT_AUTO_ARCHIVE_AFTER_DAYS,
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
} from "../../../daemon/config-persistence.js";
import * as Failure from "../../../effect/failure-classification.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import {
	hasColdAutoArchiveCandidate,
	hasColdAutoSettleCandidate,
} from "../Services/daemon-session-reader.js";
import { persistenceStoreContext } from "../Services/project-read-database.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { RelayCacheTag } from "../Services/relay-cache.js";

const MILLISECONDS_PER_DAY = 86_400_000;

export const AutoSettleLive = () =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const configRef = yield* DaemonConfigRefTag;
			const registry = yield* ProjectRegistryTag;
			const cache = yield* RelayCacheTag;
			const bus = yield* DaemonEventBusTag;
			const storeContext = yield* persistenceStoreContext;
			const missingDirectories = new Set<string>();

			const sweep = Effect.gen(function* () {
				const config = yield* Ref.get(configRef);
				const days = config.autoSettleAfterDays;
				const archiveDays = config.autoArchiveAfterDays;
				const idleWindowMs =
					(days ?? DEFAULT_AUTO_SETTLE_AFTER_DAYS) * MILLISECONDS_PER_DAY;
				const archiveWindowMs =
					(archiveDays ?? DEFAULT_AUTO_ARCHIVE_AFTER_DAYS) *
					MILLISECONDS_PER_DAY;
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
							// Stop any cached relay's pollers, even when settlement is disabled.
							yield* cache.invalidate(project.slug);
							return;
						}
						missingDirectories.delete(mainFolder);
						if (days === null && archiveDays === null) return;
						const running = yield* cache.peek(project.slug);
						const relay = Option.isSome(running)
							? running.value
							: (days !== null &&
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
										).pipe(Effect.provide(storeContext))))
								? yield* cache.get(project.slug)
								: null;
						if (relay === null) return;
						const settled =
							days === null || relay.settleIdleSessions === undefined
								? 0
								: yield* relay.settleIdleSessions(idleWindowMs, now);
						const archived =
							archiveDays === null || relay.archiveIdleSessions === undefined
								? 0
								: yield* relay.archiveIdleSessions(archiveWindowMs, now);
						const count = settled + archived;
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

			yield* sweep.pipe(
				Effect.repeat(Schedule.spaced("1 minute")),
				Effect.forkScoped,
			);
		}),
	);
