import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	Cause,
	Clock,
	Deferred,
	Effect,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
	Schedule,
} from "effect";
import {
	DEFAULT_WORKTREE_CLEANUP,
	type WorktreeCleanupEntry,
	type WorktreeCleanupReport,
} from "../../../contracts/worktree.js";
import { realWorkspacePath } from "../../../git/worktrees.js";
import { cleanUpProjectWorktrees } from "../../../session/worktree-cleanup-sweep.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { persistenceStoreContext } from "../Services/project-read-database.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { RelayCacheTag } from "../Services/relay-cache.js";
import {
	isWorktreeCleanupEnabled,
	readColdWorktreeCleanupCandidates,
} from "../Services/worktree-cleanup-reader.js";
import { WorktreeCleanupQueueTag } from "../Services/worktree-cleanup-service.js";

export const WorktreeCleanupLive = () =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			const configRef = yield* DaemonConfigRefTag;
			const registry = yield* ProjectRegistryTag;
			const cache = yield* RelayCacheTag;
			const bus = yield* DaemonEventBusTag;
			const storeContext = yield* persistenceStoreContext;
			const requests = yield* WorktreeCleanupQueueTag;
			const getSetting = Ref.get(configRef).pipe(
				Effect.map(
					(config) => config.worktreeCleanup ?? DEFAULT_WORKTREE_CLEANUP,
				),
			);
			const getProjectFolders = allProjects.pipe(
				Effect.provideService(ProjectRegistryTag, registry),
				Effect.flatMap((projects) =>
					Effect.forEach(
						projects.flatMap((project) => project.folders),
						(folder) =>
							realWorkspacePath(folder).pipe(
								Effect.orElseSucceed(() => resolve(folder)),
							),
					),
				),
			);

			const sweep = (slugs: Set<string> | undefined) =>
				Effect.gen(function* () {
					const report: {
						removed: WorktreeCleanupEntry[];
						kept: WorktreeCleanupEntry[];
						failed: WorktreeCleanupEntry[];
					} = {
						removed: [],
						kept: [],
						failed: [],
					};
					if (!isWorktreeCleanupEnabled(yield* getSetting)) return report;
					const projects = (yield* allProjects.pipe(
						Effect.provideService(ProjectRegistryTag, registry),
					)).filter(
						(project) => slugs === undefined || slugs.has(project.slug),
					);
					const now = yield* Clock.currentTimeMillis;
					for (const project of projects) {
						yield* Effect.gen(function* () {
							let relay = Option.getOrUndefined(
								yield* cache.peek(project.slug),
							);
							if (relay === undefined) {
								const paths = yield* readColdWorktreeCleanupCandidates(
									project,
									yield* getSetting,
									now,
								).pipe(Effect.provide(storeContext));
								if (paths.length === 0) return;
								if (!existsSync(project.folders[0])) {
									for (const item of paths)
										report.kept.push({
											projectSlug: project.slug,
											sessionId: item.session_id,
											path: item.path,
											reason: "Project directory is missing",
										});
									return;
								}
								relay = yield* cache.get(project.slug);
							}
							const context = relay.rpcWsHandler.context;
							if (context === undefined)
								return yield* Effect.fail(
									new Error("Project relay context is unavailable"),
								);
							const projectReport = yield* cleanUpProjectWorktrees(
								getSetting,
								getProjectFolders,
								now,
							).pipe(Effect.provide(yield* context));
							report.removed.push(...projectReport.removed);
							report.kept.push(...projectReport.kept);
							report.failed.push(...projectReport.failed);
							if (projectReport.removed.length > 0)
								yield* PubSub.publish(bus, DaemonEvent.DaemonSessionsChanged());
						}).pipe(
							Effect.catchAllCause((cause) => {
								if (Cause.isInterruptedOnly(cause))
									return Effect.failCause(cause);
								report.failed.push({
									projectSlug: project.slug,
									sessionId: "",
									path: project.folders[0],
									reason: "Could not clean up project worktrees",
								});
								return Effect.logWarning(
									"worktree cleanup failed for project",
									{ projectSlug: project.slug, cause: Cause.pretty(cause) },
								);
							}),
						);
					}
					if (slugs)
						for (const slug of slugs)
							if (!projects.some((project) => project.slug === slug))
								report.failed.push({
									projectSlug: slug,
									sessionId: "",
									path: "",
									reason: "Project is not registered",
								});
					return report satisfies WorktreeCleanupReport;
				});

			// One worker owns all removals; requests arriving during a run form the next batch.
			yield* Effect.gen(function* () {
				const first = yield* Queue.take(requests);
				const batch = [first, ...(yield* Queue.takeAll(requests))];
				const slugs = batch.some(({ projectSlug }) => projectSlug === undefined)
					? undefined
					: new Set(
							batch.flatMap(({ projectSlug }) =>
								projectSlug === undefined ? [] : [projectSlug],
							),
						);
				const report = yield* sweep(slugs).pipe(
					Effect.catchAllCause((cause) =>
						Cause.isInterruptedOnly(cause)
							? Effect.failCause(cause)
							: Effect.logWarning(
									"worktree cleanup sweep failed",
									Cause.pretty(cause),
								).pipe(
									Effect.as({
										removed: [],
										kept: [],
										failed: [
											{
												projectSlug: "",
												sessionId: "",
												path: "",
												reason: "Worktree cleanup sweep failed",
											},
										],
									} satisfies WorktreeCleanupReport),
								),
					),
				);
				for (const request of batch) {
					if (!request.completion) continue;
					const matches = (entry: WorktreeCleanupEntry) =>
						request.projectSlug === undefined ||
						entry.projectSlug === request.projectSlug ||
						entry.projectSlug === "";
					yield* Deferred.succeed(request.completion, {
						removed: report.removed.filter(matches),
						kept: report.kept.filter(matches),
						failed: report.failed.filter(matches),
					});
				}
			}).pipe(Effect.forever, Effect.forkScoped);

			yield* Queue.offer(requests, {}).pipe(
				Effect.repeat(Schedule.spaced("1 hour")),
				Effect.forkScoped,
			);
		}),
	);
