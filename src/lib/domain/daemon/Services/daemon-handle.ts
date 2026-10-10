import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import { getAllIPs, getTailscaleIP } from "../../../cli/tls.js";
import type {
	ProjectSaveRejected,
	SaveProjectInput,
	WsRpcError,
} from "../../../contracts/ws-rpc.js";
import type { DaemonLifecycleContext } from "../../../daemon/daemon-lifecycle.js";
import type { DaemonStatus } from "../../../daemon/daemon-types.js";
import type { FolderIssue } from "../../../project-folders.js";
import type { ClaudeRuntimeError } from "../../../provider/event-sink-errors.js";
import type { OpenCodeInstance, StoredProject } from "../../../types.js";
import { ConfigPersistenceTag } from "./config-persistence-service.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { DaemonLifecycleContextTag } from "./daemon-lifecycle-context.js";
import { DaemonEventBusTag } from "./daemon-pubsub.js";
import { DaemonStateTag } from "./daemon-state.js";
import {
	getInstances as getEffectInstances,
	InstanceManagerStateTag,
} from "./instance-manager-service.js";
import {
	allProjects,
	getProject,
	type ProjectNotFound,
	ProjectRegistryTag,
	ProjectSaveLockTag,
	removeProjectFromEffectRegistry,
	saveProject as saveProjectToRegistry,
} from "./project-registry-service.js";
import { RelayCacheTag } from "./relay-cache.js";

export interface EffectDaemonHandle {
	readonly port: Effect.Effect<number>;
	readonly onboardingPort: Effect.Effect<number | null>;
	readonly saveProject: (input: SaveProjectInput) => Effect.Effect<
		{
			readonly kind?: "existing" | undefined;
			readonly project: StoredProject;
			readonly warnings: readonly FolderIssue[];
		},
		| ProjectSaveRejected
		| WsRpcError
		| ProjectNotFound
		| ClaudeRuntimeError
		| import("./project-registry-service.js").ProjectAlreadyExists
	>;
	readonly removeProject: (
		slug: string,
	) => Effect.Effect<void, ProjectNotFound | ClaudeRuntimeError | WsRpcError>;
	readonly getStatus: () => Effect.Effect<DaemonStatus>;
	readonly getProjects: () => Effect.Effect<ReadonlyArray<StoredProject>>;
	readonly getInstances: () => Effect.Effect<ReadonlyArray<OpenCodeInstance>>;
}

export class DaemonHandleTag extends Context.Tag("DaemonHandle")<
	DaemonHandleTag,
	EffectDaemonHandle
>() {}

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
	| ProjectSaveLockTag
	| DaemonEventBusTag
	| ConfigPersistenceTag
	| RelayCacheTag
	| DaemonLifecycleContextTag
	| InstanceManagerStateTag
	| DaemonStateTag
> = Layer.effect(
	DaemonHandleTag,
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const projectRef = yield* ProjectRegistryTag;
		const projectSaveLock = yield* ProjectSaveLockTag;
		const bus = yield* DaemonEventBusTag;
		const persistence = yield* ConfigPersistenceTag;
		const relayCache = yield* RelayCacheTag;
		const lifecycleContext = yield* DaemonLifecycleContextTag;
		const instanceState = yield* InstanceManagerStateTag;
		const daemonState = yield* DaemonStateTag;

		const port = Ref.get(configRef).pipe(Effect.map((config) => config.port));
		const onboardingPort = Effect.sync(() =>
			getOnboardingPort(lifecycleContext.onboardingServer),
		);
		const saveProject = (input: SaveProjectInput) =>
			Effect.gen(function* () {
				const instances = Array.from(
					yield* getEffectInstances.pipe(
						Effect.provideService(InstanceManagerStateTag, instanceState),
					),
				);
				const opencodeInstances = instances.filter(
					(instance) => (instance.driver ?? "opencode") === "opencode",
				);
				const resolvedInstanceId =
					input.instanceId ??
					opencodeInstances.find((instance) => instance.status === "healthy")
						?.id ??
					opencodeInstances[0]?.id;
				const result = yield* saveProjectToRegistry({
					...input,
					...(resolvedInstanceId !== undefined && {
						instanceId: resolvedInstanceId,
					}),
				}).pipe(
					Effect.provideService(ProjectRegistryTag, projectRef),
					Effect.provideService(DaemonEventBusTag, bus),
					Effect.provideService(ConfigPersistenceTag, persistence),
					Effect.provideService(DaemonStateTag, daemonState),
					Effect.provideService(RelayCacheTag, relayCache),
					Effect.provideService(ProjectSaveLockTag, projectSaveLock),
				);
				yield* persistence.requestSave;
				return result;
			}).pipe(Effect.withSpan("daemonHandle.saveProject"));

		const removeProject = (slug: string) =>
			Effect.gen(function* () {
				yield* getProject(slug).pipe(
					Effect.provideService(ProjectRegistryTag, projectRef),
				);
				yield* removeProjectFromEffectRegistry(slug).pipe(
					Effect.provideService(ProjectRegistryTag, projectRef),
					Effect.provideService(ProjectSaveLockTag, projectSaveLock),
					Effect.provideService(DaemonEventBusTag, bus),
					Effect.provideService(RelayCacheTag, relayCache),
					Effect.provideService(ConfigPersistenceTag, persistence),
					Effect.provideService(DaemonStateTag, daemonState),
				);
			}).pipe(Effect.withSpan("daemonHandle.removeProject"));

		const getProjects = () =>
			allProjects.pipe(
				Effect.provideService(ProjectRegistryTag, projectRef),
				Effect.withSpan("daemonHandle.getProjects"),
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
						folders: entry.project.folders,
						title: entry.project.title,
						status: entry._tag.toLowerCase(),
						...(entry.project.lastUsed !== undefined && {
							lastUsed: entry.project.lastUsed,
						}),
						...(relayStatus?.sse !== undefined && {
							sse: relayStatus.sse,
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
					...(config.tailscaleServe !== undefined && {
						tailscaleServe: config.tailscaleServe,
					}),
					keepAwake: config.keepAwake,
					projects: sortedStatusProjects(projects),
				} satisfies DaemonStatus;
			}).pipe(Effect.withSpan("daemonHandle.getStatus"));

		return {
			port,
			onboardingPort,
			saveProject,
			removeProject,
			getStatus,
			getProjects,
			getInstances,
		} satisfies EffectDaemonHandle;
	}),
);
