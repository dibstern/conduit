import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import { getAllIPs, getTailscaleIP } from "../../../cli/tls.js";
import { SCRATCH_PROJECT_SLUG } from "../../../contracts/scratch-project.js";
import {
	type ProjectSaveRejected,
	type SaveProjectInput,
	WsRpcError,
} from "../../../contracts/ws-rpc.js";
import type { DaemonLifecycleContext } from "../../../daemon/daemon-lifecycle.js";
import type { DaemonStatus } from "../../../daemon/daemon-types.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import type { FolderIssue } from "../../../project-folders.js";
import type { RunnerProcessError } from "../../../provider/runner/runner-retirement.js";
import type { OpenCodeInstance, StoredProject } from "../../../types.js";
import { RelayStatusSnapshotTag } from "../../project-services/Services/project-status-snapshot.js";
import { SSEStreamTag } from "../../project-services/Services/sse-stream-service.js";
import { KeepAwakeTag } from "../Layers/keep-awake-layer.js";
import { AccountDirectory } from "./account-directory.js";
import { ConfigPersistenceTag } from "./config-persistence-service.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { DaemonLifecycleContextTag } from "./daemon-lifecycle-context.js";
import { DaemonEventBusTag } from "./daemon-pubsub.js";
import { DaemonStateTag } from "./daemon-state.js";
import { DaemonStoreAvailability } from "./daemon-store-availability.js";
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
import { ProjectServices } from "./project-services.js";

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
		| RunnerProcessError
		| import("./project-registry-service.js").ProjectAlreadyExists
	>;
	readonly removeProject: (
		slug: string,
	) => Effect.Effect<void, ProjectNotFound | RunnerProcessError | WsRpcError>;
	readonly getStatus: () => Effect.Effect<DaemonStatus>;
	readonly getProjects: () => Effect.Effect<ReadonlyArray<StoredProject>>;
	readonly getInstances: () => Effect.Effect<ReadonlyArray<OpenCodeInstance>>;
}

export class DaemonHandleTag extends Context.Service<
	DaemonHandleTag,
	EffectDaemonHandle
>()("DaemonHandle") {}

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
	| ProjectServices
	| DaemonLifecycleContextTag
	| InstanceManagerStateTag
	| AccountDirectory
	| DaemonStateTag
	| KeepAwakeTag
	| PersistenceStore
> = Layer.effect(
	DaemonHandleTag,
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const projectRef = yield* ProjectRegistryTag;
		const projectSaveLock = yield* ProjectSaveLockTag;
		const bus = yield* DaemonEventBusTag;
		const persistence = yield* ConfigPersistenceTag;
		const projectServices = yield* ProjectServices;
		const lifecycleContext = yield* DaemonLifecycleContextTag;
		const instanceState = yield* InstanceManagerStateTag;
		const accounts = yield* AccountDirectory;
		const daemonState = yield* DaemonStateTag;
		const keepAwake = yield* KeepAwakeTag;
		const store = yield* PersistenceStore;
		const unavailable = yield* DaemonStoreAvailability;

		const port = Ref.get(configRef).pipe(Effect.map((config) => config.port));
		const onboardingPort = Effect.sync(() =>
			getOnboardingPort(lifecycleContext.onboardingServer),
		);
		// A new project stays unbound unless the caller picks an instance: the
		// binding chooses the harness for new sessions, so a default here would
		// override the default model's harness. The relay picks an OpenCode
		// instance on its own.
		const saveProject = (input: SaveProjectInput) =>
			Effect.gen(function* () {
				const result = yield* saveProjectToRegistry(input).pipe(
					Effect.provideService(PersistenceStore, store),
					Effect.provideService(DaemonStoreAvailability, unavailable),
					Effect.provideService(ProjectRegistryTag, projectRef),
					Effect.provideService(DaemonEventBusTag, bus),
					Effect.provideService(ConfigPersistenceTag, persistence),
					Effect.provideService(DaemonStateTag, daemonState),
					Effect.provideService(ProjectServices, projectServices),
					Effect.provideService(ProjectSaveLockTag, projectSaveLock),
				);
				yield* persistence.requestSave;
				yield* persistence.flush.pipe(
					Effect.mapError(
						(error) => new WsRpcError({ message: error.message }),
					),
				);
				return result;
			}).pipe(Effect.withSpan("daemonHandle.saveProject"));

		const removeProject = (slug: string) =>
			Effect.gen(function* () {
				yield* getProject(slug).pipe(
					Effect.provideService(ProjectRegistryTag, projectRef),
				);
				yield* removeProjectFromEffectRegistry(slug).pipe(
					Effect.provideService(PersistenceStore, store),
					Effect.provideService(DaemonStoreAvailability, unavailable),
					Effect.provideService(ProjectRegistryTag, projectRef),
					Effect.provideService(ProjectSaveLockTag, projectSaveLock),
					Effect.provideService(DaemonEventBusTag, bus),
					Effect.provideService(ProjectServices, projectServices),
					Effect.provideService(ConfigPersistenceTag, persistence),
					Effect.provideService(DaemonStateTag, daemonState),
				);
				yield* persistence.flush.pipe(
					Effect.mapError(
						(error) => new WsRpcError({ message: error.message }),
					),
				);
			}).pipe(Effect.withSpan("daemonHandle.removeProject"));

		const getProjects = () =>
			allProjects.pipe(
				Effect.map((projects) =>
					projects.filter(({ slug }) => slug !== SCRATCH_PROJECT_SLUG),
				),
				Effect.provideService(ProjectRegistryTag, projectRef),
				Effect.withSpan("daemonHandle.getProjects"),
			);

		const getInstances = () =>
			getEffectInstances.pipe(
				Effect.provideService(InstanceManagerStateTag, instanceState),
				Effect.provideService(AccountDirectory, accounts),
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
					if (slug === SCRATCH_PROJECT_SLUG) continue;
					// An unopened project reads its persisted count and stays closed.
					const opened = Option.getOrUndefined(
						yield* projectServices.opened(slug),
					);
					sessionCount +=
						(opened &&
							Context.get(opened, RelayStatusSnapshotTag).getSnapshot()
								.sessionCount) ??
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
						...(opened && {
							sse: Context.get(opened, SSEStreamTag).getHealth(),
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
					projectCount: projects.length,
					sessionCount,
					clientCount: lifecycleContext.clientCount,
					pinEnabled: config.pinHash !== null,
					tlsEnabled: config.tlsEnabled,
					...(config.tailscaleServe !== undefined && {
						tailscaleServe: config.tailscaleServe,
					}),
					keepAwake: config.keepAwake,
					keepAwakeCommand: yield* keepAwake.getCommand(),
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
