import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import { getAllIPs, getTailscaleIP } from "../../../cli/tls.js";
import type { DaemonLifecycleContext } from "../../../daemon/daemon-lifecycle.js";
import type { DaemonStatus } from "../../../daemon/daemon-types.js";
import type { OpenCodeInstance, StoredProject } from "../../../types.js";
import { generateSlug } from "../../../utils.js";
import { ConfigPersistenceTag } from "./config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "./daemon-config-ref.js";
import { DaemonLifecycleContextTag } from "./daemon-lifecycle-context.js";
import { DaemonEventBusTag } from "./daemon-pubsub.js";
import {
	getInstances as getEffectInstances,
	InstanceManagerStateTag,
} from "./instance-manager-service.js";
import { discoverProjectsEffect } from "./project-discovery-service.js";
import {
	addWithoutRelay,
	allProjects,
	findByDirectory,
	getProject,
	type ProjectAlreadyExists,
	type ProjectNotFound,
	ProjectRegistryTag,
	remove as removeProjectFromRegistry,
} from "./project-registry-service.js";
import { RelayCacheTag } from "./relay-cache.js";

export interface EffectDaemonHandle {
	readonly port: Effect.Effect<number>;
	readonly onboardingPort: Effect.Effect<number | null>;
	readonly addProject: (
		dir: string,
		slug?: string,
		instanceId?: string,
	) => Effect.Effect<StoredProject, ProjectAlreadyExists>;
	readonly discoverProjects: () => Effect.Effect<number>;
	readonly removeProject: (
		slug: string,
	) => Effect.Effect<void, ProjectNotFound>;
	readonly getStatus: () => Effect.Effect<DaemonStatus>;
	readonly getProjects: () => Effect.Effect<ReadonlyArray<StoredProject>>;
	readonly getInstances: () => Effect.Effect<ReadonlyArray<OpenCodeInstance>>;
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

const sortedStatusProjects = (
	projects: DaemonStatus["projects"],
): DaemonStatus["projects"] =>
	projects.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));

const getOnboardingPort = (
	server: DaemonLifecycleContext["onboardingServer"],
): number | null => {
	if (server == null) return null;
	const addr = server.address();
	return typeof addr === "object" && addr != null ? addr.port : null;
};

export const DaemonHandleLive: Layer.Layer<
	DaemonHandleTag,
	never,
	| DaemonConfigRefTag
	| ProjectRegistryTag
	| DaemonEventBusTag
	| ConfigPersistenceTag
	| RelayCacheTag
	| DaemonLifecycleContextTag
	| InstanceManagerStateTag
> = Layer.effect(
	DaemonHandleTag,
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const projectRef = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;
		const persistence = yield* ConfigPersistenceTag;
		const relayCache = yield* RelayCacheTag;
		const lifecycleContext = yield* DaemonLifecycleContextTag;
		const instanceState = yield* InstanceManagerStateTag;

		const port = Ref.get(configRef).pipe(Effect.map((config) => config.port));
		const onboardingPort = Effect.sync(() =>
			getOnboardingPort(lifecycleContext.onboardingServer),
		);
		const commitConfig = (
			update: (config: DaemonRuntimeConfig) => DaemonRuntimeConfig,
		) =>
			commitDaemonRuntimeConfig(update).pipe(
				Effect.provideService(DaemonConfigRefTag, configRef),
			);

		const addProject = (
			directory: string,
			slug?: string,
			instanceId?: string,
		) =>
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

				const existing = yield* findByDirectory(normalizedDirectory).pipe(
					Effect.provideService(ProjectRegistryTag, projectRef),
				);
				if (Option.isSome(existing)) {
					yield* persistence.requestSave;
					return existing.value.project;
				}

				const state = yield* Ref.get(projectRef);
				const existingSlugs = new Set(HashMap.keys(state));
				const instances = Array.from(
					yield* getEffectInstances.pipe(
						Effect.provideService(InstanceManagerStateTag, instanceState),
					),
				);
				const resolvedInstanceId =
					instanceId ??
					instances.find((instance) => instance.status === "healthy")?.id ??
					instances[0]?.id;
				const project: StoredProject = {
					slug: slug ?? generateSlug(normalizedDirectory, existingSlugs),
					directory: normalizedDirectory,
					title: titleForDirectory(normalizedDirectory),
					lastUsed: Date.now(),
					...(resolvedInstanceId !== undefined && {
						instanceId: resolvedInstanceId,
					}),
				};
				yield* addWithoutRelay(project).pipe(
					Effect.provideService(ProjectRegistryTag, projectRef),
					Effect.provideService(DaemonEventBusTag, bus),
					Effect.provideService(ConfigPersistenceTag, persistence),
				);
				yield* persistence.requestSave;
				return project;
			}).pipe(Effect.withSpan("daemonHandle.addProject"));

		const removeProject = (slug: string) =>
			Effect.gen(function* () {
				const removedProject = yield* getProject(slug).pipe(
					Effect.provideService(ProjectRegistryTag, projectRef),
				);
				yield* removeProjectFromRegistry(slug).pipe(
					Effect.provideService(ProjectRegistryTag, projectRef),
					Effect.provideService(DaemonEventBusTag, bus),
					Effect.provideService(RelayCacheTag, relayCache),
					Effect.provideService(ConfigPersistenceTag, persistence),
				);
				yield* commitConfig((config) => ({
					...config,
					dismissedPaths: new Set([
						...config.dismissedPaths,
						removedProject.directory,
					]),
				}));
				yield* persistence.requestSave;
			}).pipe(Effect.withSpan("daemonHandle.removeProject"));

		const getProjects = () =>
			allProjects.pipe(
				Effect.provideService(ProjectRegistryTag, projectRef),
				Effect.withSpan("daemonHandle.getProjects"),
			);

		const discoverProjects = () =>
			discoverProjectsEffect.pipe(
				Effect.provideService(DaemonConfigRefTag, configRef),
				Effect.provideService(DaemonEventBusTag, bus),
				Effect.provideService(ConfigPersistenceTag, persistence),
				Effect.provideService(InstanceManagerStateTag, instanceState),
				Effect.provideService(ProjectRegistryTag, projectRef),
				Effect.withSpan("daemonHandle.discoverProjects"),
			);

		const getInstances = () =>
			getEffectInstances.pipe(
				Effect.provideService(InstanceManagerStateTag, instanceState),
				Effect.map((instances) => Array.from(instances)),
				Effect.withSpan("daemonHandle.getInstances"),
			);

		const getStatus = () =>
			Effect.gen(function* () {
				const config = yield* Ref.get(configRef);
				const state = yield* Ref.get(projectRef);
				const tsIP = getTailscaleIP();
				const lanIP = getAllIPs().find((ip) => !ip.startsWith("100.")) ?? null;
				let sessionCount = 0;
				const projects: DaemonStatus["projects"] = [];

				for (const [slug, entry] of HashMap.entries(state)) {
					const relay = yield* relayCache.peek(slug);
					const relayStatus = Option.isSome(relay)
						? relay.value.getStatusSnapshot?.()
						: undefined;
					sessionCount +=
						relayStatus?.sessionCount ??
						config.persistedSessionCounts.get(slug) ??
						0;
					projects.push({
						slug,
						directory: entry.project.directory,
						title: entry.project.title,
						status: entry._tag.toLowerCase(),
						...(entry.project.lastUsed !== undefined && {
							lastUsed: entry.project.lastUsed,
						}),
					});
				}

				return {
					ok: true,
					uptime: (Date.now() - config.startTime) / 1000,
					port: config.port,
					host: config.host,
					...(tsIP !== null && { tailscaleIP: tsIP }),
					...(lanIP !== null && { lanIP }),
					projectCount: HashMap.size(state),
					sessionCount,
					clientCount: lifecycleContext.clientCount,
					pinEnabled: config.pinHash !== null,
					tlsEnabled: config.tlsEnabled,
					keepAwake: config.keepAwake,
					projects: sortedStatusProjects(projects),
				} satisfies DaemonStatus;
			}).pipe(Effect.withSpan("daemonHandle.getStatus"));

		return {
			port,
			onboardingPort,
			addProject,
			discoverProjects,
			removeProject,
			getStatus,
			getProjects,
			getInstances,
		} satisfies EffectDaemonHandle;
	}),
);
