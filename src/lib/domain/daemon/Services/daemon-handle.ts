import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { Context, Effect, HashMap, Layer, Option, PubSub, Ref } from "effect";
import type { DaemonStatus } from "../../../daemon/daemon-types.js";
import type { StoredProject } from "../../../types.js";
import { generateSlug } from "../../../utils.js";
import { ConfigPersistenceTag } from "./config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "./daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";
import {
	ProjectNotFound,
	type ProjectRegistryState,
	ProjectRegistryTag,
} from "./project-registry-service.js";
import { RelayCacheTag } from "./relay-cache.js";

export interface EffectDaemonHandle {
	readonly port: Effect.Effect<number>;
	readonly addProject: (dir: string) => Effect.Effect<StoredProject>;
	readonly removeProject: (
		slug: string,
	) => Effect.Effect<void, ProjectNotFound>;
	readonly getStatus: () => Effect.Effect<DaemonStatus>;
	readonly getProjects: () => Effect.Effect<ReadonlyArray<StoredProject>>;
}

export class DaemonHandleTag extends Context.Tag("DaemonHandle")<
	DaemonHandleTag,
	EffectDaemonHandle
>() {}

const normalizeProjectDirectory = (directory: string): string => {
	const expanded =
		directory === "~" || directory.startsWith("~/")
			? directory.replace(/^~/, homedir())
			: directory;
	return resolve(expanded);
};

const titleForDirectory = (directory: string): string =>
	basename(directory) || "project";

const sortedProjects = (state: ProjectRegistryState): StoredProject[] =>
	Array.from(HashMap.values(state))
		.map((entry) => entry.project)
		.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));

const statusProjects = (
	state: ProjectRegistryState,
): DaemonStatus["projects"] =>
	Array.from(HashMap.entries(state))
		.map(([slug, entry]) => ({
			slug,
			directory: entry.project.directory,
			title: entry.project.title,
			status: entry._tag.toLowerCase(),
			...(entry.project.lastUsed !== undefined && {
				lastUsed: entry.project.lastUsed,
			}),
		}))
		.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));

const sessionCountFromConfig = (config: DaemonRuntimeConfig): number => {
	let total = 0;
	for (const count of config.persistedSessionCounts.values()) {
		total += count;
	}
	return total;
};

export const DaemonHandleLive: Layer.Layer<
	DaemonHandleTag,
	never,
	| DaemonConfigRefTag
	| ProjectRegistryTag
	| DaemonEventBusTag
	| ConfigPersistenceTag
	| RelayCacheTag
> = Layer.effect(
	DaemonHandleTag,
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const projectRef = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;
		const persistence = yield* ConfigPersistenceTag;
		const relayCache = yield* RelayCacheTag;

		const port = Ref.get(configRef).pipe(Effect.map((config) => config.port));
		const commitConfig = (
			update: (config: DaemonRuntimeConfig) => DaemonRuntimeConfig,
		) =>
			commitDaemonRuntimeConfig(update).pipe(
				Effect.provideService(DaemonConfigRefTag, configRef),
			);

		const addProject = (directory: string) =>
			Effect.gen(function* () {
				const normalizedDirectory = normalizeProjectDirectory(directory);
				yield* commitConfig((config) => {
					if (!config.dismissedPaths.has(normalizedDirectory)) return config;
					const dismissedPaths = new Set(config.dismissedPaths);
					dismissedPaths.delete(normalizedDirectory);
					return {
						...config,
						dismissedPaths,
					};
				});
				const project = yield* Ref.modify(projectRef, (state) => {
					const existing = Array.from(HashMap.values(state)).find(
						(entry) => entry.project.directory === normalizedDirectory,
					);
					if (existing) return [existing.project, state] as const;

					const existingSlugs = new Set(HashMap.keys(state));
					const slug = generateSlug(normalizedDirectory, existingSlugs);
					const nextProject: StoredProject = {
						slug,
						directory: normalizedDirectory,
						title: titleForDirectory(normalizedDirectory),
						lastUsed: Date.now(),
					};
					return [
						nextProject,
						HashMap.set(state, slug, {
							_tag: "Registering" as const,
							project: nextProject,
						}),
					] as const;
				});

				yield* PubSub.publish(
					bus,
					DaemonEvent.InstanceAdded({ instanceId: project.slug }),
				);
				yield* persistence.requestSave;
				return project;
			}).pipe(Effect.withSpan("daemonHandle.addProject"));

		const removeProject = (slug: string) =>
			Effect.gen(function* () {
				const removedProject = yield* Ref.modify(projectRef, (state) => {
					const entry = HashMap.get(state, slug);
					if (Option.isNone(entry)) {
						return [Option.none<StoredProject>(), state] as const;
					}
					return [
						Option.some(entry.value.project),
						HashMap.remove(state, slug),
					] as const;
				});
				if (Option.isNone(removedProject)) {
					return yield* new ProjectNotFound({ slug });
				}

				yield* relayCache.invalidate(slug);
				yield* commitConfig((config) => ({
					...config,
					dismissedPaths: new Set([
						...config.dismissedPaths,
						removedProject.value.directory,
					]),
				}));
				yield* PubSub.publish(
					bus,
					DaemonEvent.InstanceRemoved({ instanceId: slug }),
				);
				yield* persistence.requestSave;
			}).pipe(Effect.withSpan("daemonHandle.removeProject"));

		const getProjects = () =>
			Ref.get(projectRef).pipe(
				Effect.map(sortedProjects),
				Effect.withSpan("daemonHandle.getProjects"),
			);

		const getStatus = () =>
			Effect.gen(function* () {
				const config = yield* Ref.get(configRef);
				const state = yield* Ref.get(projectRef);
				const projects = statusProjects(state);
				return {
					ok: true,
					uptime: (Date.now() - config.startTime) / 1000,
					port: config.port,
					host: config.host,
					projectCount: HashMap.size(state),
					sessionCount: sessionCountFromConfig(config),
					clientCount: 0,
					pinEnabled: config.pinHash !== null,
					tlsEnabled: config.tlsEnabled,
					keepAwake: config.keepAwake,
					projects,
				} satisfies DaemonStatus;
			}).pipe(Effect.withSpan("daemonHandle.getStatus"));

		return {
			port,
			addProject,
			removeProject,
			getStatus,
			getProjects,
		} satisfies EffectDaemonHandle;
	}),
);
