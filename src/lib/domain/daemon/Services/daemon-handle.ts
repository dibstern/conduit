import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { Context, Effect, HashMap, Layer, PubSub, Ref } from "effect";
import type { DaemonStatus } from "../../../daemon/daemon-types.js";
import type { StoredProject } from "../../../types.js";
import { generateSlug } from "../../../utils.js";
import { ConfigPersistenceTag } from "./config-persistence-service.js";
import {
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "./daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";
import {
	type ProjectRegistryState,
	ProjectRegistryTag,
} from "./project-registry-service.js";
import { RelayCacheTag } from "./relay-cache.js";

export interface EffectDaemonHandle {
	readonly port: Effect.Effect<number>;
	readonly addProject: (dir: string) => Effect.Effect<StoredProject>;
	readonly removeProject: (slug: string) => Effect.Effect<void>;
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

		const addProject = (directory: string) =>
			Effect.gen(function* () {
				const normalizedDirectory = normalizeProjectDirectory(directory);
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
				const removed = yield* Ref.modify(projectRef, (state) => {
					if (!HashMap.has(state, slug)) return [false, state] as const;
					return [true, HashMap.remove(state, slug)] as const;
				});
				if (!removed) return;

				yield* relayCache.invalidate(slug);
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
